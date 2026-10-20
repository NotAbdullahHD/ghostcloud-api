// ── GhostCloud API — Cloudflare Workers port ────────────────────────────────
//
// Same HTTP contract as the Node/Render version, so the website needs no code
// changes beyond the API base URL. Everything lives in ONE Durable Object
// ("Hub"), which plays the role the Node process used to play: it owns the
// account pool, sessions, presence and the WebSocket relays, and its alarms
// replace setTimeout/setInterval.
//
// Why this beats Render's free tier for this app:
//   - no instance hours (no 750/month cap, no spin-down, no keep-alive pings)
//   - no outbound-bandwidth billing (Cloudflare doesn't charge egress)
//   - no "service-initiated traffic" suspension rule
// What it does have: 100,000 requests/day on the free plan (Workers AND Durable
// Objects each count one request per HTTP call), which is why the website's
// polling intervals were lengthened in this version.
//
// Port notes (differences from the Node version, all deliberate):
//   - No raw DNS: the Node version pinned a resolved Raccoon IP, Workers can't
//     do DNS lookups, so requests go straight to the hostname.
//   - crypto: Node's createDecipheriv → WebCrypto AES-CBC (same key/IV/padding).
//   - setInterval/setTimeout → one alarm-driven tick loop.
//   - process.env → env (vars/secrets from wrangler.toml).

import SITES from "./sites.js";

const RACCOON_HOST = "www.raccoongame.com";
const RACCOON_TIMEOUT_MS = 20000;
// How long a mail domain that passed the screen is trusted for. Raccoon
// blocklists new disposable domains over time, so "passed once" is not forever —
// but re-asking for every mailbox would spend a registration attempt per player
// on a question whose answer changes weekly. A domain that is refused later is
// caught by the sendEmail/register paths, which mark it blocked immediately.
const MAIL_DOMAIN_SCREEN_TTL_MS = 6 * 60 * 60 * 1000;
// Bumped whenever the HTTP contract changes shape, and reported by
// /cloud/v1/capabilities. The site asks for it on the account screen: a stale
// deploy used to be indistinguishable from a code bug, which is exactly how
// "I updated the API but nothing changed" happens. The website checks this
// string and says so out loud instead of pretending.
// 2.4.0 — reads Raccoon's post-2026-10-14 register gate correctly: register no
// longer asks for the puzzle at all, only the *code*, so a bad code is retried
// with a fresh one instead of being mistaken for the bot wall (which paused
// every registration for ten minutes) or for a stale human check.
// 2.3.0 — carries Raccoon's puzzle session cookie (challenge → verify →
// sendEmail → register → login). Before this, every solve answered "The puzzle
// has expired" and no account could be created at all, so the account screen
// printing 2.3.0 is how you confirm the fix is the build actually being served.
// 2.5.1 — a pooled account is checked before it reaches a player, and an
// account Raccoon refuses at launch is swapped for another one instead of
// showing the player an error (see poolAccountUsable / doInitGame). /healthz now
// answers readiness too, so a dead pool is visible from outside the app.
// 2.6.0 — the human check is budgeted instead of spent. Raccoon rate-limits
// `emailRegisterCaptcha` per *egress IP*, and every player's challenge is
// fetched by this Worker, so they all draw on one budget: five asks in an hour
// and the answer is "Too many puzzle attempts. Please try again in 3543
// seconds." for everybody. The relay now reuses a live challenge for the same
// address, never asks twice for one answer (single-flight), keeps the puzzle
// session in storage so a Durable Object eviction cannot fake an expiry, and
// says *which* kind of refusal came back so the site stops answering a wrong
// drag with a fresh challenge.
// 2.7.0 — the human check is budgeted by *us*, not by Raccoon, and the automatic
// account path no longer asks a player to solve one at all. Raccoon limits
// `emailRegisterCaptcha` per egress IP and every player's challenge comes from
// this Worker's IP, so an exhausted budget is a site-wide outage (measured:
// five asks, then "Too many puzzle attempts. Please try again in 3543
// seconds.", and the cooldown grows with every further ask).
const API_VERSION = "2.7.0";
// Capabilities the site probes for. Anything missing means the running Worker is
// an older build than the site expects.
const API_CAPABILITIES = { puzzle: true, puzzleResilience: true, puzzleBudget: true, autoCapacity: true, manualRegister: true, seedPool: true, verificationEvents: true, codeRefusals: true, mailDomainScreen: true, poolValidation: true, readinessHealth: true };
// How many *new* challenges this Worker will ask Raccoon for in a window. Kept
// well below the observed limit on purpose: a refusal locks the check out for
// everyone for an hour, and a challenge reused or remembered costs nothing.
// Six per fifteen minutes is more than the site needs (the pool serves play;
// the slider is only for the Settings account flow), and it cannot run the
// shared budget dry.
const PUZZLE_ISSUE_MAX = 6;
const PUZZLE_ISSUE_WINDOW_MS = 15 * 60 * 1000;
// A Raccoon lockout is reported in seconds and can be an hour. Cap what we
// believe so a nonsense number cannot park the check forever.
const PUZZLE_BLOCK_MAX_MS = 60 * 60 * 1000;
// A challenge is reusable for this long. Raccoon keeps it in its own session and
// a human needs only a few seconds, so a player re-opening the check (a double
// tap, a tab switch, a retry after a wrong drag) must get the challenge that is
// already on their screen instead of spending another one from the shared IP
// budget. Deliberately short: past this the player has had plenty of time, and a
// stale image would fail in a way that looks like a wrong answer.
const PUZZLE_REUSE_MS = 5 * 60 * 1000;
// A passed challenge is remembered this long so sendEmail/emailRegister retries
// (a refused mailbox, a dropped connection, a code request the player repeats)
// do not send the human back to the slider. Raccoon binds the verification to
// `sn`; this is the same window its own session lives for.
const PUZZLE_VERIFIED_TTL_MS = 30 * 60 * 1000;
// Raccoon's registration endpoints sit behind nginx and answer a bare fetch UA
// with the same puzzle refusal they answer a browser with, so this is not a
// disguise — it is just the UA the mobile client and the site both send.
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";
const MAX_SESSION_SECONDS = 19 * 60;
const DEFAULT_SESSION_SECONDS = 19 * 60;
const WS_OPEN = 1;

// How often the maintenance tick runs while there is work (live sessions or a
// non-empty waiting line). Every alarm invocation is a billed Durable Object
// request, and 3s ticks alone were ~29k/day against the free plan's 100k/day —
// nothing in tick() needs better than ~30s granularity anyway (Raccoon
// keep-alive ping 30s, cost tick 25s, ping deadline 120s), so 10s is ample.
const TICK_MS = 10000;                   // maintenance tick while work exists
const COST_INTERVAL_MS = 25000;
const POOL_FILL_INTERVAL_MS = 20000;
// The pool-fill path must never busy-loop. `nextPoolFillAt` can legitimately be
// in the past — a slow fill outlives its own interval, and a fill already in
// flight blocks the next one — so the old `Math.max(1000, …)` below re-armed
// the alarm once a second. That is up to ~86k billed DO requests a day on an
// idle hub, against a 100k/day budget. This floor is the fix.
const POOL_FILL_MIN_DELAY_MS = 20000;
const POOL_FILL_STARTUP_GRACE_MS = 3000;
// Ceiling on the pool-fill backoff. It used to climb to 5 minutes, which meant
// the pool gave up refilling at exactly the moment it was needed most: the
// busiest hour is when fills fail, the backoff then parks the pool for five
// minutes, every player past the last pooled account falls through to a live
// registration, and those registrations are what the mail providers rate-limit.
// A minute is long enough to stop a broken lane from spinning.
const POOL_FILL_MAX_BACKOFF_MS = 60000;
// A pooled account is checked against Raccoon before it is handed to a player.
// One checkCost call is cheap next to a full registration, but it is still a
// request per launch, so a pass is remembered for this long: a ban can land at
// any moment, and a ten-minute-old "this token works" is a much better bet than
// "it worked some time last week".
const POOL_CHECK_TTL_MS = 10 * 60 * 1000;
// How many pooled accounts one launch may check before it gives up and
// registers. A pool where everything is dead must not turn into a minute of
// silence on a player's screen; the fill loop then rebuilds it in the
// background.
const POOL_CHECK_MAX = 8;
// Raccoon's wording when the *account* is refused, as opposed to the game
// ("This game needs diamonds" is status 3004 and is not a dead account). Kept
// deliberately narrow: a false positive retires a working account, which costs
// a registration, so an unrecognised answer keeps the account.
const ACCOUNT_REFUSAL_RE = /not log(ged)? ?in|please log ?in|log in again|login (has )?expired|token (is )?(invalid|expired)|invalid token|unauthori[sz]ed|account (is )?(banned|disabled|blocked)|user (does not|doesn't) exist|不存在|失效|登录/i;
// How many account registrations may be in flight at once, across every site.
// Free temp-mail providers rate-limit per provider, not per site, so this is a
// process-wide cap. The old value was `max_concurrent_sessions * 2` = 30, i.e.
// up to 30 simultaneous registrations against api.tempmail.lol / mail.gw the
// moment the pool ran dry — a guaranteed HTTP 429 storm and the exact error
// players were seeing. Registrations are slow (30-60s each), so the players
// beyond this limit now wait in the visible line instead of failing.
const ACCOUNT_CREATE_MAX = 2;
// How long a player may wait for one of those registration slots before we give
// up. The client drops a setup stream that goes quiet for 90s, so the wait loop
// below emits a progress event well inside that window.
const ACCOUNT_SLOT_WAIT_MS = 150000;
// Session endings that mean the *account* is finished too, so it must not go back
// into the pool. "upstream_terminated" is Raccoon's own status 3013 (it killed
// the account); "creation_error" never produced a working one.
const ACCOUNT_DEAD_REASONS = new Set(["upstream_terminated", "creation_error", "account_unusable"]);
const DASHBOARD_INTERVAL_MS = 5 * 60 * 1000;
// Presence TTL is deliberately generous (5 min) because the site now only
// heartbeats every 2 min and skips hidden tabs — Cloudflare's free plan allows
// 100k requests/day for the whole account, and 30s polling used to blow it.
const PRESENCE_TTL_MS = 300 * 1000;
const QUEUE_BROADCAST_MS = 4000;
const QUEUED_MAX_AGE = 30 * 60 * 1000;
const QUEUED_POLL_STALE_AFTER = 90000;
const SETUP_DEADLINE_MS = 5 * 60 * 1000;
const STARTGAME_DEADLINE_MS = 30000;
const QUEUE_ABANDON_MS = 60000;
// The site pings every 45s; allow two missed pings before dropping a session so
// one dropped request can't kill a game in progress.
const PING_TIMEOUT_MS = 120000;
// How long a live session survives without its signaling socket. That socket
// only relays offers and ICE candidates — the video goes from the game server to
// the player's browser directly — so a network blip must not cost somebody the
// slot they queued for. Hold the session and let the client reattach to it.
// Kept under PING_TIMEOUT_MS so a tab that really closed is reaped here, not by
// the slower ping path. A client that is still pinging keeps refreshing it.
const CLIENT_REATTACH_GRACE_MS = 90000;
// Deadlines for states that never got their timers cleared.
const REAPER_DEADLINES = { creating: 5 * 60 * 1000, finished_queue: 2 * 60 * 1000 };

// ── pure helpers ────────────────────────────────────────────────────────────
const enc = new TextEncoder();

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}
function withCors(res, origin) {
  const h = new Headers(res.headers);
  h.set("Access-Control-Allow-Origin", origin || "*");
  h.set("Vary", "Origin");
  return new Response(res.body, { status: res.status, headers: h });
}
function preflight(origin) {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": origin || "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,x-api-key",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin",
    },
  });
}
// Parse a provider response, with the same friendly messages the Node version
// produced (empty bodies under load were the old "Unexpected end of JSON input").
async function parseJsonResponse(res, what) {
  if (!res.ok) {
    const err = new Error(res.status >= 500
      ? `${what} is briefly unavailable right now (HTTP ${res.status}) — try again in a moment.`
      : `${what} is at capacity right now (HTTP ${res.status}) — please try again in a moment.`);
    // Carried on the error so createAccountRaw can honour a provider's own
    // cooldown instead of guessing, and so callers can tell "this lane is
    // throttled" (retry later, try another lane) from "this lane is broken".
    err.httpStatus = res.status;
    err.throttled = res.status === 429 || res.status === 402 || res.status === 403;
    const ra = parseInt(res.headers.get("retry-after") || "", 10);
    if (Number.isFinite(ra) && ra > 0) err.retryAfterMs = Math.min(ra * 1000, 30000);
    throw err;
  }
  const t = await res.text();
  if (!t) throw new Error(`${what} is under heavy load right now and sent no response — try again in a moment.`);
  try { return JSON.parse(t); }
  catch { throw new Error(`${what} sent an invalid response — try again in a moment.`); }
}
// Mail-lane ids, provider hostnames and HTTP codes belong in the logs, not on a
// player's screen: they read as "something is broken" and are what turns one
// transient throttle into a wall of support questions. Anything that came out of
// a provider is replaced with one calm, accurate sentence; errors we wrote for
// the player ourselves (the play-credits message, a refused registration) pass
// through untouched.
// The one player-facing sentence for every "the machinery behind this is busy"
// case: rate limits, dead mail lanes, an exhausted queue. Deliberately without a
// provider name, an HTTP code, or a "why" — all of that is accurate and none of
// it is the player's problem.
const BUSY_MESSAGE = "We're at our busiest right now and couldn't set up your game in time — please try again in a moment. Nothing is wrong on your side.";
// Shown only while Raccoon's bot wall is up. That is a *known outage*, not a busy
// spell: every retry gets the same refusal, so telling the player to retry is a
// lie that also spends quota. Say what is actually true and point at the path
// that does work — a player's own account skips registration entirely.
const OUTAGE_MESSAGE = "The game service now asks for a quick human check before it opens an account: one slider puzzle, solved once. Open your account settings, get a mailbox and solve it — after that your games start normally, and so do everyone else's.";
// What a player gets when *automatic* account creation is refused. They are not
// asked to solve anything: the automatic path never uses the human check (the
// pool is filled without one), and sending them to a slider they cannot pass is
// what produced a 43-minute countdown on a Play button. Nothing on their side is
// wrong, so the message says that and points at time, not effort.
const NO_ACCOUNT_MESSAGE = "Every free slot is busy right now and the game service is not opening new accounts this minute. Nothing is wrong on your side \u2014 try again in a few minutes.";
// Shown when Raccoon refuses the *address* rather than the human check: it
// treats the free mail providers' domains as disposable, and no amount of
// retrying, re-solving or waiting changes that. Naming the provider or quoting
// Raccoon's own sentence ("Temporary email addresses are not supported.") sends
// players to report a bug about an address they never chose, so the message says
// what is true and points at the path that works: their own account.
const MAIL_REFUSED_MESSAGE = "The game service is refusing the free mail providers this site uses, so a new account cannot be made right now. If you have your own account for the game, add it in Settings and your games start normally.";
function playerMessage(e) {
  // Checked before the generic wall wording: an auto-created account that ran
  // into the wall is a capacity problem, not homework for the player.
  if (e && e.raccoonWall && e.auto) return NO_ACCOUNT_MESSAGE;
  if (e && e.raccoonWall) return OUTAGE_MESSAGE;
  if (e && e.busy) return BUSY_MESSAGE;
  const m = String((e && e.message) || "");
  // "Raccoon refuse(s|d) <domain> as a temporary address" is our own wording for
  // a domain the screen retired. Without it a player would read the domain name
  // and Raccoon's name in their error line, which is exactly the leak this whole
  // function exists to stop.
  if (/at capacity|rate limit|heavy load|briefly unavailable|invalid response|no response|no verification code|No mail domains|blocklisted by Raccoon|Raccoon refuse|temporary address/i.test(m)) {
    return BUSY_MESSAGE;
  }
  return m;
}
function fetchWithTimeout(url, opts = {}, ms = RACCOON_TIMEOUT_MS) {
  return fetch(url, { ...opts, signal: AbortSignal.timeout(ms) });
}
function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
// Raccoon hands back an AES-256-CBC blob (fixed key/IV, PKCS#7) with the game
// server details. Node used createDecipheriv; WebCrypto does the same job.
async function decryptPayload(result) {
  const key = await crypto.subtle.importKey(
    "raw", enc.encode("fd39e724f7c1e4b3d34bc7c72b5349c3"), { name: "AES-CBC" }, false, ["decrypt"],
  );
  const plain = await crypto.subtle.decrypt(
    { name: "AES-CBC", iv: enc.encode("dd39e4a3337fe25a") }, key, b64ToBytes(result),
  );
  const parsed = JSON.parse(new TextDecoder().decode(plain));
  if (parsed === null || typeof parsed !== "object") throw new Error("decryptPayload: unexpected shape");
  return parsed;
}
const generateSN = () => crypto.randomUUID().replace(/-/g, "").toLowerCase();
function generatePassword() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$";
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  let p = "";
  for (let i = 0; i < bytes.length; i++) p += chars[bytes[i] % chars.length];
  return p;
}
const codeFromText = (s) => {
  const m = String(s || "").replace(/<[^>]*>/g, " ").match(/\b\d{6}\b/);
  return m ? m[0] : null;
};
// A Worker has no long-lived process, so waiting is explicit. Workers expose the
// Node timers shim (nodejs_compat); scheduler.wait is the native fallback.
function sleep(ms) {
  if (typeof setTimeout === "function") return new Promise((r) => setTimeout(r, ms));
  if (typeof scheduler !== "undefined" && scheduler && typeof scheduler.wait === "function") return scheduler.wait(ms);
  return new Promise(() => {});
}

