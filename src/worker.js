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
const MAX_SESSION_SECONDS = 19 * 60;
const DEFAULT_SESSION_SECONDS = 19 * 60;
const WS_OPEN = 1;

const TICK_MS = 3000;                    // maintenance tick while work exists
const COST_INTERVAL_MS = 25000;
const POOL_FILL_INTERVAL_MS = 20000;
const POOL_FILL_STARTUP_GRACE_MS = 3000;
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
    if (res.status >= 500) throw new Error(`${what} is briefly unavailable right now (HTTP ${res.status}) — try again in a moment.`);
    throw new Error(`${what} is at capacity right now (HTTP ${res.status}) — please try again in a moment.`);
  }
  const t = await res.text();
  if (!t) throw new Error(`${what} is under heavy load right now and sent no response — try again in a moment.`);
  try { return JSON.parse(t); }
  catch { throw new Error(`${what} sent an invalid response — try again in a moment.`); }
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
    this.POOL_TARGET = Math.min(Math.max(parseInt(env.GHOSTCLOUD_POOL_TARGET || "10", 10) || 10, 3), 20);
    this.MAIL_PROVIDERS = (env.GHOSTCLOUD_MAIL_PROVIDERS || "https://api.duckmail.sbs,https://api.mail.gw")
      .split(",").map((s) => s.trim()).filter(Boolean);
    this.MAIL_DOMAIN = (env.GHOSTCLOUD_MAIL_DOMAIN || "").trim().toLowerCase();
    this.TEMPMAILLOL_ENABLED = env.GHOSTCLOUD_TEMPMAILLOL !== "off";
    this.PRO_CODE = env.GHOSTCLOUD_PRO_CODE || "";
    this.PRO_EPOCH = env.GHOSTCLOUD_PRO_EPOCH || "1";
    this.PRO_DAILY_SECONDS = 8 * 3600;
    this.INBOUND_KEY = env.GHOSTCLOUD_INBOUND_KEY || "";

    // ── live state (in memory while the object is active) ──
    this.sessions = new Map();
    this.pool = [];
    this.presence = new Map();
    this.siteUsage = new Map();
    this.ipLimits = new Map();
    this.embedIpLimits = new Map();
    this.accountCreating = new Map();
    this.capacityWaiters = [];
    this.proTokens = new Map();
    this.proAttempts = new Map();
    this.inboundCodes = new Map();
    this.blockedMailDomains = new Set();
    this.providerHealth = new Map();
    this.providerStats = new Map();
    this.lastQueueBroadcastAt = 0;
    this.nextPoolFillAt = Date.now() + POOL_FILL_STARTUP_GRACE_MS;
    this.poolFillFails = 0;
    this.alarmAt = 0;
    this.lastDashboardAt = 0;
    this.lastPresenceSweepAt = 0;
    this.poolFilling = false;

    // ── durable bits (survive eviction between deploys) ──
    this.ready = state.blockConcurrencyWhile(async () => {
      try {
        const savedPool = await this.storage.get("pool");
        if (Array.isArray(savedPool)) this.pool = savedPool.filter((a) => a && a.sn && a.token);
        const savedPro = await this.storage.get("proTokens");
        if (Array.isArray(savedPro)) this.proTokens = new Map(savedPro);
        const savedBlocked = await this.storage.get("blockedDomains");
        if (Array.isArray(savedBlocked)) this.blockedMailDomains = new Set(savedBlocked);
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
    if (path === "/healthz" || path === "/") return json({ status: "ok", name: "ghostcloud-api" });
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
      case "/cloud/v1/activatePro": return this.handleActivatePro(ctx);
      case "/cloud/v1/verifyPro": return this.handleVerifyPro(ctx);
      case "/cloud/v1/diagMail": return this.handleDiagMail(ctx);
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
  acquireAccountSlot(apiKey, site) {
    const cap = (site.max_concurrent_sessions ?? 5) * 2;
    const current = this.accountCreating.get(apiKey) ?? 0;
    if (current >= cap) return false;
    this.accountCreating.set(apiKey, current + 1);
    return true;
  }
  releaseAccountSlot(apiKey) {
    const current = this.accountCreating.get(apiKey) ?? 1;
    const next = current - 1;
    if (next <= 0) this.accountCreating.delete(apiKey);
    else this.accountCreating.set(apiKey, next);
  }

  // ══ Mail lanes ══════════════════════════════════════════════════════════
  isTempBlockedMessage(msg) { return /temporary email|not supported|disposable/i.test(String(msg || "")); }
  markDomainBlocked(email, why) {
    const dom = String(email || "").split("@")[1];
    if (!dom || !this.isTempBlockedMessage(why) || this.blockedMailDomains.has(dom)) return;
    this.blockedMailDomains.add(dom);
    console.log(`mail domain rejected by Raccoon (${String(why).trim()}) — ${dom} added to blocklist`);
    this.state.waitUntil(this.storage.put("blockedDomains", [...this.blockedMailDomains]).catch(() => {}));
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
        await fetchWithTimeout(`${base}/accounts`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ address: email, password: mailPassword }),
        });
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
    return `providers: ${parts.join(" | ")} | pool ${this.pool.length}/${this.POOL_TARGET}${blocked}`;
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
    const passBackoffMs = [3000, 8000, 20000];
    let lastErr = null;
    for (let pass = 0; pass <= passBackoffMs.length; pass++) {
      for (const lane of this.laneOrder()) {
        try {
          const { email, handle } = await lane.create();
          if (this.blockedMailDomains.has(String(email).split("@")[1])) continue;
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
            this.markDomainBlocked(email, rejected);
            this.noteProviderFail(lane.id, new Error(rejected));
            lastErr = new Error(`Raccoon refused ${email.split("@")[1]}: ${rejected}`);
            continue;
          }
          if (!code) { lastErr = new Error(`no verification code from ${lane.id}`); this.noteProviderFail(lane.id, lastErr); continue; }
          const regRes = await this.raccoonFetch("/users/emailRegister", {
            method: "POST", headers: h,
            body: new URLSearchParams({ email, code, password: raccoonPassword, phone: "1", country: "Brazil", ...common }),
          });
          const regRejected = this.raccoonRejectedMail(await regRes.json().catch(() => null));
          if (regRejected) {
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
          lastErr = e;
          this.noteProviderFail(lane.id, e);
        }
      }
      if (pass < passBackoffMs.length) {
        console.log(`account creation failed (${lastErr ? lastErr.message : "every mail lane is blocklisted"}) — retrying in ${passBackoffMs[pass] / 1000}s`);
        await sleep(passBackoffMs[pass]);
      }
    }
    throw lastErr || new Error("Account creation failed on all providers");
  }
  async createAccount() {
    if (this.pool.length > 0) {
      const acc = this.pool.shift();
      console.log(`pool: served (${this.pool.length} left)`);
      this.state.waitUntil(this.savePool());
      this.ensureTicking();
      return acc;
    }
    const acc = await this.createAccountRaw();
    this.ensureTicking();
    return acc;
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
    const d = await parseJsonResponse(await this.raccoonFetch("/jyapi/playQueue", {
      method: "POST", headers: this.gameHeaders(token),
      body: new URLSearchParams({ sn, model: "Chrome/147.0.0.0", version_code: "1", version_name: "1.0.0", device_name: "GhostCloud", os: "web", "manufacturer;": "", play_queue_id: queue_id, user_token: token }),
    }), "Game queue");
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
    if (this.pool.length < this.POOL_TARGET) return Math.max(1000, this.nextPoolFillAt - Date.now());
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
    if (this.pool.length < this.POOL_TARGET && !this.poolFilling && now >= this.nextPoolFillAt) {
      const backoff = Math.min(POOL_FILL_INTERVAL_MS * Math.pow(2, Math.min(this.poolFillFails, 5)), 5 * 60 * 1000);
      this.nextPoolFillAt = now + backoff;
      await this.fillPoolOnce();
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
        w.push({ status: "error", error: e.message });
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
        waiter.push({ status: "error", error: e.message });
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
    if (!rl.allowed) { w.push({ status: "error", error: `Rate limit: ${rl.reason}` }); try { w.controller.close(); } catch {} return; }
    if (!manualAccount && !this.acquireAccountSlot(apiKey, site)) {
      w.push({ status: "error", error: "Too many sessions being created." });
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
      if (manualAccount) {
        acc = manualAccount;
        w.push({ status: "account_ready" });
      } else {
        w.push({ status: "creating_account" });
        acc = await this.createAccount();
        this.releaseAccountSlot(apiKey);
        if (!this.sessions.has(uuid) || w.ended) return;
        w.push({ status: "account_ready" });
      }
      session.sn = acc.sn; session.token = acc.token;
      this.recordUsage(apiKey);
      w.push({ status: "requesting_game" });
      let init = null;
      let creditRetries = 0;
      while (!init) {
        try { init = await this.doInitGame(session); }
        catch (e) {
          if (e && e.isDiamondError && !manualAccount && creditRetries < 2) {
            creditRetries++;
            console.log(`no credits on ${uuid.slice(0, 8)} — trying another account (${creditRetries})`);
            w.push({ status: "creating_account" });
            acc = await this.createAccount();
            session.sn = acc.sn; session.token = acc.token;
            w.push({ status: "account_ready" });
            w.push({ status: "requesting_game" });
            continue;
          }
          throw e;
        }
      }
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
      if (!manualAccount) this.releaseAccountSlot(apiKey);
      w.push({ status: "error", error: e.message });
      this.killSession(uuid, "creation_error");
    } finally {
      try { w.controller.close(); } catch {}
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
    const signalingWs = `${proto}://${ctx.url.host}/cloud/v1/signal/${uuid}`;
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
    for (const lane of this.laneOrder()) {
      try { const { email, handle } = await lane.create(); return json({ email, ...handle }); }
      catch (e) { lastErr = e; this.noteProviderFail(lane.id, e); }
    }
    return json({ error: lastErr ? lastErr.message : "No mail provider available" }, 500);
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
  async handleSendEmail(ctx) {
    const { email, password } = ctx.body || {};
    if (!email || !password) return json({ error: "Missing email or password." }, 400);
    const sn = generateSN();
    try {
      const r = await this.raccoonFetch("/users/sendEmail", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "Mozilla/5.0 Chrome/147.0.0.0 Safari/537.36" },
        body: new URLSearchParams({ email, type: "register", sn, model: "Chrome/147.0.0.0", version_code: "1", version_name: "1.0.0", device_name: "GhostCloud", os: "web" }),
      });
      const data = await r.json().catch(() => ({}));
      console.log(`sendEmail ${email} → HTTP ${r.status} ${JSON.stringify(data)}`);
      if (data.status && data.status !== 200) return json({ error: data.msg || `Raccoon rejected: ${JSON.stringify(data)}`, raccoon: data }, 400);
      return json({ sn, raccoon: data });
    } catch (e) { return json({ error: e.message }, 500); }
  }
  async handleManualRegister(ctx) {
    const { sn, email, password, code, phone, country } = ctx.body || {};
    if (!sn || !email || !password || !code) return json({ error: "Missing sn, email, password or code." }, 400);
    const base = { sn, model: "Chrome/147.0.0.0", version_code: "1", version_name: "1.0.0", device_name: "GhostCloud", os: "web" };
    const headers = { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "Mozilla/5.0 Chrome/147.0.0.0 Safari/537.36" };
    try {
      await this.raccoonFetch("/users/emailRegister", { method: "POST", headers, body: new URLSearchParams({ email, code, password, phone: phone || "1", country: country || "Brazil", ...base }) });
      const loginRes = await this.raccoonFetch("/users/emailLogin", { method: "POST", headers, body: new URLSearchParams({ email, password, ...base }) });
      const loginData = await parseJsonResponse(loginRes, "Raccoon login");
      if (loginData.status !== 200) throw new Error("Login failed");
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
    const out = { lanes: this.allLanes().map((l) => l.id), ownDomain: this.MAIL_DOMAIN || "(not configured)", pool: `${this.pool.length}/${this.POOL_TARGET}`, blockedDomains: [...this.blockedMailDomains] };
    for (const base of this.MAIL_PROVIDERS) {
      const t0 = Date.now();
      try {
        const r = await fetchWithTimeout(`${base}/domains`, {}, 15000);
        const t = await r.text();
        out[base] = { status: r.status, ms: Date.now() - t0, body_len: t.length, body_head: t.slice(0, 120) };
      } catch (e) { out[base] = { error: e.message }; }
    }
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
  handleSignal(request, uuid) {
    if ((request.headers.get("upgrade") || "").toLowerCase() !== "websocket") return json({ error: "Expected WebSocket upgrade." }, 426);
    const session = this.sessions.get(uuid);
    if (!session || session.state !== "active") return json({ error: "Not active." }, 404);
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    session.clientWs = server;
    const self = this;
    server.addEventListener("message", (event) => {
      let msg;
      try { msg = JSON.parse(typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data)); } catch { return; }
      const rws = session.raccoonWs;
      if (!rws || rws.readyState !== WS_OPEN) return;
      try {
        if (msg.type === "rtc_offer" && msg.sdp) {
          rws.send(JSON.stringify({ id: "rtc_sdp", from: session.sn, to: session.gl_key, body: { sdp: msg.sdp, type: "offer" } }));
        } else if (msg.type === "rtc_candidate" && msg.candidate) {
          rws.send(JSON.stringify({ id: "rtc_sdp", from: session.sn, to: session.gl_key, body: { type: "candidate", sdp: msg.candidate } }));
        }
      } catch (e) { console.log(`client ws relay error: ${e.message}`); }
    });
    server.addEventListener("close", () => {
      session.clientWs = null;
      // No signaling = no game. Drop the session promptly rather than waiting
      // for the ping timeout.
      if (self.sessions.get(uuid)) self.killSession(uuid, "client_ws_closed");
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
          if (data.from === gl_key && data.body?.code === 200) toClient({ type: "game_ready" });
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
    raccoonWs.addEventListener("close", () => {
      session.rSend = null;
      console.log(`raccoon ws closed for ${uuid.slice(0, 8)}`);
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