// ── Origin allowlist ────────────────────────────────────────────────────────
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function originMatches(pattern, origin) {
  if (pattern === origin) return true;
  if (origin.startsWith(pattern.replace(/\/+$/, ""))) return true; // URL prefix (legacy)
  if (!pattern.includes("*")) return false;
  const re = new RegExp("^" + pattern.split("*").map(escRe).join("[^/]*") + "$");
  return re.test(origin);
}
const FREE_HOST_SUFFIXES = [
  "https://*.pages.dev", "https://*.workers.dev", "https://*.github.io",
  "https://*.netlify.app", "https://*.vercel.app",
  "https://s3.amazonaws.com",
  "http://*.s3-website-*.amazonaws.com", "https://*.s3-website-*.amazonaws.com",
  "https://*.web.app", "https://*.firebaseapp.com", "https://storage.googleapis.com",
  "https://*.azurestaticapps.net",
  "https://*.gitlab.io", "https://*.codeberg.page", "https://*.surge.sh",
  "https://*.neocities.org", "https://*.tiiny.site", "https://*.js.org",
  // Bunny CDN pull zones (ghostcloud-math.b-cdn.net and any future mirror).
  // A CDN pull zone is free to create, so this is exactly as open as
  // *.vercel.app / *.pages.dev above — replace it with the single exact
  // origin if you'd rather keep the list tight and redeploy per mirror.
  "https://*.b-cdn.net",
];

export class Hub {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.storage = state.storage;

    this.sites = SITES;
    this.POOL_TARGET = Math.min(Math.max(parseInt(env.GHOSTCLOUD_POOL_TARGET || "6", 10) || 6, 3), 20);
    // Hand a finished session's account back to the pool instead of discarding
    // it, so the next player reuses it. See recycleAccount().
    this.ACCOUNT_REUSE = env.GHOSTCLOUD_REUSE_ACCOUNTS !== "off";
    this.MAIL_PROVIDERS = (env.GHOSTCLOUD_MAIL_PROVIDERS || "https://api.duckmail.sbs,https://api.mail.gw")
      .split(",").map((s) => s.trim()).filter(Boolean);
    this.MAIL_DOMAIN = (env.GHOSTCLOUD_MAIL_DOMAIN || "").trim().toLowerCase();
    this.TEMPMAILLOL_ENABLED = env.GHOSTCLOUD_TEMPMAILLOL !== "off";
    this.PRO_CODE = env.GHOSTCLOUD_PRO_CODE || "";
    this.PRO_EPOCH = env.GHOSTCLOUD_PRO_EPOCH || "1";
    this.PRO_DAILY_SECONDS = 8 * 3600;
    this.INBOUND_KEY = env.GHOSTCLOUD_INBOUND_KEY || "";
    // Optional: when set, /cloud/v1/seedPool requires it in `x-seed-key`.
    this.SEED_KEY = env.GHOSTCLOUD_SEED_KEY || "";
    // How long to stop attempting registrations after Raccoon's wall is seen.
    // 10 min by default; override with GHOSTCLOUD_WALL_COOLDOWN_MS.
    this.RACCOON_WALL_COOLDOWN_MS = Math.max(60000, Number(env.GHOSTCLOUD_WALL_COOLDOWN_MS || 600000));

    // ── live state (in memory while the object is active) ──
    this.sessions = new Map();
    this.pool = [];
    this.presence = new Map();
    this.siteUsage = new Map();
    this.ipLimits = new Map();
    this.embedIpLimits = new Map();
    // Raccoon keeps the pending registration puzzle in a Laravel session and
    // hands that session back as a `raccoongame_session` cookie on the challenge
    // response. `/emailRegisterCaptchaVerify` looks the challenge up *in that
    // session* — send the verify without it and the answer is not "wrong
    // position", it is "The puzzle has expired", which is indistinguishable from
    // a real expiry and made the whole relay look broken. So the session is kept
    // here, keyed by sn, for the few seconds between challenge → verify →
    // sendEmail → emailRegister, and sent on every one of those calls.
    this.raccoonSessions = new Map(); // sn → { cookie, at }
    // Challenge handed to a browser, by address, so re-opening the check reuses
    // it instead of asking Raccoon again (see PUZZLE_REUSE_MS).
    this.puzzleChallenges = new Map(); // email → { sn, challenge, at }
    // One in-flight challenge request per address, so a double tap cannot become
    // two requests on the shared budget.
    this.puzzleInflight = new Map(); // email → Promise
    // sn → { email, at }: solved checks that must not be re-opened by a retry.
    this.verifiedPuzzles = new Map();
    this.accountCreators = 0; // registrations in flight (global — see ACCOUNT_CREATE_MAX)
    this.accountWaiters = []; // players queued for a registration slot, oldest first
    this.capacityWaiters = [];
    this.proTokens = new Map();
    this.proAttempts = new Map();
    this.inboundCodes = new Map();
    this.blockedMailDomains = new Set();
    // Domains the *screen* below has passed, with when. In memory only: it is a
    // cache of a cheap check, and a fresh Durable Object simply re-asks.
    this.screenedMailDomains = new Map();
    this.providerHealth = new Map();
    this.providerStats = new Map();
    this.lastQueueBroadcastAt = 0;
    this.nextPoolFillAt = Date.now() + POOL_FILL_STARTUP_GRACE_MS;
    this.poolFillFails = 0;
    this.alarmAt = 0;
    this.lastDashboardAt = 0;
    this.lastPresenceSweepAt = 0;
    this.poolFilling = false;
    this.raccoonWalledUntil = 0;
    // Challenge issuance is budgeted locally so one busy hour cannot spend the
    // shared IP's allowance and lock the check out for everybody (see
    // PUZZLE_ISSUE_MAX). `puzzleBlockedUntil` is Raccoon's own "no" — while it
    // is set we do not ask at all, which is what stops the cooldown escalating
    // (591s → 3406s → 3543s in the live reports).
    this.puzzleIssueTimes = [];
    this.puzzleBlockedUntil = 0;

    // ── durable bits (survive eviction between deploys) ──
    this.ready = state.blockConcurrencyWhile(async () => {
      try {
        const savedPool = await this.storage.get("pool");
        if (Array.isArray(savedPool)) this.pool = savedPool.filter((a) => a && a.sn && a.token);
        const savedPro = await this.storage.get("proTokens");
        if (Array.isArray(savedPro)) this.proTokens = new Map(savedPro);
        const savedBlocked = await this.storage.get("blockedDomains");
        if (Array.isArray(savedBlocked)) this.blockedMailDomains = new Set(savedBlocked);
        const savedWall = await this.storage.get("raccoonWalledUntil");
        if (typeof savedWall === "number" && savedWall > Date.now()) this.raccoonWalledUntil = savedWall;
        // A lockout must outlive the object too: eviction is not permission to
        // ask again and push the window out by another hour.
        const savedPuzzleBlock = await this.storage.get("puzzleBlockedUntil");
        if (typeof savedPuzzleBlock === "number" && savedPuzzleBlock > Date.now()) this.puzzleBlockedUntil = savedPuzzleBlock;
        // Puzzle sessions and solved checks have to outlive this object. A
        // Durable Object is evicted when it goes quiet, and the gap between a
        // challenge being handed to a human and that human dragging the slider
        // is exactly when it goes quiet — which used to drop the session the
        // verification is bound to and answer a correct drag with "The puzzle
        // has expired. Please refresh it."
        const savedRaccoon = await this.storage.get("raccoonSessions");
        if (Array.isArray(savedRaccoon)) {
          for (const [sn, v] of savedRaccoon) {
            if (v && v.cookie && Date.now() - v.at < Hub.PUZZLE_SESSION_TTL_MS) this.raccoonSessions.set(sn, v);
          }
        }
        const savedPuzzles = await this.storage.get("puzzleChallenges");
        if (Array.isArray(savedPuzzles)) {
          for (const [email, v] of savedPuzzles) {
            // The challenge lives under `payload` (the response body minus the
            // per-request fields), so that — not `v.challenge` — is what has to
            // be present for the entry to be usable.
            if (v && v.sn && v.payload && v.payload.challenge && Date.now() - v.at < PUZZLE_REUSE_MS) this.puzzleChallenges.set(email, v);
          }
        }
        const savedVerified = await this.storage.get("verifiedPuzzles");
        if (Array.isArray(savedVerified)) {
          for (const [sn, v] of savedVerified) {
            if (v && Date.now() - v.at < PUZZLE_VERIFIED_TTL_MS) this.verifiedPuzzles.set(sn, v);
          }
        }
      } catch (e) {
        console.log(`state load failed: ${e.message}`);
      }
    });
  }

  // ══ HTTP entry ══════════════════════════════════════════════════════════
  async fetch(request) {
    const url = new URL(request.url);
    const origin = request.headers.get("origin") || "";
    if (request.method === "OPTIONS") return preflight(origin);

    try {
      await this.ready;
      const res = await this.route(request, url);
      this.ensureTicking();
      // A 101 carries the WebSocket in `webSocket` — re-wrapping it in a new
      // Response would drop the upgrade, so pass it through untouched
      // (WebSockets don't use CORS anyway).
      if (res.status === 101) return res;
      return withCors(res, origin);
    } catch (e) {
      console.log(`route error ${url.pathname}: ${e && e.message}`);
      return withCors(json({ error: e && e.message ? e.message : "Server error." }, 500), origin);
    }
  }

  async route(request, url) {
    const path = url.pathname;

    // WebSocket upgrade for the signaling relay.
    const signal = path.match(/^\/cloud\/v1\/signal\/([0-9a-f-]{36})$/i);
    if (signal) return this.handleSignal(request, signal[1]);

    // No-auth endpoints.
    // "/" is liveness (is this Worker running at all); "/healthz" is readiness
    // (can a player actually start a game right now). Keeping them apart means
    // a monitor pointed at "/" still goes green after a deploy while a monitor
    // pointed at "/healthz" can say "degraded" without the two contradicting.
    if (path === "/") return json({ status: "ok", name: "ghostcloud-api" });
    if (path === "/healthz") {
      const health = this.healthReport();
      return json(health.body, health.status);
    }
    if (path === "/cloud/v1/inbound") return this.handleInbound(request);

    // Everything else needs a valid API key + allowed origin.
    const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};
    const apiKey = request.headers.get("x-api-key") || body?.api_key || url.searchParams.get("api_key");
    if (!apiKey) return json({ error: "Missing API key." }, 401);
    const siteName = Object.keys(this.sites.sites).find((k) => this.sites.sites[k].api_key === apiKey);
    if (!siteName) return json({ error: "Invalid API key." }, 401);
    const site = { name: siteName, ...this.sites.sites[siteName] };
    if (!site.enabled) return json({ error: "API Key disabled." }, 403);
    const origin = request.headers.get("origin");
    if (origin && !this.originAllowed(origin, site)) return json({ error: "Origin not allowed." }, 403);

    const ip = this.clientIp(request);
    // Presence pings are tiny and a school can share one NAT IP — don't let them
    // trip the per-IP burst limit.
    if (!path.startsWith("/cloud/v1/heartbeat") && !path.startsWith("/cloud/v1/online")) {
      if (!this.checkIpLimit(this.ipLimits, ip, 60000, 100)) return json({ error: "Too many requests." }, 429);
    }

    const ctx = { site, apiKey, body, ip, request, url };
    switch (path) {
      case "/cloud/v1/createSession": return this.handleCreateSession(ctx);
      case "/cloud/v1/getQueue": return this.handleGetQueue(ctx);
      case "/cloud/v1/startGame": return this.handleStartGame(ctx);
      case "/cloud/v1/pingSession": return this.handlePingSession(ctx);
      case "/cloud/v1/quitSession": return this.handleQuitSession(ctx);
      case "/cloud/v1/heartbeat": return this.handleHeartbeat(ctx);
      case "/cloud/v1/online": return json({ online: this.onlineCount() });
      case "/cloud/v1/createMailbox": return this.handleCreateMailbox(ctx);
      case "/cloud/v1/getCode": return this.handleGetCode(ctx);
      case "/cloud/v1/sendEmail": return this.handleSendEmail(ctx);
      case "/cloud/v1/manualRegister": return this.handleManualRegister(ctx);
      case "/cloud/v1/captchaChallenge": return this.handleCaptchaChallenge(ctx);
      case "/cloud/v1/captchaVerify": return this.handleCaptchaVerify(ctx);
      case "/cloud/v1/seedPool": return this.handleSeedPool(ctx);
      case "/cloud/v1/activatePro": return this.handleActivatePro(ctx);
      case "/cloud/v1/verifyPro": return this.handleVerifyPro(ctx);
      case "/cloud/v1/diagMail": return this.handleDiagMail(ctx);
      case "/cloud/v1/capabilities": return json({ apiVersion: API_VERSION, capabilities: API_CAPABILITIES });
      case "/cloud/v1/embed-data": return this.handleEmbedData(ctx);
      default: return json({ error: "Not found." }, 404);
    }
  }

  originAllowed(origin, site) {
    if (site.allow_all_origins === true) return true;
    const allowed = site.allowed_origins || [];
    if (allowed.includes("*") || allowed.includes(origin)) return true;
    const list = site.allow_free_hosts ? allowed.concat(FREE_HOST_SUFFIXES) : allowed;
    return list.some((a) => originMatches(a, origin));
  }
  clientIp(request) {
    return request.headers.get("cf-connecting-ip")
      || request.headers.get("x-caddy-real-ip-is-here1357908642")
      || "unknown";
  }

  // ── /healthz ────────────────────────────────────────────────────────────
  // Readiness, not liveness. The old endpoint answered `ok` unconditionally, so
  // it stayed green through a three-day outage and the first anyone heard about
  // it was a Discord message. This answers 503 in the one state that really
  // means "nobody can start a game": the pool is empty and registration has
  // been failing — either Raccoon's bot wall is up or the recent fills have all
  // errored. In-memory numbers only (no Raccoon call, no mail provider, no
  // storage read), so a pinger every minute costs nothing and cannot itself
  // become the outage.
  // Deliberately terse: it is a public URL, and "which lane is throttled" is
  // what diagMail is for.
  healthReport() {
    const pool = this.pool.length;
    const wallLeftMs = Math.max(0, this.raccoonWalledUntil - Date.now());
    let reason = null;
    if (pool === 0) {
      if (wallLeftMs > 0) reason = "registration_walled";
      else if (this.poolFillFails >= 3) reason = "pool_fill_failing";
    }
    const body = { status: reason ? "degraded" : "ok", name: "ghostcloud-api", apiVersion: API_VERSION };
    if (reason) body.reason = reason;
    if (wallLeftMs > 0) body.retry_after_seconds = Math.ceil(wallLeftMs / 1000);
    // The account pool is what decides whether anybody can play, so it is worth
    // reporting even when the answer is "ok".
    body.pool = pool;
    body.pool_target = this.POOL_TARGET;
    // A locked-out human check is not an outage — play still works from the pool
    // — but it is the first thing to look at when registrations stop, and it
    // stops a monitor from rediscovering the same hour-long wait.
    const puzzleLeft = this.puzzleBlockRemaining();
    if (puzzleLeft > 0) body.puzzle_blocked_for_seconds = puzzleLeft;
    return { status: reason ? 503 : 200, body };
  }
  // Is this pooled account still able to log in? One authenticated checkCost,
  // for the game the player actually asked for — the same call doInitGame makes,
  // so a pass here means the launch will get past auth too.
  //
  // Three answers, not two: "works", "refused" (retire it) and "don't know" (a
  // timeout, a 5xx, a reply we do not recognise). Unknown keeps the account — a
  // Raccoon hiccup must not empty the pool, and the launch itself is the real
  // test. Only refusal, which is what a ban or a revoked token looks like, costs
  // the account.
  async poolAccountUsable(acc, game_key) {
    if (!acc || !acc.token || !acc.sn) return false;
    if (!game_key) return true; // no game to price — nothing to ask
    if (acc.checkedAt && Date.now() - acc.checkedAt < POOL_CHECK_TTL_MS) return true;
    const common = {
      sn: acc.sn, model: "Chrome/147.0.0.0", version_code: "1", version_name: "1.0.0",
      device_name: "GhostCloud", os: "web", "manufacturer;": "", user_token: acc.token,
    };
    try {
      const res = await this.raccoonFetch("/userGame/checkCost", {
        method: "POST", headers: this.gameHeaders(acc.token),
        body: new URLSearchParams({ ...common, game_key }),
      });
      if (res.status === 401 || res.status === 403) {
        console.log(`pool: account ${String(acc.sn).slice(0, 6)} refused at auth (HTTP ${res.status}) — dropping it`);
        return false;
      }
      const data = await res.json().catch(() => null);
      // 3004 is "this game needs diamonds" — the account is fine, it just cannot
      // play this title, which the launch path already retries around.
      if (data && typeof data.status === "number" && data.status !== 200 && data.status !== 3004) {
        const msg = String(data.msg || "");
        const refused = ACCOUNT_REFUSAL_RE.test(msg);
        console.log(`pool: account ${String(acc.sn).slice(0, 6)} check answered ${data.status} — ${refused ? "dropping it" : "keeping it"}: ${msg.slice(0, 120)}`);
        if (refused) return false;
        return true;
      }
      acc.checkedAt = Date.now();
      return true;
    } catch (e) {
      console.log(`pool: account check failed — ${e.message} (keeping the account)`);
      return true;
    }
  }
  checkIpLimit(store, ip, windowMs, max) {
    const now = Date.now();
    const hits = (store.get(ip) || []).filter((t) => t > now - windowMs);
    if (hits.length >= max) return false;
    hits.push(now);
    store.set(ip, hits);
    return true;
  }
  getSiteLimits(site) { return site.limits || { per_minute: 60, per_hour: 3600, per_day: 86400, per_month: 2592000 }; }
  checkRateLimit(apiKey, site) {
    const now = Date.now();
    const calls = this.siteUsage.get(apiKey) || [];
    const limits = this.getSiteLimits(site);
    const count = (ms) => calls.filter((t) => t > now - ms).length;
    if (count(60000) >= limits.per_minute) return { allowed: false, reason: "per-minute" };
    if (count(3600000) >= limits.per_hour) return { allowed: false, reason: "per-hour" };
    if (count(86400000) >= limits.per_day) return { allowed: false, reason: "per-day" };
    if (count(30 * 86400000) >= limits.per_month) return { allowed: false, reason: "per-month" };
    return { allowed: true };
  }
  recordUsage(apiKey) {
    const now = Date.now();
    const calls = (this.siteUsage.get(apiKey) || []).filter((t) => t > now - 30 * 86400000);
    calls.push(now);
    this.siteUsage.set(apiKey, calls);
  }
  getUsageStats(apiKey) {
    const now = Date.now();
    const calls = this.siteUsage.get(apiKey) || [];
    return {
      perMin: calls.filter((t) => t > now - 60000).length,
      perHour: calls.filter((t) => t > now - 3600000).length,
      perDay: calls.filter((t) => t > now - 86400000).length,
      perMonth: calls.filter((t) => t > now - 30 * 86400000).length,
    };
  }
  countActiveSessions(apiKey) {
    let n = 0;
    for (const s of this.sessions.values()) if (s.api_key === apiKey) n++;
    return n;
  }
  // Take a registration slot, or return false if they are all busy. The cap is
  // global (ACCOUNT_CREATE_MAX) rather than per site because the thing being
  // protected — a free temp-mail provider — does not know or care which site a
  // request came from.
  acquireAccountSlot() {
    if (this.accountCreators >= ACCOUNT_CREATE_MAX) return false;
    this.accountCreators += 1;
    return true;
  }
  releaseAccountSlot() {
    this.accountCreators = Math.max(0, this.accountCreators - 1);
  }
  // Waits for a registration slot, keeping the player's setup stream alive with
  // progress events while they wait. This is the difference between "you are in
  // line, hang on" and the raw provider error that used to end the attempt: the
  // wait is bounded, cancellable, and visible, so a busy moment costs a short
  // wait instead of a failed click.
  async waitForAccountSlot(w) {
    if (this.acquireAccountSlot()) { w.slotHeld = true; return true; }
    this.accountWaiters.push(w);
    const deadline = Date.now() + ACCOUNT_SLOT_WAIT_MS;
    let lastNoticeAt = 0;
    try {
      while (Date.now() < deadline) {
        if (w.ended) return false; // player closed the tab — stop waiting
        // Reuse the client's existing queue rendering: it already turns these
        // into "you're #N in line, your game starts automatically", which is both
        // honest and the exact opposite of the provider error this replaces.
        if (Date.now() - lastNoticeAt > 5000) {
          lastNoticeAt = Date.now();
          const idx = this.accountWaiters.indexOf(w);
          w.push({
            status: "capacity_queue",
            position: idx >= 0 ? idx + 1 : 1,
            waited_seconds: Math.round((Date.now() - w.enqueuedAt) / 1000),
            reason: "account_setup",
          });
        }
        await sleep(2000);
        if (w.ended) return false;
        if (this.acquireAccountSlot()) { w.slotHeld = true; return true; }
      }
      return false;
    } finally {
      const idx = this.accountWaiters.indexOf(w);
      if (idx >= 0) this.accountWaiters.splice(idx, 1);
    }
  }
  // Release once and only once, whatever path the setup took. Without the flag a
  // failure after a successful registration would decrement again and quietly
  // widen the cap this whole mechanism exists to enforce.
  releaseAccountSlotFor(w) {
    if (!w.slotHeld) return;
    w.slotHeld = false;
    this.releaseAccountSlot();
  }

  // ══ Mail lanes ══════════════════════════════════════════════════════════
  isTempBlockedMessage(msg) { return /temporary email|not supported|disposable|cannot receive email/i.test(String(msg || "")); }
  // Raccoon's anti-bot wall. Unlike "this domain is a disposable mailbox", this
  // is not about the address: it refuses every address, including a real one, so
  // rotating domains or retrying the same lane cannot get past it. Walking the
  // remaining lanes, passes and providers after this is pure waste — it burns
  // subrequests, spends provider quota, and delays the player's error by ~45s
  // for an answer that will not change. Recognise it and stop.
  // The refusal that means "pass the human check first".
  // Raccoon words its refusal "Please complete the puzzle verification.", so
  // `verification` has to count — without it the refusal was classified as a
  // generic error, the site printed the raw sentence, and the player was told to
  // complete a check that was never shown.
  //
  // It must NOT count for our own wording: "no verification code from <lane>" is
  // a dead temp-mail lane, and reading that as the wall would pause every
  // registration for the whole cooldown because one provider blinked. Ours is
  // excluded first, then anything human-check shaped matches.
  isRaccoonWall(msg) {
    const m = String(msg || "");
    if (/no verification code|verification code from/i.test(m)) return false;
    // "Verification code has expired or is incorrect" contains "verification"
    // and is NOT the check — it is the code. See raccoonCodeRejected().
    if (this.raccoonCodeRejected(m)) return false;
    return /puzzle|captcha|human|robot|slide|verification|too frequent/i.test(m);
  }
  // The *code*, not the check, and not the address. Raccoon changed this on
  // 2026-10-14: `/users/emailRegister` no longer asks for the puzzle at all (it
  // answers a bad code with `415 "Verification code has expired or is
  // incorrect"`, whether or not the sn was ever solved), and only `sendEmail`
  // still wants it (`400 "Please complete the puzzle verification."`).
  //
  // That matters twice over. One, the sentence contains "verification", so
  // without this it was read as the wall — a single stale code from one temp-mail
  // lane started a ten-minute service-wide cooldown. Two, the player was told to
  // solve the check again, which cannot help: the fix is another code.
  raccoonCodeRejected(msg) {
    const m = String(msg || "");
    if (!/\bcode\b/i.test(m)) return false;
    return /expir|incorrect|invalid|wrong|mismatch|used/i.test(m);
  }
  // Remember the wall and stop attempting registrations for a cooldown. The
  // wall refuses every address, so a retry cannot change the answer — it only
  // spends mail-provider quota, a Raccoon request, and (on the free plan)
  // Durable Object requests against a 100k/day budget. Without this the pool-fill
  // loop kept re-attempting every 20-60s around the clock for nothing.
  noteRaccoonWall(why) {
    this.raccoonWalledUntil = Date.now() + this.RACCOON_WALL_COOLDOWN_MS;
    this.state.waitUntil(this.storage.put("raccoonWalledUntil", this.raccoonWalledUntil).catch(() => {}));
    console.log(`raccoon wall (${String(why || "").slice(0, 80)}) — pausing registrations for ${Math.round(this.RACCOON_WALL_COOLDOWN_MS / 1000)}s`);
  }
  // Exposed on the class (not as a module export — a Worker module may only
  // export handlers/classes, and a bare string export stops workerd booting).
  // What a player reads is behaviour worth testing: the wall/busy wording
  // distinction is the whole point of the outage handling.
  playerMessageFor(e) { return playerMessage(e); }
  // The player-facing error plus the machine-readable hint the site needs to act
  // on it. The prose tells a *human* to go and solve the check; `needVerification`
  // lets the site take them there in one click instead of leaving them to find a
  // screen they have never opened. The field is additive, so an older site
  // simply ignores it. This is the fix for "it says complete verification but I
  // cannot see any verification": the session error now carries the fact that a
  // check exists, and the site can open it.
  sessionErrorEvent(e) {
    // The automatic path can never make use of a human check: the pool is filled
    // without one, and Raccoon's refusal is about this Worker's IP budget, not
    // about the person pressing Play. Sending them to a slider produced a
    // 43-minute countdown on a Play button, so the hint is dropped for these and
    // the event says "capacity" instead.
    const auto = !!(e && e.auto);
    const wall = !auto && ((!!(e && e.raccoonWall)) || this.isRaccoonWall(e && e.message));
    const out = { status: "error", error: playerMessage(e), needVerification: wall };
    if (auto) {
      out.capacity = true;
      const left = Math.ceil(Math.max(0, this.raccoonWalledUntil - Date.now()) / 1000);
      if (left > 0) out.retry_after_seconds = left;
    }
    return out;
  }
  wallCooldownError() {
    if (Date.now() >= this.raccoonWalledUntil) return null;
    const left = Math.ceil((this.raccoonWalledUntil - Date.now()) / 1000);
    // `auto`: this error is from the automatic account path, where the player has
    // no slider to solve — see sessionErrorEvent.
    return Object.assign(new Error(`raccoon registration wall in cooldown (${left}s left)`), { busy: true, raccoonWall: true, auto: true });
  }
  markDomainBlocked(email, why) {
    const dom = String(email || "").split("@")[1];
    if (!dom || !this.isTempBlockedMessage(why) || this.blockedMailDomains.has(dom)) return;
    this.blockedMailDomains.add(dom);
    this.screenedMailDomains.delete(dom);
    console.log(`mail domain rejected by Raccoon (${String(why).trim()}) — ${dom} added to blocklist`);
    this.state.waitUntil(this.storage.put("blockedDomains", [...this.blockedMailDomains]).catch(() => {}));
  }
  // Is this address's domain one Raccoon will actually accept?
  //
  // A domain it refuses costs a player a whole solved puzzle and then reads as the
  // site being broken ("Temporary email addresses are not supported." — the red
  // text in the bug report). So the mailbox is screened before it is ever handed
  // out.
  //
  // Measured 2026-10-16, against Raccoon directly: `/users/emailRegister` answers
  // the *domain* question before it looks at the code, and needs no puzzle and no
  // session — a blocked domain with a junk code answers "Temporary email addresses
  // are not supported.", a reachable domain answers the same junk code with a
  // code complaint. So one cheap call settles it, with no human involved.
  //
  // A domain that passes is remembered for MAIL_DOMAIN_SCREEN_TTL_MS, so this is
  // asked once per domain per TTL rather than once per player; a domain that fails
  // goes on the permanent blocklist above. A screen that could not be run proves
  // nothing, so it lets the mailbox through — the sendEmail path still catches it.
  async screenMailDomain(email) {
    const dom = String(email || "").split("@")[1];
    if (!dom) return true;
    if (this.blockedMailDomains.has(dom)) return false;
    const passedAt = this.screenedMailDomains.get(dom);
    if (passedAt && Date.now() - passedAt < MAIL_DOMAIN_SCREEN_TTL_MS) return true;
    try {
      const r = await this.raccoonFetch("/users/emailRegister", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": BROWSER_UA },
        body: new URLSearchParams({
          email, code: "000000", password: generatePassword(), phone: "1", country: "Brazil",
          sn: generateSN(), model: "Chrome/147.0.0.0", version_code: "1", version_name: "1.0.0",
          device_name: "GhostCloud", os: "web",
        }),
      });
      const msg = this.raccoonRejectedMail(await r.json().catch(() => null));
      if (!msg) return true;
      if (this.isTempBlockedMessage(msg)) {
        this.markDomainBlocked(email, msg);
        console.log(`domain screen: ${dom} refused by Raccoon (${msg}) — will not be handed out`);
        return false;
      }
      // Any other refusal is about the code, which means the domain is fine.
      this.screenedMailDomains.set(dom, Date.now());
      return true;
    } catch (e) {
      console.log(`domain screen for ${dom} could not run: ${e.message}`);
      return true;
    }
  }
  raccoonRejectedMail(data) {
    if (!data || typeof data !== "object") return null;
    if (data.status === 200 || data.status === 201) return null;
    return String(data.msg || JSON.stringify(data).slice(0, 140));
  }
  noteProviderOk(id) {
    const wasSkipped = (this.providerHealth.get(id) || {}).skipUntil > Date.now();
    this.providerHealth.delete(id);
    if (wasSkipped) console.log(`mail lane ${id} healthy again — back in rotation`);
    const st = this.providerStats.get(id) || { ok: 0, fail: 0, lastErr: null };
    st.ok += 1; st.lastErr = null;
    this.providerStats.set(id, st);
  }
  noteProviderFail(id, err) {
    const h = this.providerHealth.get(id) || { fails: 0, skipUntil: 0 };
    h.fails += 1;
    if (h.fails >= 3) { h.skipUntil = Date.now() + 5 * 60000; h.fails = 0; console.log(`mail lane ${id} failing — skipping for 5 min`); }
    this.providerHealth.set(id, h);
    const st = this.providerStats.get(id) || { ok: 0, fail: 0, lastErr: null };
    st.fail += 1; st.lastErr = err ? err.message : null;
    this.providerStats.set(id, st);
  }
  // Own-domain lane: the Cloudflare Email Worker pushes codes to /inbound.
  get domainLane() {
    if (!this.MAIL_DOMAIN) return null;
    const self = this;
    return {
      id: `${self.MAIL_DOMAIN} (own domain)`,
      create: async () => {
        const email = `rcn_${Math.random().toString(36).substring(2, 11)}@${self.MAIL_DOMAIN}`;
        return { email, handle: { lane: "domain", email } };
      },
      read: async (handle) => {
        const hit = self.inboundCodes.get(String(handle.email || "").toLowerCase());
        return hit ? hit.code : null;
      },
    };
  }
  // tempmail.lol — free, no API key, and every inbox gets its own random
  // sub-domain, so one blocked sub-domain doesn't kill the lane.
  get tempmailLolLane() {
    return {
      id: "tempmail.lol",
      create: async () => {
        const r = await fetchWithTimeout("https://api.tempmail.lol/v2/inbox/create", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
        }, 15000);
        if (r.status === 429) throw new Error("tempmail.lol is rate limiting (HTTP 429)");
        const d = await parseJsonResponse(r, "Account service");
        if (!d.address || !d.token) throw new Error("tempmail.lol returned no mailbox");
        return { email: d.address, handle: { lane: "tempmail.lol", mailToken: d.token } };
      },
      read: async (handle) => {
        const r = await fetchWithTimeout(`https://api.tempmail.lol/v2/inbox?token=${encodeURIComponent(handle.mailToken)}`, {}, 15000);
        if (!r.ok) return null;
        const d = await r.json().catch(() => null);
        for (const m of d?.emails || []) {
          const c = codeFromText(m.body || m.html || "");
          if (c) return c;
        }
        return null;
      },
    };
  }
  mailtmLane(base) {
    const self = this;
    return {
      id: base.replace(/^https?:\/\//, ""),
      base,
      create: async () => {
        const domainData = await parseJsonResponse(await fetchWithTimeout(`${base}/domains`), "Account service");
        const domains = (domainData["hydra:member"] || []).map((d) => d.domain)
          .filter((d) => d && !self.blockedMailDomains.has(d));
        if (!domains.length) throw new Error(self.blockedMailDomains.size ? "all of its domains are blocklisted by Raccoon" : "No mail domains available");
        const email = `rcn_${Math.random().toString(36).substring(2, 11)}@${domains[0]}`;
        const mailPassword = generatePassword();
        // Checked, not fire-and-forget: an unchecked failure here surfaces later
        // as a confusing 401 from /token, which reads as "wrong password" when
        // the mailbox was simply never created.
        await parseJsonResponse(await fetchWithTimeout(`${base}/accounts`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ address: email, password: mailPassword }),
        }), "Account service");
        const { token: mailJwt } = await parseJsonResponse(await fetchWithTimeout(`${base}/token`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ address: email, password: mailPassword }),
        }), "Account service");
        return { email, handle: { lane: "mailtm", base, mailJwt } };
      },
      read: async (handle) => {
        const headers = { Authorization: `Bearer ${handle.mailJwt}`, "Content-Type": "application/json" };
        const data = await parseJsonResponse(await fetchWithTimeout(`${base}/messages?page=1`, { headers }), "Mail service");
        if (!data["hydra:member"]?.length) return null;
        const msgId = data["hydra:member"][0].id;
        const full = await parseJsonResponse(await fetchWithTimeout(`${base}/messages/${msgId}`, { headers }), "Mail service");
        const bodyText = [full.text, ...(Array.isArray(full.html) ? full.html : [full.html])].filter(Boolean).join("\n");
        return codeFromText(bodyText);
      },
    };
  }
  allLanes() {
    const lanes = [];
    const d = this.domainLane;
    if (d) lanes.push(d);
    if (this.TEMPMAILLOL_ENABLED) lanes.push(this.tempmailLolLane);
    this.MAIL_PROVIDERS.forEach((b) => lanes.push(this.mailtmLane(b)));
    return lanes;
  }
  laneOrder() {
    const now = Date.now();
    const all = this.allLanes();
    const healthy = all.filter((l) => { const h = this.providerHealth.get(l.id); return !h || h.skipUntil <= now; });
    return healthy.length > 0 ? healthy : all;
  }
  providerDashboard() {
    const parts = this.allLanes().map((l) => {
      const st = this.providerStats.get(l.id);
      const h = this.providerHealth.get(l.id);
      const skipped = h && h.skipUntil > Date.now() ? " (skipped)" : "";
      return `${l.id} ok=${st?.ok ?? 0} fail=${st?.fail ?? 0}${skipped}`;
    });
    const blocked = this.blockedMailDomains.size ? ` | raccoon-blocked domains: ${[...this.blockedMailDomains].join(",")}` : "";
    const fresh = this.pool.filter((a) => !(a.plays || 0)).length;
    const reuse = this.ACCOUNT_REUSE ? ` (${fresh} fresh, ${this.pool.length - fresh} reused)` : " (reuse off)";
    return `providers: ${parts.join(" | ")} | pool ${this.pool.length}/${this.POOL_TARGET}${reuse}${blocked}`;
  }
  async pollCode(lane, handle, maxRetries = 17) {
    for (let i = 0; i < maxRetries; i++) {
      try { const c = await lane.read(handle); if (c) return c; } catch {}
      await sleep(3000);
    }
    return null;
  }

  // ══ Raccoon calls ═══════════════════════════════════════════════════════
  raccoonFetch(pathAndQuery, opts = {}) {
    return fetchWithTimeout(`https://${RACCOON_HOST}${pathAndQuery}`, opts);
  }
  // ── Raccoon session for a registration puzzle ────────────────────────────
  // Verified against Raccoon directly: the same wrong offset answers
  // "The puzzle has expired. Please refresh it." without the session cookie and
  // "The puzzle does not match. Please try again." with it. A missing cookie is
  // what made every solve look expired.
  static get PUZZLE_SESSION_TTL_MS() { return 30 * 60 * 1000; }
  captureRaccoonSession(sn, res) {
    if (!sn || !res || !res.headers) return;
    const jar = (typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : null)
      || (res.headers.get("set-cookie") ? [res.headers.get("set-cookie")] : []);
    if (!jar.length) return;
    // name=value only: re-sending an expiry or a path back to the server is
    // noise, and one malformed attribute can void the whole Cookie header.
    const pairs = jar.map((c) => String(c).split(";")[0].trim()).filter(Boolean);
    if (!pairs.length) return;
    const existing = this.raccoonSessions.get(sn);
    const merged = new Map();
    for (const p of (existing ? existing.cookie.split("; ") : []).concat(pairs)) {
      const eq = p.indexOf("=");
      if (eq > 0) merged.set(p.slice(0, eq), p.slice(eq + 1));
    }
    this.raccoonSessions.set(sn, {
      cookie: [...merged].map(([k, v]) => `${k}=${v}`).join("; "),
      at: Date.now(),
    });
    this.pruneRaccoonSessions();
    // Durably, because the wait for a human is the one moment this object is
    // idle enough to be evicted (see the constructor for the whole story).
    this.state.waitUntil(this.savePuzzleState());
  }
  pruneRaccoonSessions() {
    const now = Date.now();
    for (const [k, v] of this.raccoonSessions) {
      if (now - v.at > Hub.PUZZLE_SESSION_TTL_MS) this.raccoonSessions.delete(k);
    }
    // Insertion order is oldest-first, so trimming the head is trimming the oldest.
    while (this.raccoonSessions.size > 200) {
      const oldest = this.raccoonSessions.keys().next().value;
      this.raccoonSessions.delete(oldest);
    }
    for (const [k, v] of this.puzzleChallenges) {
      if (now - v.at > PUZZLE_REUSE_MS) this.puzzleChallenges.delete(k);
    }
    while (this.puzzleChallenges.size > 100) {
      this.puzzleChallenges.delete(this.puzzleChallenges.keys().next().value);
    }
    for (const [k, v] of this.verifiedPuzzles) {
      if (now - v.at > PUZZLE_VERIFIED_TTL_MS) this.verifiedPuzzles.delete(k);
    }
    while (this.verifiedPuzzles.size > 200) {
      this.verifiedPuzzles.delete(this.verifiedPuzzles.keys().next().value);
    }
  }
  async savePuzzleState() {
    try {
      await Promise.all([
        this.storage.put("raccoonSessions", [...this.raccoonSessions]),
        this.storage.put("puzzleChallenges", [...this.puzzleChallenges]),
        this.storage.put("verifiedPuzzles", [...this.verifiedPuzzles]),
      ]);
    } catch (e) {
      // Never fail a player's check because storage hiccuped — the in-memory
      // copies still work for as long as this object lives.
      console.log(`puzzle state save failed: ${e.message}`);
    }
  }
  raccoonSessionHeader(sn) {
    const held = sn && this.raccoonSessions.get(sn);
    if (!held) return {};
    if (Date.now() - held.at > Hub.PUZZLE_SESSION_TTL_MS) { this.raccoonSessions.delete(sn); return {}; }
    return { cookie: held.cookie };
  }
  gameHeaders(token) {
    return {
      accept: "*/*",
      "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
      cookie: `as_user_token=${token}`,
      origin: "https://www.raccoongame.com",
      referer: "https://www.raccoongame.com/?t=1720436119",
      "user-agent": "Mozilla/5.0 Chrome/147.0.0.0 Safari/537.36",
      "x-requested-with": "XMLHttpRequest",
    };
  }
  async createAccountRaw() {
    // While the wall is in cooldown, return without spending a single request.
    const walled = this.wallCooldownError();
    if (walled) throw walled;
    const passBackoffMs = [3000, 8000, 20000];
    // A lane that just answered 429 is not going to answer differently two
    // seconds later, and every retry against it is another request on a meter
    // that is already full. Sit it out for the rest of this attempt.
    const throttledLanes = new Set();
    let lastErr = null;
    let hardStop = null; // a wall we cannot wait out — abort the whole attempt
    for (let pass = 0; pass <= passBackoffMs.length; pass++) {
      for (const lane of this.laneOrder()) {
        if (throttledLanes.has(lane.id)) continue;
        try {
          const { email, handle } = await lane.create();
          if (this.blockedMailDomains.has(String(email).split("@")[1])) continue;
          // One cheap call before the expensive part: a domain Raccoon refuses
          // would otherwise burn a sendEmail and ~50s of polling on mail that was
          // never going to be accepted.
          if (!(await this.screenMailDomain(email))) {
            lastErr = new Error(`Raccoon refuses ${String(email).split("@")[1]} as a temporary address`);
            console.log(`lane ${lane.id} skipped (pass ${pass + 1}): ${lastErr.message}`);
            continue;
          }
          const raccoonPassword = generatePassword();
          const sn = generateSN();
          const h = { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "Mozilla/5.0 Chrome/147.0.0.0 Safari/537.36" };
          const common = { sn, model: "Chrome/147.0.0.0", version_code: "1", version_name: "1.0.0", device_name: "GhostCloud", os: "web" };
          let code = null;
          let rejected = null;
          for (let attempt = 0; attempt < 2 && !code && !rejected; attempt++) {
            const seRes = await this.raccoonFetch("/users/sendEmail", {
              method: "POST", headers: h,
              body: new URLSearchParams({ email, type: "register", ...common }),
            });
            rejected = this.raccoonRejectedMail(await seRes.json().catch(() => null));
            if (rejected) break;
            code = await this.pollCode(lane, handle, 17);
          }
          if (rejected) {
            if (this.isRaccoonWall(rejected)) {
              hardStop = Object.assign(new Error(`Raccoon is gating registration behind a bot check: ${rejected}`), { busy: true, raccoonWall: true, auto: true });
              this.noteRaccoonWall(rejected);
              break;
            }
            this.markDomainBlocked(email, rejected);
            this.noteProviderFail(lane.id, new Error(rejected));
            lastErr = new Error(`Raccoon refused ${email.split("@")[1]}: ${rejected}`);
            console.log(`lane ${lane.id} failed (pass ${pass + 1}): ${lastErr.message}`);
            continue;
          }
          if (!code) {
            lastErr = new Error(`no verification code from ${lane.id}`);
            this.noteProviderFail(lane.id, lastErr);
            console.log(`lane ${lane.id} failed (pass ${pass + 1}): ${lastErr.message}`);
            continue;
          }
          // A code complaint gets one fresh code, not a new human check and not
          // a cooldown: the address is fine and the verification is spent, but the
          // *code* was stale — usually a temp-mail lane reading an old message.
          let regRejected = null;
          let codeRounds = 0;
          while (codeRounds < 2) {
            const regRes = await this.raccoonFetch("/users/emailRegister", {
              method: "POST", headers: h,
              body: new URLSearchParams({ email, code, password: raccoonPassword, phone: "1", country: "Brazil", ...common }),
            });
            regRejected = this.raccoonRejectedMail(await regRes.json().catch(() => null));
            if (!regRejected || !this.raccoonCodeRejected(regRejected) || ++codeRounds >= 2) break;
            const again = await this.raccoonFetch("/users/sendEmail", {
              method: "POST", headers: h,
              body: new URLSearchParams({ email, type: "register", ...common }),
            });
            const againRejected = this.raccoonRejectedMail(await again.json().catch(() => null));
            if (againRejected) { regRejected = againRejected; break; }
            const fresh = await this.pollCode(lane, handle, 12);
            if (!fresh) break; // keep the code refusal — the lane is the problem
            code = fresh;
          }
          if (regRejected) {
            if (this.isRaccoonWall(regRejected)) {
              hardStop = Object.assign(new Error(`Raccoon is gating registration behind a bot check: ${regRejected}`), { busy: true, raccoonWall: true, auto: true });
              this.noteRaccoonWall(regRejected);
              break;
            }
            this.markDomainBlocked(email, regRejected);
            throw new Error(`register refused: ${regRejected}`);
          }
          const loginRes = await this.raccoonFetch("/users/emailLogin", {
            method: "POST", headers: h,
            body: new URLSearchParams({ email, password: raccoonPassword, ...common }),
          });
          const loginData = await parseJsonResponse(loginRes, "Raccoon login");
          if (loginData.status !== 200 && loginData.status !== 201) throw new Error(`Login failed: ${loginData.msg || loginData.status}`);
          let userToken = loginData.data?.user_token || "";
          const cookie = loginRes.headers.get("set-cookie");
          if (cookie) { const m = cookie.match(/as_user_token=([^;]+)/); if (m) userToken = m[1]; }
          if (!userToken) throw new Error("Login returned no user token");
          this.noteProviderOk(lane.id);
          return { sn, token: userToken };
        } catch (e) {
          if (this.isRaccoonWall(e.message)) { hardStop = Object.assign(e, { busy: true, raccoonWall: true, auto: true }); this.noteRaccoonWall(e.message); break; }
          lastErr = e;
          if (e && e.throttled) throttledLanes.add(lane.id);
          // Logged per lane, as it happens. The old code only logged `lastErr`
          // after the whole pass, which is whatever lane happened to be *last* in
          // the order — so three unrelated failures all got reported as the same
          // one, and the lane that was actually broken stayed invisible.
          console.log(`lane ${lane.id} failed (pass ${pass + 1}): ${e.message}`);
          this.noteProviderFail(lane.id, e);
        }
      }

      if (hardStop) break; // a wall, not congestion — backoff would only delay it
      if (pass < passBackoffMs.length) {
        // Honour the provider's own cooldown when it sent one — guessing short
        // is what turns one throttle into three.
        const wait = Math.max(passBackoffMs[pass], lastErr?.retryAfterMs || 0);
        console.log(`account creation failed (${lastErr ? lastErr.message : "every mail lane is blocklisted"}) — retrying in ${Math.round(wait / 1000)}s`);
        await sleep(wait);
      }
    }
    if (hardStop) throw hardStop;
    throw lastErr || new Error("Account creation failed on all providers");
  }
  // Fresh accounts first, then the least-used. Preferring `plays === 0` matters
  // because a never-played account is the one most likely to still have its
  // signup play credits; preferring the lowest count after that spreads reuse
  // across the whole pool rather than hammering a single account.
  takePooledAccount() {
    if (!this.pool.length) return null;
    let best = 0;
    for (let i = 1; i < this.pool.length; i++) {
      if ((this.pool[i].plays || 0) < (this.pool[best].plays || 0)) best = i;
    }
    return this.pool.splice(best, 1)[0];
  }
  async createAccount(game_key) {
    // Serve from the pool only if the account still logs in. Before this, the
    // least-used account was handed out unchecked, so the first player after a
    // ban wave got a failed setup and the account was gone either way — and with
    // reuse on, one ban wave looked like "the site is broken again" to everyone.
    // Checking here is what turns that outage into a silent skip to the next
    // account.
    let checked = 0;
    while (checked < POOL_CHECK_MAX) {
      const acc = this.takePooledAccount();
      if (!acc) break;
      checked++;
      if (await this.poolAccountUsable(acc, game_key)) {
        console.log(`pool: served (${acc.plays ? `reused x${acc.plays}` : "fresh"}) — ${this.pool.length} left`);
        this.state.waitUntil(this.savePool());
        this.ensureTicking();
        return acc;
      }
      // Retired, not recycled: it never reaches another player, and the pool
      // dropping below target is what makes the tick loop register a new one.
      console.log(`pool: dropped a dead account — ${this.pool.length} left`);
      this.state.waitUntil(this.savePool());
    }
    const created = await this.createAccountRaw();
    this.ensureTicking();
    return created;
  }
  // Put a finished session's account back in the pool. This is the difference
  // between one registration per session and one per handful: Raccoon gates
  // registration behind a bot check, so the fewer registrations the better — and
  // a real player registers once and then plays many games on that account.
  recycleAccount(session, reason) {
    if (!this.ACCOUNT_REUSE) return;
    if (!session || !session.sn || !session.token) return;
    if (session.account_dead) return; // the account itself failed, not the session
    if (session.account_recyclable === false) return; // the player's own account
    if (ACCOUNT_DEAD_REASONS.has(reason)) return;
    // A session that never got past setup holds an account that was never used.
    if (session.state === "creating") return;
    const plays = (session.account_plays || 0) + 1;
    this.pool.push({ sn: session.sn, token: session.token, plays });
    console.log(`pool: recycled account (${plays} play${plays === 1 ? "" : "s"}, ${reason}) — ${this.pool.length} ready`);
    this.state.waitUntil(this.savePool());
  }
  async savePool() {
    try { await this.storage.put("pool", this.pool); } catch {}
  }
  // One account per call, awaited by the tick loop. Creating a whole pool in one
  // go used to be a setInterval job; here it has to finish inside the alarm, so
  // it does a single account per tick (≈6-10s) and lets the next tick continue.
  async fillPoolOnce() {
    if (this.poolFilling) return;
    this.poolFilling = true;
    try {
      console.log(`pool: filling (${this.pool.length}/${this.POOL_TARGET})`);
      const acc = await this.createAccountRaw();
      this.pool.push(acc);
      this.poolFillFails = 0;
      await this.savePool();
      console.log(`pool: ready (${this.pool.length}/${this.POOL_TARGET})`);
    } catch (e) {
      this.poolFillFails++;
      console.log(`pool: fill error — ${e.message}`);
    } finally {
      this.poolFilling = false;
    }
  }
  async doInitGame(session) {
    const { sn, token, game_key } = session;
    const h = this.gameHeaders(token);
    const common = { sn, model: "Chrome/147.0.0.0", version_code: "1", version_name: "1.0.0", device_name: "GhostCloud", os: "web", "manufacturer;": "", user_token: token };
    try {
      const costRes = await this.raccoonFetch("/userGame/checkCost", { method: "POST", headers: h, body: new URLSearchParams({ ...common, game_key }) });
      const costData = await costRes.json().catch(() => null);
      if (costData && costData.status !== 200) console.log(`checkCost ${game_key}: ${JSON.stringify(costData).slice(0, 200)}`);
    } catch {}
    const playData = await parseJsonResponse(await this.raccoonFetch("/jyapi/playGame", {
      method: "POST", headers: h,
      body: new URLSearchParams({ ...common, game_key, model_name: "Chrome/147.0.0.0" }),
    }), "Game service");
    if (playData.status === 3004 || String(playData.msg || "").toLowerCase().includes("diamond")) {
      const err = new Error("This game needs play credits the temporary account doesn't have — try again in a moment or pick another game.");
      err.isDiamondError = true;
      throw err;
    }
    // The account was refused at launch — a ban or a token that went stale while
    // it sat in the pool. The caller swaps in another account instead of showing
    // the player an error, which is the whole point of the pool.
    if (playData.status !== 200 && playData.status !== 201 && ACCOUNT_REFUSAL_RE.test(String(playData.msg || ""))) {
      const err = new Error(`Raccoon refused the account: ${String(playData.msg || "").slice(0, 120)}`);
      err.accountRefused = true;
      throw err;
    }
    if (playData.status === 201 || (playData.status === 200 && playData.data?.play_queue_id)) {
      const qid = playData.data?.play_queue_id;
      if (!qid) throw new Error("Missing queue ID");
      return { queued: true, queue_id: qid, initial_pos: playData.data?.queue_pos };
    }
    if (playData.status === 200 && playData.data?.result) {
      return { queued: false, server_data: await decryptPayload(playData.data.result) };
    }
    throw new Error(`Unexpected playGame response: ${JSON.stringify(playData)}`);
  }
  async doPollQueue(session, queue_id) {
    const { sn, token } = session;
    const body = new URLSearchParams({ sn, model: "Chrome/147.0.0.0", version_code: "1", version_name: "1.0.0", device_name: "GhostCloud", os: "web", "manufacturer;": "", play_queue_id: queue_id, user_token: token });
    // A queue poll that hits a 5xx or a dropped connection used to end the whole
    // session (one blip on Raccoon's edge = "your game failed"). The call is a
    // read, so asking once more is safe and costs three seconds at most.
    let res = null;
    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await this.raccoonFetch("/jyapi/playQueue", { method: "POST", headers: this.gameHeaders(token), body });
        if (r.status < 500) { res = r; break; }
        lastErr = new Error(`Game queue answered HTTP ${r.status}`);
      } catch (e) { lastErr = e; }
      if (attempt === 0) await sleep(1200);
    }
    if (!res) throw lastErr || new Error("Game queue is briefly unavailable");
    const d = await parseJsonResponse(res, "Game queue");
    if (d.status !== 200 && d.status !== 201) throw new Error(`Queue poll rejected: ${JSON.stringify(d)}`);
    return d.data?.queue_pos ?? 1;
  }
  async doClaimGame(session, queue_id) {
    const { sn, token, game_key } = session;
    const d = await parseJsonResponse(await this.raccoonFetch("/jyapi/playGame", {
      method: "POST", headers: this.gameHeaders(token),
      body: new URLSearchParams({ sn, model: "Chrome/147.0.0.0", version_code: "1", version_name: "1.0.0", device_name: "GhostCloud", os: "web", "manufacturer;": "", game_key, model_name: "Chrome/147.0.0.0", play_queue_id: queue_id, user_token: token }),
    }), "Game service");
    if (d.status === 200 && d.data?.result) return decryptPayload(d.data.result);
    throw new Error(`Failed to claim game. API Status: ${d.status}`);
  }
  async doStopGame(session) {
    if (!session.sc_id) return;
    try {
      await this.raccoonFetch("/jyapi/stopGame", {
        method: "POST", headers: this.gameHeaders(session.token),
        body: new URLSearchParams({ sn: session.sn, model: "Chrome/147.0.0.0", version_code: "1", version_name: "1.0.0", device_name: "GhostCloud", os: "web", "manufacturer;": "", sc_id: String(session.sc_id), game_type: "1", user_token: session.token }),
      });
    } catch {}
  }
  async doCost(session) {
    if (!session.sc_id) return;
    try {
      const res = await this.raccoonFetch("/userGame/cost", {
        method: "POST", headers: this.gameHeaders(session.token),
        body: new URLSearchParams({ sn: session.sn, model: "Chrome/147.0.0.0", version_code: "1", version_name: "1.0.0", device_name: "GhostCloud", os: "web", "manufacturer;": "", sc_id: String(session.sc_id), game_type: "1", user_token: session.token }),
      });
      const bodyText = await res.json().catch(() => null);
      if (bodyText?.status === 3013) this.killSession(session.uuid, "upstream_terminated");
    } catch {}
  }
  applyServerData(session, sd) {
    session.sc_id = sd.sc_id || sd.play_id;
    session.bs_sc_id = sd.bs_sc_id || session.sc_id;
    session.bs_host = sd.bs_host;
    session.bs_token = sd.token;
    session.channel_id = sd.channel_id;
    session.gl_key = sd.gl_key;
    session.play_config = sd.play_config;
    session.turns = sd.turns || [];
    session.message_server = sd.message_server;
  }

  // ══ Sessions ════════════════════════════════════════════════════════════
  killSession(uuid, reason = "unknown") {
    const session = this.sessions.get(uuid);
    if (!session) return;
    try { session.clientWs?.close(1000, reason); } catch {}
    try { session.raccoonWs?.close(); } catch {}
    session.rSend = null;
    this.state.waitUntil(this.doStopGame(session).catch(() => {}));
    this.sessions.delete(uuid);
    console.log(`session ${uuid.slice(0, 8)} killed — ${reason}`);
    this.recycleAccount(session, reason);
    this.drainCapacityQueue();
    this.ensureTicking();
  }
  resetPingTimeout(uuid) {
    const s = this.sessions.get(uuid);
    if (s) s.ping_deadline = Date.now() + PING_TIMEOUT_MS;
  }
  // How long until the next tick? 0 = nothing to do, so don't arm an alarm at
  // all (alarm invocations are billed as DO requests). Note that a pending pool
  // fill still returns a delay even when it isn't due yet — otherwise the alarm
  // chain dead-ends and the pool never fills.
  nextTickDelay() {
    if (this.sessions.size > 0) return TICK_MS;
    if (this.capacityWaiters.some((w) => !w.ended)) return TICK_MS;
    if (this.pool.length < this.POOL_TARGET) {
      // While the wall is up a fill cannot succeed. Wake once when the cooldown
      // expires rather than re-arming a billed DO alarm every 20s for nothing.
      const wallLeft = this.raccoonWalledUntil - Date.now();
      if (wallLeft > 0) return Math.max(1000, wallLeft);
      return Math.max(POOL_FILL_MIN_DELAY_MS, this.nextPoolFillAt - Date.now());
    }
    return 0;
  }
  ensureTicking() {
    const delay = this.nextTickDelay();
    if (delay <= 0) return;
    const when = Date.now() + delay;
    if (this.alarmAt && this.alarmAt <= when) return; // already scheduled
    this.alarmAt = when;
    this.state.waitUntil(this.storage.setAlarm(when).catch(() => {}));
  }
  async alarm() {
    await this.ready;
    this.alarmAt = 0;
    try { await this.tick(); } catch (e) { console.log(`tick error: ${e.message}`); }
    const delay = this.nextTickDelay();
    if (delay > 0) {
      const when = Date.now() + delay;
      this.alarmAt = when;
      await this.storage.setAlarm(when);
    }
  }
  async tick() {
    const now = Date.now();

    // Deadlines that used to be setTimeout per session.
    for (const [uuid, s] of [...this.sessions]) {
      if (s.state === "queued") {
        const lastSeen = s.last_queue_poll_at ?? s.created_at;
        if (now - lastSeen > QUEUED_POLL_STALE_AFTER || now - s.created_at > QUEUED_MAX_AGE) { this.killSession(uuid, "reaper:queued_stale"); continue; }
        if (s.queue_abandon_at && now > s.queue_abandon_at) { this.killSession(uuid, "queue_abandoned"); continue; }
        continue;
      }
      if (s.state === "active") {
        if (s.ping_deadline && now > s.ping_deadline) { this.killSession(uuid, "ping_timeout"); continue; }
        if (s.session_deadline && now > s.session_deadline) { this.killSession(uuid, "max_session_length"); continue; }
        // Signaling socket gone and nobody reattached in time — now it is over.
        // A client that is still pinging refreshes detached_at (see
        // handlePingSession), so only a genuinely absent client lands here.
        if (s.detached_at && now - s.detached_at > CLIENT_REATTACH_GRACE_MS) { this.killSession(uuid, "client_ws_detached"); continue; }
        // Keep the Raccoon signaling socket warm (was a setInterval in Node).
        if (s.rSend && s.next_raccoon_ping_at && now >= s.next_raccoon_ping_at) {
          s.next_raccoon_ping_at = now + 30000;
          s.rSend({ id: "ping", uid: s.sn, type: "webUA", status: "gaming", sc_id: s.bs_sc_id });
        }
        if (s.next_cost_at && now >= s.next_cost_at) {
          s.next_cost_at = now + COST_INTERVAL_MS;
          this.state.waitUntil(this.doCost(s).catch(() => {}));
        }
        continue;
      }
      if (s.state === "finished_queue" && s.startgame_deadline && now > s.startgame_deadline) { this.killSession(uuid, "startgame_timeout"); continue; }
      const deadline = REAPER_DEADLINES[s.state];
      if (deadline !== undefined && now - s.created_at > deadline) { this.killSession(uuid, `reaper:${s.state}_deadline`); continue; }
    }

    // The capacity line must not accumulate corpses. A waiter whose player
    // closed the tab (or whose disconnect never reached us) would otherwise
    // keep its index forever — inflating everybody else's position number, and
    // later being started by drainCapacityQueue and stealing a real slot.
    // Started waiters are out of the line already, so drop them from the array
    // too: that is what keeps the advertised positions contiguous.
    if (this.capacityWaiters.length) {
      for (const w of this.capacityWaiters) {
        if (!w.started && !w.ended && now - w.enqueuedAt > QUEUED_MAX_AGE) {
          // Be honest instead of holding somebody for hours in a dead line.
          w.push({ status: "error", error: "The line is too long right now — please try again later." });
          try { w.controller.close(); } catch {}
          w.ended = true;
        }
      }
      this.capacityWaiters = this.capacityWaiters.filter((w) => !w.ended && !w.started);
    }

    // Keep the capacity line positions fresh.
    if (now - this.lastQueueBroadcastAt > QUEUE_BROADCAST_MS) {
      this.lastQueueBroadcastAt = now;
      this.broadcastCapacityQueue();
    }

    // Presence sweep + periodic cleanups.
    if (now - this.lastPresenceSweepAt > 15000) {
      this.lastPresenceSweepAt = now;
      for (const [id, seen] of this.presence) if (now - seen > PRESENCE_TTL_MS) this.presence.delete(id);
      for (const [ip, arr] of this.ipLimits) {
        const keep = arr.filter((t) => t > now - 60000);
        if (keep.length) this.ipLimits.set(ip, keep); else this.ipLimits.delete(ip);
      }
      for (const [t, v] of this.proTokens) if (now > v.exp) this.proTokens.delete(t);
      for (const [ip, arr] of this.proAttempts) {
        const keep = arr.filter((x) => x > now - 60000);
        if (keep.length) this.proAttempts.set(ip, keep); else this.proAttempts.delete(ip);
      }
      for (const [k, v] of this.inboundCodes) if (now - v.at > 30 * 60000) this.inboundCodes.delete(k);
      if (this.inboundCodes.size > 500) this.inboundCodes.clear();
      // Site usage only needs a 30-day window.
      for (const [k, calls] of this.siteUsage) {
        const keep = calls.filter((t) => t > now - 30 * 86400000);
        if (keep.length) this.siteUsage.set(k, keep); else this.siteUsage.delete(k);
      }
    }

    // Top the pool up one pass at a time, never on top of itself. If every lane
    // is refused the attempts back off exponentially, so a broken setup can't
    // burn the free plan's daily request budget on idle ticks.
    if (this.pool.length < this.POOL_TARGET && !this.poolFilling && now >= this.nextPoolFillAt && now >= this.raccoonWalledUntil) {
      await this.fillPoolOnce();
      // Arm the next attempt *after* the fill, never before it. Setting the
      // deadline up front meant a fill slower than POOL_FILL_INTERVAL_MS left
      // `nextPoolFillAt` in the past the moment it returned, so the alarm fired
      // again immediately and re-filled on a tight loop.
      const backoff = Math.min(POOL_FILL_INTERVAL_MS * Math.pow(2, Math.min(this.poolFillFails, 5)), POOL_FILL_MAX_BACKOFF_MS);
      this.nextPoolFillAt = Date.now() + backoff;
    }

    if (now - this.lastDashboardAt > DASHBOARD_INTERVAL_MS) {
      this.lastDashboardAt = now;
      console.log(this.providerDashboard());
    }
  }

  // ══ Capacity queue (players wait in line instead of erroring) ═══════════
  broadcastCapacityQueue() {
    const now = Date.now();
    for (let i = 0; i < this.capacityWaiters.length; i++) {
      const w = this.capacityWaiters[i];
      if (w.ended) continue;
      w.push({ status: "capacity_queue", position: i + 1, waited_seconds: Math.floor((now - w.enqueuedAt) / 1000) });
    }
  }
  drainCapacityQueue() {
    for (;;) {
      const w = this.capacityWaiters.find((x) => !x.ended && !x.started);
      if (!w) break;
      if (this.countActiveSessions(w.apiKey) >= w.site.max_concurrent_sessions) break;
      w.started = true;
      w.queued = false;
      w.push({ status: "slot_reserved" });
      this.runCreateSessionFlow(w).catch((e) => {
        console.log(`setup failed for ${String(w.sessionUuid || "?").slice(0, 8)} — ${e.message}`);
        w.push(this.sessionErrorEvent(e));
        try { w.controller.close(); } catch {}
      });
    }
  }

  // ══ createSession ═══════════════════════════════════════════════════════
  handleCreateSession(ctx) {
    const { game_key, account } = ctx.body || {};
    if (!game_key || typeof game_key !== "string" || game_key.length > 256) return json({ error: "Invalid game_key." }, 400);
    const manualAccount = account && typeof account.sn === "string" && typeof account.token === "string" && account.sn && account.token ? account : null;
    // No free slot -> join the line instead of a "server busy" error. The game
    // starts automatically the moment a slot frees (drainCapacityQueue).
    const mustQueue = this.countActiveSessions(ctx.apiKey) >= ctx.site.max_concurrent_sessions;
    const waiter = this.makeWaiter({ apiKey: ctx.apiKey, site: ctx.site, game_key, manualAccount, queued: mustQueue });
    // Belt and braces: if the player's connection drops the request signal
    // aborts (and the stream's cancel() fires) — either way setup stops instead
    // of holding the account and slot for someone who already left.
    try { ctx.request.signal?.addEventListener?.("abort", () => waiter.abort("client_left_during_setup")); } catch {}
    if (mustQueue) {
      this.capacityWaiters.push(waiter);
      this.broadcastCapacityQueue();
    } else {
      this.runCreateSessionFlow(waiter).catch((e) => {
        console.log(`setup failed for ${String(waiter.sessionUuid || "?").slice(0, 8)} — ${e.message}`);
        waiter.push(this.sessionErrorEvent(e));
        try { waiter.controller.close(); } catch {}
      });
    }
    this.ensureTicking();
    return waiter.response;
  }

  // A waiter is an open NDJSON stream: the client reads progress events while
  // the account is created, exactly like the Node version, so no client change.
  makeWaiter({ apiKey, site, game_key, manualAccount, queued }) {
    const self = this;
    const encoder = new TextEncoder();
    const waiter = {
      apiKey, site, game_key, manualAccount, queued,
      enqueuedAt: Date.now(), ended: false, started: !queued,
      slotHeld: false, // true while this player holds one of ACCOUNT_CREATE_MAX slots
      controller: null, sessionUuid: null, response: null,
      push(obj) {
        if (this.ended || !this.controller) return;
        try { this.controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n")); }
        catch { this.ended = true; }
      },
      // Player closed the tab / cancelled during setup — stop completely instead
      // of holding the account, the slot, and their Raccoon queue position.
      abort(reason) {
        if (this.ended) return;
        this.ended = true;
        const idx = self.capacityWaiters.indexOf(this);
        if (idx >= 0) self.capacityWaiters.splice(idx, 1);
        const s = this.sessionUuid ? self.sessions.get(this.sessionUuid) : null;
        if (s && s.state !== "active") self.killSession(s.uuid, reason);
      },
    };
    const stream = new ReadableStream({
      start(controller) {
        waiter.controller = controller;
        // Immediate first position event so the client shows the line at once.
        if (queued) waiter.push({ status: "capacity_queue", position: 1, waited_seconds: 0 });
      },
      cancel() { waiter.abort("client_left_during_setup"); },
    });
    waiter.response = new Response(stream, {
      headers: { "content-type": "application/x-ndjson", "cache-control": "no-cache" },
    });
    return waiter;
  }

  async runCreateSessionFlow(w) {
    const { apiKey, site, game_key, manualAccount } = w;
    const startedAt = Date.now();
    const rl = this.checkRateLimit(apiKey, site);
    if (!rl.allowed) {
      console.log(`rate limited ${String(apiKey).slice(-6)} — ${rl.reason}`);
      w.push({ status: "error", error: BUSY_MESSAGE });
      try { w.controller.close(); } catch {}
      return;
    }
    const uuid = crypto.randomUUID();
    w.sessionUuid = uuid;
    const rawLimit = site.max_session_seconds && site.max_session_seconds > 0 ? site.max_session_seconds : DEFAULT_SESSION_SECONDS;
    const sessionLimit = Math.min(rawLimit, MAX_SESSION_SECONDS);
    const session = {
      uuid, api_key: apiKey, state: "creating", game_key, sn: "", token: "",
      created_at: Date.now(), max_session_seconds: sessionLimit,
      last_queue_poll_at: null, last_ping_at: null,
      ping_deadline: 0, session_deadline: 0, startgame_deadline: 0, queue_abandon_at: 0, next_cost_at: 0,
      clientWs: null, raccoonWs: null, rSend: null, next_raccoon_ping_at: 0,
    };
    this.sessions.set(uuid, session);
    console.log(`createSession ${game_key} → ${uuid.slice(0, 8)}`);
    this.ensureTicking();
    try {
      let acc;
      // Bind an account to this session, remembering where it came from. The play
      // count travels back into the pool on recycle, an account that has no play
      // credits must not be handed to the next player, and one a player supplied
      // themselves must never be pooled for somebody else to use.
      const bindAccount = (a, { dead = false, recyclable = true } = {}) => {
        acc = a;
        session.sn = a.sn; session.token = a.token;
        session.account_plays = a.plays || 0;
        session.account_dead = dead;
        session.account_recyclable = recyclable;
      };
      if (manualAccount) {
        bindAccount(manualAccount, { recyclable: false });
        w.push({ status: "account_ready" });
      } else {
        // Registration slots are capped globally, so a rush means waiting a
        // short while here rather than every player racing to register at once
        // and all of them being throttled. The session already exists (so it
        // still counts against max_concurrent_sessions) and waitForAccountSlot
        // keeps the stream alive with queue events, so the client's idle timer
        // never trips and the player sees a line instead of an error.
        // `creating_account` is only sent once a slot is actually held: while
        // waiting, the player is told they are in line, which is the truth.
        if (!(await this.waitForAccountSlot(w))) {
          if (w.ended) return;
          throw Object.assign(new Error("no registration slot free in time"), { busy: true });
        }
        w.push({ status: "creating_account" });
        const fresh = await this.createAccount(game_key);
        bindAccount(fresh);
        if (!this.sessions.has(uuid) || w.ended) { this.releaseAccountSlotFor(w); return; }
        w.push({ status: "account_ready" });
      }
      if (!acc) return;
      this.recordUsage(apiKey);
      w.push({ status: "requesting_game" });
      let init = null;
      let accountRetries = 0;
      while (!init) {
        try { init = await this.doInitGame(session); }
        catch (e) {
          // Two reasons to try a different account: no play credits for this
          // game, and Raccoon refusing the account outright. Both mean the
          // player should never see the failure — there is a pool for this.
          if ((e && e.isDiamondError) || (e && e.accountRefused)) {
            if (!manualAccount && accountRetries < 2) {
              accountRetries++;
              console.log(`${e.accountRefused ? "account refused" : "no credits"} on ${uuid.slice(0, 8)} — trying another account (${accountRetries})`);
              w.push({ status: "creating_account" });
              // The account we are dropping is marked dead rather than recycled:
              // it cannot play the requested game, so handing it to the next player
              // would just move the same failure one seat along.
              session.account_dead = true;
              bindAccount(await this.createAccount(game_key));
              w.push({ status: "account_ready" });
              w.push({ status: "requesting_game" });
              continue;
            }
          }
          throw e;
        }
      }
      // Registration is done — including any play-credits retry above, which
      // registers another account and needs the same protection.
      this.releaseAccountSlotFor(w);
      if (!this.sessions.has(uuid) || w.ended) return;
      if (init.queued) {
        session.state = "queued";
        session.queue_id = init.queue_id;
        session.queue_abandon_at = Date.now() + QUEUE_ABANDON_MS;
        w.push({ status: "queue", uuid, queue_pos: init.initial_pos });
      } else {
        this.applyServerData(session, init.server_data);
        session.state = "finished_queue";
        session.finished_queue_at = Date.now();
        session.startgame_deadline = Date.now() + STARTGAME_DEADLINE_MS;
        w.push({ status: "finished_queue", uuid, fetch_this_within_30s_or_terminate: "/cloud/v1/startGame" });
      }
      if (Date.now() - startedAt > SETUP_DEADLINE_MS) console.log(`setup for ${uuid.slice(0, 8)} took over 5 min`);
    } catch (e) {
      this.releaseAccountSlotFor(w);
      console.log(`creation failed for ${uuid.slice(0, 8)} — ${e.message}`);
      w.push(this.sessionErrorEvent(e));
      this.killSession(uuid, "creation_error");
    } finally {      try { w.controller.close(); } catch {}
    }
  }

  handleGetQueue(ctx) {
    const uuid = ctx.url.searchParams.get("uuid");
    if (!uuid) return json({ error: "Missing uuid." }, 400);
    const session = this.sessions.get(uuid);
    if (!session) return json({ error: "Not found." }, 404);
    if (session.api_key !== ctx.apiKey) return json({ error: "Forbidden." }, 403);
    if (session.state !== "queued" && session.state !== "finished_queue") return json({ error: `Session is '${session.state}'` }, 400);
    const now = Date.now();
    if (session.last_queue_poll_at && now - session.last_queue_poll_at < 3000) return json({ error: "Poll every 3 seconds max." }, 429);
    session.last_queue_poll_at = now;
    session.queue_abandon_at = now + QUEUE_ABANDON_MS;
    if (session.state === "finished_queue") return json({ status: "finished_queue", uuid, fetch_this_within_30s_or_terminate: "/cloud/v1/startGame" });
    const self = this;
    const work = (async () => {
      const pos = await self.doPollQueue(session, session.queue_id);
      if (!self.sessions.has(uuid)) return json({ status: "queue", queue_pos: pos });
      if (pos === 0) {
        const serverData = await self.doClaimGame(session, session.queue_id);
        self.applyServerData(session, serverData);
        session.state = "finished_queue";
        session.finished_queue_at = Date.now();
        session.startgame_deadline = Date.now() + STARTGAME_DEADLINE_MS;
        self.ensureTicking();
        return json({ status: "finished_queue", uuid, fetch_this_within_30s_or_terminate: "/cloud/v1/startGame" });
      }
      return json({ status: "queue", queue_pos: pos });
    })();
    return work.catch((e) => json({ error: e.message }, 500));
  }

  handleStartGame(ctx) {
    const { uuid } = ctx.body || {};
    if (!uuid) return json({ error: "Missing uuid." }, 400);
    const session = this.sessions.get(uuid);
    if (!session) return json({ error: "Not found." }, 404);
    if (session.api_key !== ctx.apiKey) return json({ error: "Forbidden." }, 403);
    if (session.state !== "finished_queue") return json({ error: `Session is '${session.state}'` }, 400);
    session.startgame_deadline = 0;
    session.queue_abandon_at = 0;
    session.state = "active";
    session.game_started_at = Date.now();
    session.ping_deadline = Date.now() + PING_TIMEOUT_MS;
    session.session_deadline = Date.now() + session.max_session_seconds * 1000;
    session.next_cost_at = Date.now() + COST_INTERVAL_MS;
    const iceServers = [
      { urls: "stun:stun.l.google.com:19302" },
      ...(session.turns || []).map((t) => ({ urls: t.turn_url, username: t.turn_user, credential: t.turn_password })),
    ];
    const proto = ctx.url.protocol === "https:" ? "wss" : "ws";
    // The signaling socket is authenticated by this per-session token as well as
    // the uuid, so a leaked uuid can't be used to hijack somebody's stream.
    session.signal_token = generateSN();
    session.detached_at = 0;
    // reattaches is deliberately left undefined here: handleSignal counts the
    // first attach as 0, so pre-seeding it would make every launch look like a
    // reconnect.
    const signalingWs = `${proto}://${ctx.url.host}/cloud/v1/signal/${uuid}?t=${session.signal_token}`;
    session.embed_ice_servers = iceServers;
    session.embed_signaling_ws = signalingWs;
    console.log(`startGame ${session.game_key} → ${uuid.slice(0, 8)}`);
    this.connectRaccoonSignaling(session).catch((e) => console.log(`raccoon signaling failed: ${e.message}`));
    this.ensureTicking();
    return json({ ice_servers: iceServers, signaling_ws: signalingWs, max_seconds: session.max_session_seconds });
  }

  handlePingSession(ctx) {
    const { uuid } = ctx.body || {};
    if (!uuid) return json({ error: "Missing uuid." }, 400);
    const session = this.sessions.get(uuid);
    if (!session) return json({ error: "Not found." }, 404);
    if (session.api_key !== ctx.apiKey) return json({ error: "Forbidden." }, 403);
    if (session.state !== "active") return json({ error: "Not active." }, 400);
    const now = Date.now();
    if (session.last_ping_at && now - session.last_ping_at < 3000) return json({ error: "Ping every 3s max." }, 429);
    session.last_ping_at = now;
    session.ping_deadline = now + PING_TIMEOUT_MS;
    // Still pinging without a signaling socket means the tab is alive and trying
    // to reattach — keep its slot warm while it does.
    if (session.detached_at) session.detached_at = now;
    const usage = this.getUsageStats(ctx.apiKey);
    const limits = this.getSiteLimits(ctx.site);
    return json({
      session_time_used_seconds: Math.floor((now - session.game_started_at) / 1000),
      session_time_limit_seconds: session.max_session_seconds,
      quota: {
        minute: { used: usage.perMin, limit: limits.per_minute },
        hour: { used: usage.perHour, limit: limits.per_hour },
        day: { used: usage.perDay, limit: limits.per_day },
        month: { used: usage.perMonth, limit: limits.per_month },
      },
    });
  }

  handleQuitSession(ctx) {
    const { uuid } = ctx.body || {};
    if (!uuid) return json({ error: "Missing uuid." }, 400);
    const session = this.sessions.get(uuid);
    if (!session) return json({ error: "Not found." }, 404);
    if (session.api_key !== ctx.apiKey) return json({ error: "Forbidden." }, 403);
    this.killSession(uuid, "quit_requested");
    return json({ status: "ok" });
  }

  // ══ Presence ════════════════════════════════════════════════════════════
  onlineCount() {
    const now = Date.now();
    let n = 0;
    for (const seen of this.presence.values()) if (now - seen <= PRESENCE_TTL_MS) n++;
    return n;
  }
  handleHeartbeat(ctx) {
    const id = (ctx.body || {}).client_id;
    if (typeof id === "string" && id.length >= 8 && id.length <= 64) this.presence.set(id, Date.now());
    this.ensureTicking();
    return json({ online: this.onlineCount() });
  }

  // ══ Mail endpoints ══════════════════════════════════════════════════════
  async handleCreateMailbox() {
    let lastErr = null;
    let refusedDomain = false;
    // Two passes: a lane hands out one of its domains at a time, so a domain the
    // screen just retired is replaced by the next one the lane owns. Without the
    // screen a player paid for the refusal with a solved puzzle and then read a
    // sentence about temporary email addresses on their own screen.
    for (let pass = 0; pass < 2; pass++) {
      for (const lane of this.laneOrder()) {
        try {
          const { email, handle } = await lane.create();
          if (!(await this.screenMailDomain(email))) { refusedDomain = true; continue; }
          return json({ email, ...handle });
        } catch (e) { lastErr = e; this.noteProviderFail(lane.id, e); }
      }
    }
    // Every usable domain is refused: that is a known, actionable situation, not
    // "we are busy" — so it says so instead of quoting a provider or Raccoon.
    if (!lastErr) return json({ error: MAIL_REFUSED_MESSAGE, needOwnAccount: true }, refusedDomain ? 503 : 500);
    if (refusedDomain) console.log(`createMailbox: at least one domain was refused (last error: ${lastErr.message})`);
    return json({ error: playerMessage(lastErr) }, 500);
  }
  async handleGetCode(ctx) {
    const body = ctx.body || {};
    let lane = null;
    if (body.lane === "tempmail.lol" && body.mailToken) lane = this.tempmailLolLane;
    else if (body.lane === "domain" && body.email && this.domainLane) lane = this.domainLane;
    else if (body.lane === "mailtm" || (!body.lane && body.mailJwt)) {
      const base = typeof body.base === "string" && this.MAIL_PROVIDERS.includes(body.base) ? body.base : this.MAIL_PROVIDERS[0];
      lane = this.mailtmLane(base);
      body.base = base;
    }
    if (!lane) return json({ error: "Missing mailbox handle." }, 400);
    try { return json({ code: await lane.read(body) }); }
    catch (e) { return json({ error: e.message }, 500); }
  }
  // ══ Registration puzzle (Raccoon's human check) ══════════════════════════
  // Email registration is gated: the client asks for a challenge, a human drags
  // the piece into the gap, and the server marks that `sn` verified before it
  // will send a registration code. The Worker does not solve this and must not —
  // what it does is fetch the challenge and hand it to the player's own browser,
  // exactly as raccoongame.com does, so the human check reaches a human. The sn
  // returned here has to be reused by sendEmail/emailRegister: the verification
  // is bound to it, so a fresh sn means starting over.
  //
  // Raccoon rate-limits the puzzle too ("Too many puzzle attempts", 180s window)
  // and reports it with the same shape as a refusal, so both endpoints surface
  // `retry_after_seconds` for the UI to count down instead of retrying into it.
  puzzleRetryAfter(data) {
    const n = Number(data && data.data && data.data.retry_after_seconds);
    return Number.isFinite(n) && n > 0 ? Math.ceil(n) : null;
  }
  async handleCaptchaChallenge(ctx) {
    const email = String((ctx.body || {}).email || "").trim();
    if (!email) return json({ error: "Enter an email address first." }, 400);
    const key = this.puzzleKey(email);

    // Already solved, and recently enough that Raccoon still holds it. The
    // player is not asked to drag anything a second time — that is the whole
    // point of remembering the result: a retried code request, a reopened tab
    // or a dropped connection must not cost another human check.
    const solved = this.verifiedSnFor(key);
    if (solved) {
      console.log(`puzzle: reusing a solved check for ${email}`);
      return json({ sn: solved, email, verified: true, reusedVerification: true });
    }

    // A challenge this player already has on screen is the right answer to
    // "give me the check". Asking Raccoon again would replace the image they may
    // be aiming at AND spend another request from the shared IP budget.
    const held = this.puzzleChallenges.get(key);
    if (held && Date.now() - held.at < PUZZLE_REUSE_MS && this.raccoonSessions.has(held.sn)) {
      return json({ ...held.payload, sn: held.sn, email, reused: true });
    }

    // Single-flight per address: a double tap, a retry and a re-render used to be
    // three challenges, and three challenges is a visible slice of an hourly
    // limit shared by every player this Worker serves. This is checked *before*
    // the budget, so a waiting caller does not spend a second slot.
    //
    // The shared value is the *answer*, not a Response: a Response body can only
    // be read once, so handing the same object to two waiting requests would
    // fail the second one with "Body has already been read".
    const pending = this.puzzleInflight.get(key);
    if (pending) { const out = await pending; return json(out.body, out.status); }

    // No new ask while Raccoon has told us to stop. This is the line that keeps a
    // reported 591-second wait from turning into 3543: every extra ask restarts
    // the window, and the old Worker asked on every click.
    const lockedFor = this.puzzleBlockRemaining();
    if (lockedFor > 0) {
      const out = this.puzzleUnavailable(lockedFor, "The game service is limiting human checks.");
      return json(out.body, out.status);
    }
    // And no more than the local budget allows, so the shared allowance cannot be
    // spent in one rush and taken away from the next player.
    if (!this.takePuzzleBudget()) {
      const out = this.puzzleUnavailable(this.puzzleBudgetWait(), "Human checks are busy right now.");
      return json(out.body, out.status);
    }

    const work = this.fetchPuzzleChallenge(email, key);
    this.puzzleInflight.set(key, work);
    const clear = () => this.puzzleInflight.delete(key);
    work.then(clear, clear);
    const out = await work;
    return json(out.body, out.status);
  }
  puzzleKey(email) { return String(email || "").trim().toLowerCase(); }
  // ── The shared budget ────────────────────────────────────────────────────
  // Raccoon's ceiling is per egress IP. Every ask comes from this Worker, so
  // "a player clicked twice" and "the site used up its allowance" are the same
  // event. These three hold the line: a local cap on *new* challenges, a
  // remembered lockout that survives eviction, and one shape for the answer so
  // the site always shows a wait instead of a slider that cannot pass.
  puzzleBlockRemaining() { return Math.max(0, Math.ceil((this.puzzleBlockedUntil - Date.now()) / 1000)); }
  notePuzzleBlocked(seconds, why) {
    const secs = Math.min(PUZZLE_BLOCK_MAX_MS / 1000, Math.max(30, Number(seconds) || 0));
    const until = Date.now() + secs * 1000;
    // Never shorten an existing lockout on the strength of a smaller number.
    if (until <= this.puzzleBlockedUntil) return;
    this.puzzleBlockedUntil = until;
    this.state.waitUntil(this.storage.put("puzzleBlockedUntil", until).catch(() => {}));
    console.log(`human check locked out for ${Math.ceil(secs)}s (${String(why || "").slice(0, 80)}) — no more asks until then`);
  }
  takePuzzleBudget() {
    const now = Date.now();
    this.puzzleIssueTimes = this.puzzleIssueTimes.filter((t) => t > now - PUZZLE_ISSUE_WINDOW_MS);
    if (this.puzzleIssueTimes.length >= PUZZLE_ISSUE_MAX) return false;
    this.puzzleIssueTimes.push(now);
    return true;
  }
  puzzleBudgetWait() {
    const oldest = this.puzzleIssueTimes[0];
    if (!oldest) return 60;
    return Math.max(30, Math.ceil((oldest + PUZZLE_ISSUE_WINDOW_MS - Date.now()) / 1000));
  }
  // One response shape for "there is no check available right now", so the site
  // has a single thing to recognise and a player has one thing to read.
  puzzleUnavailable(seconds, why) {
    const secs = Math.max(30, Math.ceil(Number(seconds) || 60));
    return {
      status: 200,
      body: {
        error: `${why || "Human checks are temporarily unavailable."} Try again in ${secs} seconds.`,
        retry_after_seconds: secs,
        blocked: secs > 120,
        puzzle_blocked: true,
      },
    };
  }
  // The sn of a solved, still-fresh check for this address, or null.
  verifiedSnFor(key) {
    const now = Date.now();
    for (const [sn, v] of this.verifiedPuzzles) {
      if (now - v.at > PUZZLE_VERIFIED_TTL_MS) { this.verifiedPuzzles.delete(sn); continue; }
      if (v.email === key) return sn;
    }
    return null;
  }
  async fetchPuzzleChallenge(email, key) {
    const sn = generateSN();
    const t0 = Date.now();
    try {
      const r = await this.raccoonFetch(`/users/emailRegisterCaptcha?email=${encodeURIComponent(email)}&sn=${sn}&t=${Date.now()}`, {
        headers: { "user-agent": BROWSER_UA, "x-requested-with": "XMLHttpRequest" },
      });
      // Keep the session this challenge was issued into — the verify and the
      // registration that follows are only valid inside it.
      this.captureRaccoonSession(sn, r);
      const d = await r.json().catch(() => null);
      if (!d || d.status !== 200 || !d.data || !d.data.challenge_id) {
        const retryAfter = this.puzzleRetryAfter(d);
        const msg = (d && d.msg) || "Could not load the verification.";
        console.log(`puzzle challenge refused for ${email} (HTTP ${r.status}): ${JSON.stringify(d).slice(0, 160)}`);
        // Raccoon's own "stop" — remember it, and let nothing ask again until it
        // expires. Without this every retry pushed the lockout further out.
        if (retryAfter) this.notePuzzleBlocked(retryAfter, msg);
        else if (r.status === 429) this.notePuzzleBlocked(300, msg);
        // A refusal means whatever we were holding for this address is not
        // usable either — otherwise the next call would be answered with the
        // same dead challenge and burn the other's time.
        this.puzzleChallenges.delete(key);
        return {
          status: 200,
          body: {
            error: msg,
            retry_after_seconds: retryAfter,
            // A wait measured in minutes is not something the modal can sit on:
            // Raccoon's own limit is an hour, and pretending the player can wait
            // it out with a disabled slider is what made this feel broken.
            blocked: !!retryAfter && retryAfter > 120,
          },
        };
      }
      const c = d.data;
      const payload = {
        ms: Date.now() - t0,
        challenge: {
          challenge_id: c.challenge_id, background: c.background, piece: c.piece,
          width: c.width, height: c.height, piece_size: c.piece_size, piece_y: c.piece_y,
        },
      };
      this.puzzleChallenges.set(key, { sn, payload, at: Date.now() });
      this.pruneRaccoonSessions();
      this.state.waitUntil(this.savePuzzleState());
      return { status: 200, body: { sn, email, ...payload } };
    } catch (e) { return { status: 500, body: { error: e.message } }; }
  }
  async handleCaptchaVerify(ctx) {
    const { email, sn, challenge_id, offset } = ctx.body || {};
    if (!email || !sn || !challenge_id || offset === undefined || offset === null) {
      return json({ error: "Missing puzzle fields." }, 400);
    }
    const key = this.puzzleKey(email);
    try {
      const r = await this.raccoonFetch("/users/emailRegisterCaptchaVerify", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
          "user-agent": BROWSER_UA,
          "x-requested-with": "XMLHttpRequest",
          // Without this the answer is always "The puzzle has expired": the
          // challenge lives in the session, and the session is the cookie.
          ...this.raccoonSessionHeader(sn),
        },
        body: new URLSearchParams({ email, sn, challenge_id: String(challenge_id), offset: String(offset) }),
      });
      this.captureRaccoonSession(sn, r); // it may rotate the session on success
      const d = await r.json().catch(() => null);
      if (d && d.status === 200) {
        // Remember the pass so a retried code request does not send the player
        // back to the slider (see verifiedSnFor).
        this.verifiedPuzzles.set(sn, { email: key, at: Date.now() });
        this.puzzleChallenges.delete(key);
        this.pruneRaccoonSessions();
        this.state.waitUntil(this.savePuzzleState());
        return json({ verified: true, sn });
      }
      const msg = (d && d.msg) || "Verification failed.";
      const retryAfter = this.puzzleRetryAfter(d);
      // Say which refusal this is, in a shape the site can act on. A wrong drag
      // is answered by letting the player aim again; only an expired challenge
      // needs a new one, and only a rate limit needs a wait. Before this the
      // site treated all three the same way — fetch another challenge — which is
      // how one careful player could empty the shared budget by themselves.
      const expired = /expired|refresh/i.test(msg);
      const mismatch = /does not match|not match|wrong position|not quite/i.test(msg);
      console.log(`puzzle verify refused (HTTP ${r.status}, ${expired ? "expired" : mismatch ? "wrong offset" : "other"}): ${JSON.stringify(d).slice(0, 160)}`);
      if (expired || retryAfter) this.puzzleChallenges.delete(key);
      return json({
        verified: false,
        error: msg,
        expired,
        mismatch,
        blocked: !!retryAfter && retryAfter > 120,
        retry_after_seconds: retryAfter,
      });
    } catch (e) { return json({ error: e.message }, 500); }
  }
  async handleSendEmail(ctx) {
    const { email, password } = ctx.body || {};
    if (!email || !password) return json({ error: "Missing email or password." }, 400);
    // The caller passes back the sn it solved the puzzle with; generating a new
    // one here would throw the verification away and get the refusal again.
    const sn = String((ctx.body || {}).sn || "").trim() || generateSN();
    try {
      const r = await this.raccoonFetch("/users/sendEmail", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": BROWSER_UA,
          // The verified `sn` is recorded in the session, so this call has to
          // arrive inside that same session or the registration is refused with
          // "Please complete the puzzle verification." even though it was just
          // completed — which is exactly what the player was seeing.
          ...this.raccoonSessionHeader(sn),
        },
        body: new URLSearchParams({ email, type: "register", sn, model: "Chrome/147.0.0.0", version_code: "1", version_name: "1.0.0", device_name: "GhostCloud", os: "web" }),
      });
      this.captureRaccoonSession(sn, r);
      const data = await r.json().catch(() => ({}));
      console.log(`sendEmail ${email} → HTTP ${r.status} ${JSON.stringify(data)}`);
      if (data.status && data.status !== 200) {
        const msg = data.msg || `Raccoon rejected: ${JSON.stringify(data)}`;
        // The refusal is about the *address*, not the check: Raccoon treats the
        // free providers' domains as disposable. Reported as its own case so the
        // site can take another mailbox instead of printing this at the player,
        // and remembered so no later player is handed the same domain.
        const tempBlocked = this.isTempBlockedMessage(msg);
        if (tempBlocked) this.markDomainBlocked(email, msg);
        return json({
          error: tempBlocked ? MAIL_REFUSED_MESSAGE : msg,
          raccoon: data,
          needMailbox: tempBlocked,
          // Tells the site to open the puzzle instead of showing an error: the
          // refusal is a human check, not a broken state.
          needVerification: !tempBlocked && this.isRaccoonWall(msg),
          retry_after_seconds: this.puzzleRetryAfter(data),
        }, 400);
      }
      return json({ sn, raccoon: data });
    } catch (e) { return json({ error: e.message }, 500); }
  }
  // Hand a working account to the shared pool. Raccoon's puzzle means every new
  // account costs a human a few seconds of dragging, so one solved account should
  // serve as many games as possible instead of dying with the session that made
  // it. Optional GHOSTCLOUD_SEED_KEY keeps strangers from filling the pool with
  // junk (the site's API key is public, so it cannot be the only gate).
  async handleSeedPool(ctx) {
    const { sn, token } = ctx.body || {};
    if (!sn || !token) return json({ error: "Missing sn or token." }, 400);
    if (this.SEED_KEY && ctx.request.headers.get("x-seed-key") !== this.SEED_KEY) {
      return json({ error: "Bad seed key." }, 403);
    }
    if (this.pool.some((a) => a.token === token)) return json({ seeded: false, reason: "already in the pool", pool: this.pool.length });
    if (this.pool.length >= this.POOL_TARGET) return json({ seeded: false, reason: "pool already full", pool: this.pool.length });
    this.pool.push({ sn, token, plays: 0 });
    console.log(`pool: seeded by a player — ${this.pool.length}/${this.POOL_TARGET}`);
    this.state.waitUntil(this.savePool());
    this.ensureTicking();
    return json({ seeded: true, pool: this.pool.length, target: this.POOL_TARGET });
  }
  async handleManualRegister(ctx) {
    const { sn, email, password, code, phone, country } = ctx.body || {};
    if (!sn || !email || !password || !code) return json({ error: "Missing sn, email, password or code." }, 400);
    const base = { sn, model: "Chrome/147.0.0.0", version_code: "1", version_name: "1.0.0", device_name: "GhostCloud", os: "web" };
    const headers = { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "Mozilla/5.0 Chrome/147.0.0.0 Safari/537.36", ...this.raccoonSessionHeader(sn) };
    try {
      const regRes = await this.raccoonFetch("/users/emailRegister", { method: "POST", headers, body: new URLSearchParams({ email, code, password, phone: phone || "1", country: country || "Brazil", ...base }) });
      // The register response used to be thrown away, so a refusal here surfaced
      // as a bare "Login failed" — or, worse, as Raccoon's own sentence about a
      // human check the player had no way to see. Raccoon binds the verification
      // to `sn`, so an sn that went stale between the puzzle and this call is
      // refused with that same sentence; the fix is to say so and let the site
      // re-open the check. Deliberately NOT noteRaccoonWall(): a stale sn is one
      // attempt failing, not the service-wide wall, and pausing every
      // registration for 10 minutes over it would be a much bigger outage.
      // Raccoon rotates the session on every response; keep the newest one so the
      // login call that follows registers in the same session it was created in.
      this.captureRaccoonSession(sn, regRes);
      const regRejected = this.raccoonRejectedMail(await regRes.json().catch(() => null));
      if (regRejected) {
        // A refused address first: Raccoon says "Temporary email addresses are
        // not supported." for a whole domain, which is nothing the player did and
        // nothing the check can fix — so it rotates on the site instead of being
        // forwarded as their error.
        const tempBlocked = this.isTempBlockedMessage(regRejected);
        if (tempBlocked) this.markDomainBlocked(email, regRejected);
        const wall = !tempBlocked && this.isRaccoonWall(regRejected);
        // The code, not the check. Since 2026-10-14 Raccoon's register no longer
        // asks for the puzzle, so a code complaint is answered with a *new code*
        // — sending the player back to the puzzle would spend another human
        // solve on a step that is already done, and it cannot fix the code.
        const codeBad = !wall && !tempBlocked && this.raccoonCodeRejected(regRejected);
        console.log(`manualRegister refused for ${email} (${tempBlocked ? "mailbox" : codeBad ? "code" : wall ? "check" : "other"}): ${regRejected}`);
        return json({
          error: tempBlocked ? MAIL_REFUSED_MESSAGE
            : wall ? "The human check went stale before the account was made — solve it again and the code comes with it."
            : regRejected,
          raccoon: regRejected,
          needMailbox: tempBlocked,
          needVerification: wall,
          needCode: codeBad,
          retry_after_seconds: null,
        }, 400);
      }
      const loginRes = await this.raccoonFetch("/users/emailLogin", { method: "POST", headers, body: new URLSearchParams({ email, password, ...base }) });
      this.captureRaccoonSession(sn, loginRes);
      const loginData = await parseJsonResponse(loginRes, "Raccoon login");
      if (loginData.status !== 200) {
        // Report what Raccoon actually said. "Login failed" hid every reason —
        // a blocklisted domain, a taken address, a wrong password — behind one
        // sentence that told the player nothing they could act on.
        const why = loginData.msg || "The game service refused the login after registering.";
        console.log(`manualRegister login refused for ${email}: ${why}`);
        return json({ error: why, raccoon: loginData, needVerification: this.isRaccoonWall(why) }, 400);
      }
      let userToken = loginData.data?.user_token || "";
      const cookie = loginRes.headers.get("set-cookie");
      if (cookie) { const m = cookie.match(/as_user_token=([^;]+)/); if (m) userToken = m[1]; }
      if (!userToken) throw new Error("No user token returned");
      return json({ sn, token: userToken });
    } catch (e) { return json({ error: e.message }, 500); }
  }
  async handleInbound(request) {
    if (!this.INBOUND_KEY) return json({ error: "Inbound mail is not configured on this server." }, 503);
    const url = new URL(request.url);
    const key = request.headers.get("x-ghostcloud-key") || url.searchParams.get("key");
    if (key !== this.INBOUND_KEY) return json({ error: "Bad inbound key." }, 401);
    const body = await request.json().catch(() => ({}));
    const to = String(body.to || "").trim().toLowerCase();
    const text = `${body.subject || ""} ${body.text || ""} ${body.html || ""}`.replace(/<[^>]*>/g, " ");
    const code = codeFromText(text);
    if (to && code) {
      this.inboundCodes.set(to, { code, at: Date.now() });
      console.log(`inboundMail ${to} → code received`);
    } else {
      console.log(`inboundMail ${to || "(no recipient)"} → no code found`);
    }
    return json({ ok: true, stored: Boolean(to && code) });
  }

  // ══ Pro ═════════════════════════════════════════════════════════════════
  handleActivatePro(ctx) {
    if (!this.PRO_CODE) return json({ error: "Pro is not configured yet — try again later." }, 503);
    const ip = ctx.ip;
    const now = Date.now();
    const attempts = (this.proAttempts.get(ip) || []).filter((x) => x > now - 60000);
    if (attempts.length >= 5) return json({ error: "Too many attempts. Try again later." }, 429);
    this.proAttempts.set(ip, [...attempts, now]);
    const code = String((ctx.body || {}).code || "").trim();
    if (!code || code !== this.PRO_CODE) return json({ error: "Invalid code." }, 401);
    const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
    this.proTokens.set(token, { exp: Date.now() + 30 * 24 * 3600 * 1000, epoch: this.PRO_EPOCH });
    this.state.waitUntil(this.storage.put("proTokens", [...this.proTokens]).catch(() => {}));
    return json({ ok: true, token, subDailySeconds: this.PRO_DAILY_SECONDS });
  }
  handleVerifyPro(ctx) {
    const token = String((ctx.body || {}).token || "");
    const v = this.proTokens.get(token);
    if (!token || !v || v.epoch !== this.PRO_EPOCH || Date.now() > v.exp) {
      if (token) this.proTokens.delete(token);
      return json({ active: false });
    }
    this.proTokens.set(token, { exp: Date.now() + 30 * 24 * 3600 * 1000, epoch: this.PRO_EPOCH });
    this.state.waitUntil(this.storage.put("proTokens", [...this.proTokens]).catch(() => {}));
    return json({ active: true, subDailySeconds: this.PRO_DAILY_SECONDS });
  }

  // ══ Diagnostics ═════════════════════════════════════════════════════════
  async handleDiagMail(ctx) {
    const out = {
      lanes: this.allLanes().map((l) => l.id),
      ownDomain: this.MAIL_DOMAIN || "(not configured)",
      pool: `${this.pool.length}/${this.POOL_TARGET}`,
      // How much of the fleet is recycled. A pool that is mostly `reused` is the
      // sign that registration volume has dropped away as intended.
      reuse: {
        enabled: this.ACCOUNT_REUSE,
        ready: this.pool.length,
        fresh: this.pool.filter((a) => !(a.plays || 0)).length,
        reused: this.pool.filter((a) => (a.plays || 0) > 0).length,
        totalPlays: this.pool.reduce((n, a) => n + (a.plays || 0), 0),
      },
      blockedDomains: [...this.blockedMailDomains],
      // Non-zero means Raccoon's wall was seen recently and registrations are
      // paused, so no amount of retrying will start a game.
      raccoonWallCooldownSeconds: Math.max(0, Math.ceil((this.raccoonWalledUntil - Date.now()) / 1000)),
      // Last error per lane. Without this the only way to find out which lane is
      // wedged — and why — was a live `wrangler tail`.
      laneStats: Object.fromEntries(this.allLanes().map((l) => {
        const st = this.providerStats.get(l.id) || { ok: 0, fail: 0, lastErr: null };
        const h = this.providerHealth.get(l.id) || {};
        return [l.id, {
          ok: st.ok, fail: st.fail, lastErr: st.lastErr,
          skippedUntil: h.skipUntil > Date.now() ? new Date(h.skipUntil).toISOString() : null,
        }];
      })),
    };
    for (const base of this.MAIL_PROVIDERS) {
      const t0 = Date.now();
      try {
        const r = await fetchWithTimeout(`${base}/domains`, {}, 15000);
        const t = await r.text();
        out[base] = { status: r.status, ms: Date.now() - t0, body_len: t.length, body_head: t.slice(0, 120) };
      } catch (e) { out[base] = { error: e.message }; }
    }
    // Can an account be created at all right now? `sendEmail` is the first
    // Raccoon call registration makes. The address is deliberately a reserved
    // one (@example.com), so no mail is delivered anywhere — this only asks
    // Raccoon whether it is willing to talk to us.
    const t0 = Date.now();
    try {
      const r = await this.raccoonFetch("/users/sendEmail", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "Mozilla/5.0 Chrome/147.0.0.0 Safari/537.36" },
        body: new URLSearchParams({
          email: `rcn_health_${Math.random().toString(36).slice(2, 9)}@example.com`,
          type: "register", sn: generateSN(), model: "Chrome/147.0.0.0", version_code: "1",
          version_name: "1.0.0", device_name: "GhostCloud", os: "web",
        }),
      });
      const d = await r.json().catch(() => null);
      out.raccoon = {
        http: r.status, ms: Date.now() - t0,
        reply: (d && (d.msg || d.status)) || "(empty body)",
        walled: this.isRaccoonWall(d && d.msg),
      };
    } catch (e) { out.raccoon = { error: e.message, ms: Date.now() - t0 }; }
    return json(out);
  }
  handleEmbedData(ctx) {
    const id = ctx.url.searchParams.get("id");
    if (!id) return json({ error: "Missing id." }, 400);
    const session = this.sessions.get(id);
    if (!session) return json({ error: "Not found." }, 404);
    if (session.state !== "active") return json({ error: "Not active." }, 400);
    return json({ ice_servers: session.embed_ice_servers, signaling_ws: session.embed_signaling_ws });
  }

  // ══ WebSocket signaling relay ══════════════════════════════════════════
  // This socket carries offers and ICE candidates only — the media itself goes
  // from the game server straight to the player. Losing it therefore does NOT
  // mean the game is over: the session is held for CLIENT_REATTACH_GRACE_MS so
  // the client can attach a new socket to the SAME session rather than lose its
  // slot and re-queue behind everybody else.
  handleSignal(request, uuid) {
    if ((request.headers.get("upgrade") || "").toLowerCase() !== "websocket") return json({ error: "Expected WebSocket upgrade." }, 426);
    const session = this.sessions.get(uuid);
    if (!session || session.state !== "active") return json({ error: "Not active." }, 404);
    const token = new URL(request.url).searchParams.get("t") || "";
    if (session.signal_token && token !== session.signal_token) return json({ error: "Bad signaling token." }, 403);
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    // Attach first, then retire the old pipe: the superseded socket's close
    // handler checks whether it is still the current one, so replacing it here
    // is what stops a reattach from being killed by its own predecessor.
    const previous = session.clientWs;
    session.clientWs = server;
    session.detached_at = 0;
    session.reattaches = typeof session.reattaches === "number" ? session.reattaches + 1 : 0;
    if (previous && previous !== server) { try { previous.close(4000, "reattached"); } catch {} }
    if (session.reattaches > 0) console.log(`session ${uuid.slice(0, 8)} signaling reattached (#${session.reattaches})`);
    // The client's own countdown can be minutes off after a reconnect (a
    // suspended tab, a long tunnel), so hand it the server's real numbers.
    try {
      server.send(JSON.stringify({
        type: "signal_ready",
        max_seconds: session.max_session_seconds,
        remaining_seconds: Math.max(0, Math.round((session.session_deadline - Date.now()) / 1000)),
        reattached: session.reattaches > 0,
      }));
      // If the launch already got this far, say so again — the original frame
      // may have gone to the socket that just died.
      if (session.game_ready_sent) server.send(JSON.stringify({ type: "game_ready" }));
    } catch {}
    const self = this;
    server.addEventListener("message", (event) => {
      let msg;
      try { msg = JSON.parse(typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data)); } catch { return; }
      const rws = session.raccoonWs;
      if (!rws || rws.readyState !== WS_OPEN) {
        // The relay to the game server is gone, so nothing the player sends can
        // reach the game — and the client cannot see this at all (its own socket
        // to us is still open). Log it: this is the silent failure that looks
        // like "the stream just stopped" in the browser.
        if (!session.rwsDownLogged) {
          session.rwsDownLogged = true;
          console.log(`session ${uuid.slice(0, 8)} cannot relay — raccoon socket is down`);
        }
        return;
      }
      try {
        if (msg.type === "rtc_offer" && msg.sdp) {
          rws.send(JSON.stringify({ id: "rtc_sdp", from: session.sn, to: session.gl_key, body: { sdp: msg.sdp, type: "offer" } }));
        } else if (msg.type === "rtc_candidate" && msg.candidate) {
          rws.send(JSON.stringify({ id: "rtc_sdp", from: session.sn, to: session.gl_key, body: { type: "candidate", sdp: msg.candidate } }));
        }
      } catch (e) { console.log(`client ws relay error: ${e.message}`); }
    });
    server.addEventListener("close", () => {
      // A superseded socket closing is not the session ending.
      if (session.clientWs !== server) return;
      session.clientWs = null;
      if (self.sessions.get(uuid) !== session) return;
      // Hold the session open instead of killing it: the game is still running
      // on the server and the player may be back in a second. The tick loop
      // reaps it if nobody reattaches.
      session.detached_at = Date.now();
      console.log(`session ${uuid.slice(0, 8)} signaling detached — holding the slot for ${Math.round(CLIENT_REATTACH_GRACE_MS / 1000)}s`);
    });
    server.addEventListener("error", () => console.log("client ws error"));
    return new Response(null, { status: 101, webSocket: client });
  }

  async connectRaccoonSignaling(session) {
    const { sn, gl_key, play_config, uuid } = session;
    const raccoonWs = new WebSocket(session.message_server.url);
    session.raccoonWs = raccoonWs;
    const rSend = (p) => { try { if (raccoonWs.readyState === WS_OPEN) raccoonWs.send(JSON.stringify(p)); } catch {} };
    const toClient = (data) => { try { if (session.clientWs && session.clientWs.readyState === WS_OPEN) session.clientWs.send(JSON.stringify(data)); } catch {} };
    raccoonWs.addEventListener("open", () => {
      session.rwsDownLogged = false;
      rSend({ id: "register", type: "webUA", uid: sn, token: decodeURIComponent(session.message_server.token) });
      // The 30s keep-alive ping is driven by the tick loop instead of
      // setInterval: a DO can be evicted and its timers silently vanish.
      session.rSend = rSend;
      session.next_raccoon_ping_at = Date.now() + 30000;
    });
    raccoonWs.addEventListener("message", (event) => {
      let data;
      try { data = JSON.parse(typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data)); } catch { return; }
      if (data.id === "rtc_sdp" && data.body?.code) console.log(`RTC_SDP: code=${data.body.code} msg=${data.body.msg || ""}`);
      switch (data.id) {
        case "register_ack":
          if (data.code === 200) {
            rSend({
              id: "start_game", from: sn, to: gl_key, game_args: "", gp_num: 0, play_config, simpleHandler: null,
              body: { force_soft_dec: 0, session_id: session.bs_sc_id, sn_user_id: sn, game_name: null, joystick_num: 2 },
            });
          }
          break;
        case "start_game":
          if (data.from === gl_key && data.body?.code === 200) {
            // Remember it: if the player's socket dies before this arrives, a
            // reattach can be handed the same news instead of waiting forever.
            session.game_ready_sent = true;
            toClient({ type: "game_ready" });
          }
          break;
        case "rtc_sdp": {
          const b = data.body;
          if (!b) break;
          if (b.type === "answer") toClient({ type: "rtc_answer", sdp: b });
          else if (b.type === "candidate" && b.sdp) toClient({ type: "rtc_candidate", candidate: b.sdp });
          break;
        }
      }
    });
    raccoonWs.addEventListener("close", (event) => {
      session.rSend = null;
      // If this fires while the session is active, the relay is dead and the
      // player's picture is about to freeze for no reason they can see.
      console.log(`raccoon ws closed for ${uuid.slice(0, 8)} code=${event && event.code} reason=${(event && event.reason) || ""} session_state=${session.state}`);
    });
    raccoonWs.addEventListener("error", () => console.log(`signal error on ${uuid.slice(0, 8)}`));
  }
}

// ── Worker entry: everything is handled by the single Hub object ────────────
export default {
  async fetch(request, env) {
    const id = env.HUB.idFromName("hub");
    return env.HUB.get(id).fetch(request);
  },
};
