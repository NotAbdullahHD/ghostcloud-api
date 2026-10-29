# GhostCloud API — Cloudflare Workers

The whole API (account pool, session queue, presence, mail lanes, WebSocket
signaling relay) runs inside **one Durable Object**. No instance hours, no
sleeping, no bandwidth bill — which is exactly what Render's free tier could
not give us.

---

## Deploy via GitHub → Workers Builds

### 1. Put this folder on GitHub

Create a **new repository** (e.g. `GhostCloud-API`) and upload the contents of
this folder so the repo root looks like this:

```
package.json
package-lock.json
wrangler.toml
src/worker.js
src/sites.js
.gitignore
```

> Do **not** upload `node_modules/` or `.wrangler/` — the build installs
> dependencies itself, and `.wrangler/` is local dev state. `.gitignore`
> already excludes both.
>
> Keep the `GhostCloud-API` repo **separate** from the `GhostCloud` repo that
> Render builds. If you put it inside the Render repo you must set the Workers
> Builds *root directory* to `ghostcloud-worker`, otherwise the build cannot
> find `wrangler.toml`.

### 2. Connect it in Cloudflare

**Cloudflare dashboard → Workers & Pages → Create → Workers → Import a
repository** → pick the repo, then set:

| Setting | Value |
|---|---|
| Build command | `npm clean-install` (default) |
| Deploy command | `npx wrangler deploy` |
| Root directory | *(leave empty if repo root is this folder)* |

Build settings are usually correct by default — the only one worth checking is
the **deploy command**, which must be `npx wrangler deploy`.

### 3. First deploy creates the Durable Object

`wrangler.toml` already contains the migration that the free plan requires:

```toml
[[migrations]]
tag = "v1"
new_sqlite_classes = ["Hub"]
```

This is what failed the last time with
`you must create a namespace using a new_sqlite_classes migration` — it is now
fixed. **Don't remove it**, and don't change the `tag` on later deploys.

You should see a binding in the build log:

```
env.HUB (Hub)   Durable Object
```

### 4. Set the variables

**Worker → Settings → Variables and Secrets.** Add as **secrets** (encrypted):

| Name | Value | Why |
|---|---|---|
| `GHOSTCLOUD_PRO_CODE` | your Pro code | without it Pro activation is disabled |
| `GHOSTCLOUD_PRO_EPOCH` | e.g. `1` | bump to invalidate every issued Pro token |
| `GHOSTCLOUD_INBOUND_KEY` | any random string | only if you later use the own-domain mail lane |
| `GHOSTCLOUD_MAIL_DOMAIN` | e.g. `mail.yourdomain.com` | only if you set that lane up |
| `GHOSTCLOUD_SEED_KEY` | any random string | recommended: without it, anyone holding the site's API key can call `/cloud/v1/seedPool` |

`GHOSTCLOUD_POOL_TARGET` (pre-warmed accounts, 3–20) is set to `6` in
`wrangler.toml`; override it here if you want a different size. Each pre-warmed
account is a full registration, but the daily burn is set by the alarm *floor*
(`POOL_FILL_MIN_DELAY_MS`, 20s), not by the target — a full pool costs nothing at
idle.

`GHOSTCLOUD_WALL_COOLDOWN_MS` (default `600000`, i.e. 10 min) is how long the
worker stops attempting registrations after Raccoon's bot check is seen. See
[the bot-check section](#please-complete-the-puzzle-verification--raccoons-bot-check)
for why that matters to the request budget.

`GHOSTCLOUD_SEED_KEY` gates `/cloud/v1/seedPool` — the endpoint that lets a solved
puzzle put a working account into the shared pool. When it is set, the request
must carry `x-seed-key`; the site sends none, so a seeding attempt then falls back
to saving the account locally instead (which still works, just for that one
player). Only set it if you intend to seed from `curl` yourself.

### 5. Verify

Open the worker URL — you should get JSON back:

```
https://<worker-name>.<your-subdomain>.workers.dev/
→ {"status":"ok","name":"ghostcloud-api"}
```

Then check the logs in **Worker → Logs (Live)**. Within a minute you should see
the pool filling with pre-warmed accounts.

### 6. Point the site at it

In the website's `js/app.js` and `js/pro.js`, change:

```js
const DEFAULT_API_BASE = 'https://<worker-name>.<your-subdomain>.workers.dev';
```

The CORS allowlist in `src/sites.js` already accepts `*.pages.dev`,
`*.workers.dev`, `*.vercel.app` and other free static hosts, so a new mirror
link works without editing anything. Add the exact custom domain to the
`allowed_origins` list if you use one.

---

## Local development

```bash
npm install
npx wrangler dev --local --port 8787 --ip 127.0.0.1
```

Runs against a local Durable Object with local SQLite storage.

**If you ever see `SQLITE_READONLY` locally**, the local DO database got
corrupted (usually from force-killing `workerd.exe`). Stop all wrangler
processes, delete the `.wrangler/` folder, and start again. Production is
unaffected.

## Testing the real flow locally

`.freebuff/test_worker_session.js` in the parent project walks the exact path
the website uses (createSession → queue → startGame → signaling socket →
ping → heartbeat → quit). Run it against the local server:

```bash
node .freebuff/test_worker_session.js
GAME=bs0093 node .freebuff/test_worker_session.js   # pick another game
```

---

## "The API goes offline every evening" — the free-plan request budget

Both free meters are **100,000 requests/day, and both reset at 00:00 UTC**:

| Meter | What counts |
|---|---|
| Workers | every request that reaches the Worker |
| Durable Objects | HTTP requests, **WebSocket messages**, and **alarms** |

The whole API is one Durable Object, so a single API call can cost two requests
(one Worker, one DO), every relayed ICE candidate costs a DO request, and every
alarm tick costs a DO request too.

When either meter runs out, Cloudflare answers **Error 1027** until midnight
UTC. Every `/cloud/v1/*` route fails, the site's heartbeat check fails, and the
status dot reads **"Offline"** — while the *site itself* keeps loading fine,
because static-asset requests are free and unlimited. That mismatch is the tell:
the page works, only the API looks dead.

**Check it:** Cloudflare dashboard → Workers & Pages → Metrics / Usage, range
48h. A graph that climbs to ~100k, flatlines, then restarts just after midnight
UTC is confirmation. Check the **Durable Objects** usage view too — that is the
meter that usually dies first. `wrangler tail` will show nothing, because once
the limit is hit the Worker never runs at all.

**What was burning it** (all fixed in `src/worker.js`):

- `nextTickDelay()` floored the pool-fill delay at 1000 ms, so whenever the pool
  sat below target and the next fill was already due, the alarm re-armed every
  second — up to ~86k DO requests/day on an otherwise idle hub.
- `tick()` armed `nextPoolFillAt` *before* awaiting the fill, so any fill slower
  than `POOL_FILL_INTERVAL_MS` left that deadline in the past and the loop
  re-fired immediately. It is now armed after the fill returns.
- `TICK_MS` was 3s — ~29k alarms/day on its own. Now 10s; nothing in `tick()`
  needs finer granularity than that.
- `GHOSTCLOUD_POOL_TARGET` was 10, so the pool was almost permanently below
  target. It went to 3, and back up to 6 once the alarm floor above was in
  place — the daily burn is set by the *floor* (one fill attempt per 20s max),
  not by the target size, so a larger pool is close to free at idle.

The pool-fill backoff also capped out at 5 minutes, which parked the pool during
the busiest hour — exactly when it needed to refill. Capped at 60s now
(`POOL_FILL_MAX_BACKOFF_MS`).

If real traffic still exceeds 100k/day, **Workers Paid ($5/mo)** removes the
daily cliff entirely (10M requests/month included). That is the honest fix once
the site has steady users.

## "Account service is at capacity right now (HTTP 429)"

A different failure with a similar smell, and **not** a Cloudflare limit. The
message came from `parseJsonResponse(..., "Account service")`, i.e. from the
free **temp-mail providers** (`api.tempmail.lol`, `api.mail.gw`,
`api.duckmail.sbs`) refusing to hand out another mailbox. Raccoon was never the
problem.

Four things lined up to cause it:

1. **The pool was too small for peak.** `GHOSTCLOUD_POOL_TARGET = 3` meant the
   pool covered three sign-ups. Player four onward needed a *live* registration
   at click time, and a live registration is 30-60s of mailbox + Raccoon work.
2. **Live registrations were effectively unlimited.** `acquireAccountSlot()`
   capped them at `max_concurrent_sessions * 2` = **30 at once**, all pointed at
   the same two free mail providers. That is a rate-limit storm by construction.
3. **The pool stalled when it was needed.** Pool-fill failures backed off up to 5
   minutes, so a busy period tripped the backoff and the pool stopped refilling
   until the rush was over.
4. **The 429 became the player's problem.** It was streamed to the player as a
   `status:"error"` event with the provider's name and HTTP code in it, and the
   client does not auto-retry those — so every throttled player saw a red error
   and every one of them asked about it.

**What changed:**

- `ACCOUNT_CREATE_MAX = 2` — registrations are capped globally (the provider
  limit is per provider, not per site). Extra players now **wait** instead of
  racing into a throttle.
- `waitForAccountSlot()` — the wait is bounded (150s), cancellable, and emits
  `capacity_queue` events every 5s, which the client *already* renders as
  "you're #N in line, your game starts automatically". No site redeploy needed.
- Registration slots are held across the play-credits retry too (which registers
  another account), and released exactly once via `releaseAccountSlotFor()`.
- A lane that answers 429 is skipped for the rest of that attempt, and
  `Retry-After` is honoured when the provider sends one.
- `BUSY_MESSAGE` + `playerMessage()` — one neutral sentence for every
  infrastructure failure. Provider names and HTTP codes stay in the logs.
- Pool target 3 → 6.

**If it still happens:** the permanent fix is the **own-domain mail lane**
(`GHOSTCLOUD_MAIL_DOMAIN` + `GHOSTCLOUD_INBOUND_KEY`, see the secrets section
above). It has no third-party rate limit because you own the mailbox, and it is
already implemented — it just needs the domain and the Email Worker route set
up. Until then this is a question of how much load the free providers will take.

**Debugging tip:** `wrangler tail` shows the real reason. Look for
`account creation failed (...)`, `pool: fill error`, and the periodic
`providers: … | pool N/6` dashboard line — that last one tells you at a glance
whether lanes are being skipped and how deep the pool is. Better still, ask the
API directly — one call gives the whole picture, no tail needed:

```bash
curl -s -H "x-api-key: sk_live_local_dev_key_12345" \
     -H "origin: https://ghost-mathmulti.zeoghost.workers.dev" \
     https://ghostcloud-api.frostos.workers.dev/cloud/v1/diagMail | jq
```

It reports the pool depth, per-lane counters with each lane's **last error**,
whether a lane is being skipped, the state of each mail provider, and — most
importantly — a live probe of Raccoon's `sendEmail`:

```json
"raccoon": { "http": 200, "ms": 735,
             "reply": "Please complete the puzzle verification.", "walled": true }
```

`walled: true` means **no new account can be created at all**. See the next
section.

## "Please complete the puzzle verification" — Raccoon's bot check

This is the failure to check first when players report that nothing starts. It
is no longer a capacity problem and no amount of retrying, throttling or lane
rotation fixes it.

Measured 2026-10-10, from two independent locations:

| Probe | Result |
|---|---|
| Raccoon `sendEmail` for `…@niceground.shop` (duckmail) | `400 Please complete the puzzle verification.` |
| …for five more duckmail domains | same, every domain |
| …for `@example.com` and `@gmail.com` | **same** — so it is not about the address |
| …with a real browser user-agent and Origin/Referer/X-Requested-With | same |
| …**from the deployed Worker on Cloudflare's network** | same |

So it is not this machine, not the temp-mail domain, not the user-agent, and not
the headers. It is a **slider puzzle**, and it is solvable — by a human.

### What the check actually is

Raccoon's own login page ships the widget
(`https://www.raccoongame.com/assets/web/js/email-registration-puzzle.js`) and it
is two endpoints, both read from that file and confirmed live:

| Call | What it does |
|---|---|
| `GET /users/emailRegisterCaptcha?email=…&sn=…&t=…` | returns `{challenge_id, background, piece, width, height, piece_size, piece_y}` — the puzzle image and the piece as PNG data URIs, plus the geometry |
| `POST /users/emailRegisterCaptchaVerify` `{email, sn, challenge_id, offset}` | checks where the piece landed: `offset = round(progress × (width − piece_size))`, in the image's own pixels |

Registration then proceeds normally **for that `sn`**: `sendEmail` → code from
the mailbox → `emailRegister` → `emailLogin`. Two things are easy to get wrong:

- **The `sn` *is* the verification's identity.** Generate a fresh one for
  `sendEmail` and the refusal comes straight back; it has to be the same `sn` the
  challenge was fetched with. `/cloud/v1/sendEmail` now takes `sn` for this
  reason.
- **Raccoon rate-limits the puzzle per address** — `429 Too many puzzle attempts.
  Please try again in N seconds` (a 180s window). Past that limit even a
  brand-new challenge answers *"The puzzle has expired"*, which is why "expired"
  is not the same thing as a slow human. Both relay endpoints return
  `retry_after_seconds` so the UI waits instead of retrying into the limit.

Measured: a deliberately wrong offset at 2s, 8s and 12.8s returns `400 The puzzle
does not match. Please try again.` — the challenge is alive and the offset really
is checked, so this is a human check and not a rubber stamp. A correct-but-late
one, and any attempt made after the per-address limit, return `The puzzle has
expired. Please refresh it.`

### What the Worker does about it

- **Relays the puzzle to the player instead of trying to pass it.** The Worker
  never computes an offset — a machine solving the check would defeat the check.
  `/cloud/v1/captchaChallenge` fetches a challenge and hands back the images and
  the `sn`; `/cloud/v1/captchaVerify` forwards the human's drag. The player sees
  exactly what they would see on raccoongame.com.
- **Seeds the shared pool.** `POST /cloud/v1/seedPool {sn, token}` puts a working
  account in the pool, so one solved puzzle serves many sessions instead of dying
  with the player who solved it. Set `GHOSTCLOUD_SEED_KEY` to require an
  `x-seed-key` header (recommended: the site's API key is public).
- **Recognises the wall and stops the attempt immediately** — no second pass, no
  other lane, no backoff. Before, a walled attempt walked 3 lanes × 4 passes,
  spending provider quota and making the player wait ~45s for an answer that
  could not change. Measured locally: the first attempt now answers in ~2.3s.
- **Remembers it for a cooldown** (`GHOSTCLOUD_WALL_COOLDOWN_MS`, 10 min by
  default) and refuses *automatic* registrations while it runs. This is what
  protects the free-plan budget: a walled hub used to re-attempt pool fills every
  20–60s around the clock, and every player retry re-probed the providers, all to
  collect the same refusal. The automatic path can never solve a puzzle, so it
  stays paused; the human path is never blocked by it.
- **Tells the player the truth, and gives them the action.** `playerMessage()`
  returns `OUTAGE_MESSAGE` for the wall — "…one slider puzzle, solved once. Open
  your account settings, get a mailbox and solve it…" — and `BUSY_MESSAGE` only
  for genuine congestion. Retrying cannot pass the wall, so "please try again in a
  moment" would be a lie that also spends quota; the outage wording names the one
  screen that does work.
- **Never lets the refusal be the last word.** Raccoon's sentence — `Please
  complete the puzzle verification.` — used to reach the player verbatim, telling
  them to complete a check that was never on screen. There was no way out of
  that state. Now every path that needs the check says *needVerification*: the
  `sendEmail` response, the `manualRegister` response, and the session error
  event. Anything mentioning the check is classified as the check, whatever the
  wording — including against an older site that never sends the flag. The site
  uses it to open the account screen, name the two buttons that matter and
  highlight the first one.
- **Reports its own build.** `GET /cloud/v1/capabilities` →
  `{apiVersion, capabilities: {puzzle, manualRegister, seedPool,
  verificationEvents, codeRefusals}}`. The account screen asks for it and prints
  the result, so a stale deploy is visible instead of being indistinguishable from
  a bug.

Measured end-to-end in workerd (`node .freebuff/test_wall_live.js`): attempt 1
~2.3s and records `raccoonWallCooldownSeconds: 600`; attempt 2 answers in **0.1s**
with zero outbound requests. `node .freebuff/test_raccoon_wall.js` pins the
cooldown, the zero-request guarantee, the alarm suppression, the restart
round-trip, and the message wording. `node .freebuff/test_puzzle_relay.js` pins
the relay contract: real challenge with data-URI images and geometry, the `sn`
that has to be reused, a wrong offset rejected rather than passed, the
`needVerification` flag that makes the site open the puzzle, and seeding the pool
exactly once per account.

### The session cookie — the bug that made every solve look expired

Raccoon issues the registration puzzle inside a Laravel session and returns it as
`raccoongame_session=…` on the challenge response. Their own widget is a
same-origin `$.ajax` call, so the browser sends that cookie back automatically;
our relay is stateless, so it did not, and `/emailRegisterCaptchaVerify` — which
looks the pending challenge up *in that session* — answered:

| request | answer |
|---|---|
| verify **without** the cookie | `The puzzle has expired. Please refresh it.` |
| verify **with** the cookie, same wrong offset | `The puzzle does not match. Please try again.` |

Both were sent back to back, at the same millisecond-scale latency, so "expired"
was never about time. It read exactly like a short solve window, which is where
the earlier "Raccoon is throttling this IP" note came from — wrong. The cookie is
the whole difference, and a *correct* solve would have been refused the same way.

The Worker now keeps the session per `sn` (`captureRaccoonSession`, 30 min TTL,
oldest-first trim) and sends it on challenge → verify → `sendEmail` →
`emailRegister` → `emailLogin`, re-capturing it on every response because Raccoon
rotates it each time.

### Verified: a human solve is accepted

Solved by hand (reading the challenge, dragging the piece) three times against
this Worker, all through the relay:

| offset | result |
|---|---|
| 251 | `{verified: true}` → `sendEmail` → `{"status":200,"msg":"success"}` |
| 244 | `{verified: true}` |
| 239 | `{verified: true}` → `sendEmail` → `{"status":200,"msg":"success"}` |

A challenge fetched 19–21s before the drag still verified, and a challenge left
~90s did not, so the window is short (order of a minute) — worth knowing, because
the site's *Send code* step is what starts that clock.

To see the working half in 30 seconds: open the site → Settings → Account → **Get
temp mailbox** → **Send code** → drag the piece into the gap. The puzzle clears
and the code goes out (that is the part this document's fix repairs). **Register &
save** then needs a code that actually arrived in the mailbox — see the gate
section below for what Raccoon answers and why.

The check only exists inside that step. It is requested by *Send code* and it is
bound to the mailbox in the field above it, so there is nothing to see on the
account screen before you press it — which is exactly why the site now opens this
screen and highlights that button whenever the game service refuses for want of
the check.

### The register gate moved (2026-10-14)

For a while `emailRegister` refused *every* account — Raccoon's own website
included, for their own users — with:

```
emailRegister → {"status":400,
  "msg":"Human verification is required. Please request a new email code."}
```

**They have since changed it, and it is worth understanding exactly how**, because
the old answer and the new one look alike and mean opposite things. Probed
directly against `www.raccoongame.com` on 2026-10-14
(`node .freebuff/probe_site_2026.js`):

| call | answer |
|---|---|
| `emailRegister`, never-solved `sn`, bogus code | `415 Verification code has expired or is incorrect` |
| `emailRegister`, unsolved `sn` **plus its session**, bogus code | same — the session changes nothing |
| `emailRegister`, an undeliverable domain | `400 The email domain cannot receive email.` |
| `sendEmail`, fresh `sn`, unverified | `400 Please complete the puzzle verification.` |

The gate is **gone from register**. A bad code is now refused on its own merits,
with no mention of the puzzle, whether or not the check was ever solved — so the
old diagnosis was right, and `sendEmail` keeps the check while `emailRegister`
stopped asking for one. **The register step no longer needs the puzzle at all.**
Only `sendEmail` does, and it is the one that starts the challenge clock.

That changes three things in this Worker, all of them bugs once the wording
changed:

1. **A bad code is not the bot wall.** `"Verification code has expired or is
   incorrect"` contains *verification*, so it matched the wall pattern. One stale
   code from one temp-mail lane therefore started the ten-minute service-wide
   cooldown — a self-inflicted outage from a routine event. `raccoonCodeRejected()`
   now claims it first, and `isRaccoonWall()` excludes it.
2. **A bad code asks for another code, not another solve.** `manualRegister`
   answers `needCode: true` and passes Raccoon's own sentence through, and the
   site keeps both the typed code and the `sn` and points at *Send code*. Sending
   the player back to the puzzle would spend a human solve on a step that is
   already done and cannot fix the code.
3. **The pool loop spends one more code.** On a code refusal it calls `sendEmail`
   again, polls for a fresh code and retries `emailRegister` once, then moves on —
   instead of pausing every registration for ten minutes.

Also new: `/login.html` and `/index.html` are **404** now — the pages moved to
`/login` and `/home.html`. Anything pointing at the old paths is dead. Sign in
with Google appeared alongside these changes; Raccoon's page still gated it to
three hard-coded device ids, so it was not yet a general path.

The API version for this is **2.4.0**, and `capabilities.codeRefusals` says the
running Worker distinguishes a code refusal from the check. An account screen
showing anything older is a stale deploy — that is the one thing to check first.

## "Temporary email addresses are not supported." — a refused mailbox

This one reached players as red text on the account form (reported in Discord,
16 Oct 2026). It is Raccoon refusing the *address*, not the check: the free mail
providers hand out domains it treats as disposable, and nothing the player does
changes that.

It used to be expensive as well as ugly. The mailbox was created first, the
player solved the slider, and only then did `sendEmail` answer with that sentence
— one human drag spent on an address nobody had chosen, ending in an error that
read as the site being broken.

**Measured 2026-10-16, and this is the part that makes a fix possible:**
`/users/emailRegister` answers the *domain* question before it looks at the code,
and needs no puzzle, no session and no human. Probed directly against
`www.raccoongame.com` (see `.freebuff/test_mailbox_screen.js` for the shapes):

| call | answer |
|---|---|
| `emailRegister`, blocked domain, junk code, no session | `400 Temporary email addresses are not supported.` |
| `emailRegister`, reachable domain, junk code | `415 Verification code has expired or is incorrect` — i.e. a *code* complaint, so the domain passed |
| `sendEmail`, blocked domain, unverified | `400 Please complete the puzzle verification.` — the puzzle is checked **first**, so `sendEmail` cannot screen a domain |

So one cheap call settles a domain before any player sees a slider.

**What the Worker does now (2.5.0):**

1. `screenMailDomain(email)` — every mailbox is screened before it is handed out
   (both in `createMailbox` and in the pool-fill loop, where it also saves a
   `sendEmail` plus ~50s of polling on mail that was never going to arrive). A
   refused domain goes on the persisted blocklist and the next one is used.
2. A domain that passes is remembered for six hours, so the question is asked
   once per domain rather than once per player. A domain that is refused later —
   by `sendEmail` or by `emailRegister` — is moved to the blocklist immediately.
3. `needMailbox: true` on a `sendEmail`/`manualRegister` refusal, so the site can
   take another mailbox instead of printing Raccoon's sentence. If every domain is
   refused, `createMailbox` answers `needOwnAccount` with a plain, actionable
   sentence and no provider name, domain name or HTTP code.
4. A screen that could not be run blocks nothing: it proves nothing, and the real
   refusal still catches the mailbox later.

`capabilities.mailDomainScreen` says the running Worker has this. The site side
(`app.js` 2.5.0-era) needs no matching flag: it already falls back to matching the
wording, so an older API that only forwards Raccoon's sentence still takes a fresh
mailbox instead of showing it.

**What it does not fix.** The screen cannot make a domain acceptable — it only
stops one reaching a player, and the pool of free domains Raccoon has already
blocked keeps growing (`diagMail` → `blockedDomains`). The durable answer is still
the own-domain lane (`GHOSTCLOUD_MAIL_DOMAIN` + `GHOSTCLOUD_INBOUND_KEY`), which
does not depend on anyone else's domains at all.

## "Try again in X seconds" — the check's own rate limit

Raccoon rate-limits puzzle attempts per window (`429 Too many puzzle attempts`,
see `puzzleRetryAfter()`). The server was already reporting it as
`retry_after_seconds`, but the modal printed a sentence about clicking a button
and left its own `busy` flag set — so the slider ignored every gesture, **New
puzzle did nothing at all**, and the only way out was Cancel. Reported live as
"after that when we click new puzzle nothing happens".

The fix is entirely in `stratus/js/app.js` (site only — no API change):

- every early return in `loadPuzzle`/`verifyPuzzle` now clears the busy flag, so
  no path can leave the modal dead;
- a rate limit starts a real countdown (`Try again in Ns`), with the slider and
  the button disabled while it runs, and one automatic re-request when it ends;
- the wait is a *deadline*, not a timer, and it is also re-checked when the tab
  becomes visible or the modal is touched — a backgrounded tab is throttled to
  about a timer a second and can be frozen outright (found by testing in a tab
  that was never composited: the countdown sat unfired 80s past its deadline).

`node .freebuff/test_puzzle_cooldown.js` covers all of it in a stub DOM.

**2.6.0 — the check is a budget, not a button.** Measured live on 2026-10-20:
five `emailRegisterCaptcha` calls from one IP, and the sixth answered
`429 Too many puzzle attempts. Please try again in 3543 seconds.` Raccoon limits
by *egress IP*, and this Worker is that IP for every player on the site, so one
person dragging badly could take the human check away from everybody for an
hour. The old site made that worse: every wrong drag fetched a brand-new
challenge, 900ms later, automatically.

What changed (API 2.6.0 + `app.js?v=16`):

- **One challenge per address, reused for 5 minutes** (`PUZZLE_REUSE_MS`).
  Re-opening the check — a double tap, a tab switch, a retry — returns the image
  already on the player's screen instead of spending another ask.
- **Single-flight per address.** Concurrent asks share one upstream call. (The
  shared value is the answer, not a `Response`: a body can only be read once.)
- **Persisted, not in-memory.** The Raccoon session, the cached challenge and
  every solved `sn` are written to DO storage, because the wait for a human is
  exactly when the object goes idle enough to be evicted. Losing that session is
  what turns a correct drag into "The puzzle has expired. Please refresh it."
- **Refusals are classified**: `expired`, `mismatch` (wrong position) and
  `retry_after_seconds`. Only an expiry asks Raccoon again.
- **A solved check is remembered for 30 minutes**, so a retried code or a
  reopened tab never sends the player back to the slider (`reusedVerification`).
- **`blocked: true`** on any wait longer than two minutes, and the site says so
  in minutes instead of running a 57-minute countdown into a disabled slider.
  The site makes that decision from the number too, so it behaves the same
  against an older API build.
- **The site retries in place.** A wrong drag keeps the challenge and resets the
  thumb; nothing is re-fetched behind the player's back.
- `GHOSTCLOUD_POOL_TARGET` is 10 (was 6): while the check is unavailable, the
  pool is the only thing that can start a game.

Tests: `node .freebuff/test_puzzle_cache.mjs` drives the real `Hub` class with a
stubbed Raccoon and in-memory DO storage (cache, single-flight, eviction,
classification); `node .freebuff/test_puzzle_cooldown.js` covers the modal.

**2.7.0 — the check is no longer on the Play path, and its budget is ours.**
The report after 2.6.0 was still `Too many puzzle attempts. Please try again in
2619 seconds. Try again in 2611s.` — i.e. a 43-minute countdown on a Play
button. Two separate faults behind it:

1. A player pressing Play could be sent to a slider by an *automatic* account
   failure. The automatic path never uses the human check (the pool is filled
   without one), and the refusal is about this Worker's IP allowance, not about
   the person. So `createAccountRaw` errors now carry `auto: true`,
   `sessionErrorEvent` drops `needVerification` for them, adds `capacity: true`
   and a `retry_after_seconds`, and the player reads
   `NO_ACCOUNT_MESSAGE` — "try again in a few minutes", with nothing to solve.
   The manual (Settings → account) path keeps its hint, because there a slider
   really is the next step.
2. Each retry made the lockout worse. `puzzleBlockedUntil` is now set from any
   `retry_after_seconds` Raccoon sends (capped at an hour), **persisted**, and
   nothing asks again until it expires — that is what stops 591s → 3406s →
   3543s. On top of that, `PUZZLE_ISSUE_MAX` (6 per 15 minutes, site-wide) caps
   how fast the shared allowance can be spent at all; beyond it the API answers
   `puzzle_blocked` with a wait and does not call Raccoon.

Also in 2.7.0:

- `/healthz` reports `pool`, `pool_target` and `puzzle_blocked_for_seconds`. A
  locked check is not an outage (the pool still starts games) so it does not
  flip the status to degraded — it is there to explain why *registrations*
  stopped, with the exact remaining time.
- `doPollQueue` retries once on a 5xx or a dropped connection. One blip on
  Raccoon's edge used to end the whole session; the call is a read, so asking
  again is safe.

`test_puzzle_cache.mjs` covers all of it: the lockout is remembered and cannot
escalate, it survives eviction, the budget caps a rush at six, and an `auto`
wall never produces a verification hint.

**2.8.0 — one deliberate way back instead of a dead end.**
On 2026-10-20 Raccoon re-gated registration itself: `sendEmail` answers
`Please complete the puzzle verification.` for every address, **from a clean
IP as well** (verified from this machine, not just from Cloudflare), and
`emailRegister` answers `Temporary email addresses are not supported.` for every
domain the free providers hand out. So the automatic fill path cannot create an
account at all while that gate is up, and an empty pool stays empty. Waiting is
not a fix: the 10-minute wall cooldown just retries into the same refusal.

What the API does about it:

- `sessionErrorEvent` adds **`canUnlock: true`** when an automatic account
  failure could actually be cleared — Raccoon is not in a lockout *and* the local
  challenge budget has room (`puzzleAvailable()`). The error sentence says the
  account would be shared, so the choice is informed.
- It is an *offer*: `needVerification` stays `false`, so no site opens a slider by
  itself. The site shows a button; only a click starts the check. With the
  lockout set, `canUnlock` is `false` and no button appears at all.
- One solved check creates one account, and accounts are recycled, so a single
drag can carry every player after it. That is why the offer exists at all.

Site side (`app.js?v=17`, `style.css?v=12`): the player overlay gains an
"Unlock free play" button and one explanatory line. `showUnlockOffer()` is the
only place that reveals it; the click sets `unlockRequested` and re-enters the
setup loop through `retrySetup` — re-running `playGame()` would re-open the
player, re-check the daily limit and count the play twice.

Tests: section 8 of `test_inline_provision.js` drives the real `playGame` — no
slider on Play, the offer visible, no session retry, then a click that runs the
check, seeds the account and starts the game. Section 11 of
`test_puzzle_cache.mjs` checks both halves of `canUnlock` (offered when the
budget allows it, withheld during a lockout).

**2.9.0 — why the button never appeared, and what replaced the silence.**

The 2.8.0 offer was dead on arrival, and the bug was one layer below the tests
that covered it: `createSessionAttempt` rebuilt the error event and copied only
`needVerification`. `capacity`, `canUnlock` and everything else the API sent were
dropped, so `wantsUnlock` was always false. Every player got the sentence about
bringing free play back *and a red error with no button* — a week of "free play
is down" with nothing anyone could press. The tests missed it because they
stubbed `createSession`, one layer above the mapping. It now goes through
`sessionEventError()`, and section 10 of `test_inline_provision.js` asserts the
fields survive.

An empty pool also stops being silent:

- `sessionErrorEvent` always names the two routes that exist — the opt-in check
  (with the account shared) and "play now with your own game account" — instead
  of telling people to retry in "a few minutes" into a wall.
- It adds **`unlockInSeconds`** (`0` when the check is open, otherwise how long
  until Raccoon's lockout or the local budget window ends), plus `pool` and
  `poolTarget`. Raccoon allows roughly one check per egress IP per ~20 minutes
  and every extra ask extends it, so "closed" is the normal state of a busy
  site.
- The site shows the offer **with a live countdown** and enables the button when
  it reaches zero, instead of hiding it (`app.js?v=18`, `style.css?v=13`). A
  second link, "Or play now with your own account", opens Settings → Account —
  that route never touches registration, the pool or the shared IP, so it works
  even when the check does not.
- A click is honoured as permission even against a 2.8.0 Worker that cannot say
  whether the check is open, and the puzzle modal no longer repeats the wait
  twice ("Try again in 47 seconds. Try again in 22s.").

**3.0.0 — nobody is turned away for being busy.**

Every wall on the play path became a place to wait. The complaint that forced
this was two sentences long: *"too many requests"* and *"IP error"*, on a site
whose players only ever pressed Play. Each of those was a real limiter doing its
job at the wrong moment, and each ended somebody's attempt:

- **The per-IP burst limit no longer covers the session endpoints.**
  `createSession`, `getQueue`, `startGame`, `pingSession`, `quitSession`,
  `capabilities` and `online` are exempt (`SESSION_PATHS`). 100 requests/minute
  per address sounds generous until a household, a school or a mobile carrier's
  NAT shares it — and pressing Play twice while the first attempt is still
  streaming counted twice. Those calls already queue behind
  `max_concurrent_sessions` and the registration slots, which is a throttle that
  still lets everybody in. The limit stays on the mailbox/code endpoints, where
  it protects a provider's quota rather than a player's click, and its answer is
  now a sentence (`RATE_LIMITED_MESSAGE`), never "Too many requests.".
- **The site's own per-minute cap waits instead of failing.** `waitForRateLimit`
  holds the player in the line (`reason: "limit"`) and starts the setup when the
  window reopens, instead of pushing `BUSY_MESSAGE` and closing the stream.
- **A registration slot is worth six minutes, not two and a half.**
  `ACCOUNT_SLOT_WAIT_MS` is now 6 min and `REAPER_DEADLINES.creating` is 12 min so
  the reaper cannot kill somebody who is legitimately still in line (it used to
  cut at 5 minutes, which is why long waits "just stopped").
- **A throttled account attempt is retried inside the player's stream.**
  `createAccountWithRetries` re-attempts a non-wall failure up to three times
  (8s/20s/40s, honouring a provider's `retry-after`), pushing
  `capacity_queue` with `reason: "provider"` and an `eta_seconds` between
  attempts. `createAccountRaw` already walked every mail lane with its own
  backoff; this covers the case it could not absorb. A tab that closes mid-wait
  stops immediately and spends no registration.
- **`noAccounts` is a separate signal from `capacity`.** Only an automatic
  account attempt blocked by Raccoon's registration gate sets it, and only that
  case carries `canUnlock`/`unlockInSeconds`. A 429 is congestion a drag cannot
  clear, so it must never show the Unlock button — which is exactly what the old
  `capacity`-only flag did.

Site side (`app.js?v=19`): the offer is gated on `noAccounts` (with a legacy
fallback for a pre-3.0.0 Worker), a busy answer is retried once after the wait it
asked for, busy text is no longer painted red or toasted as a failure, the
"own account" route is offered on a throttle too, and the queue line says which
line you are in ("#3 in line for a free account" vs "all server slots busy")
with an ETA when the API gives one.

Tests: `test_queue_everyone.js` (new) covers the burst exemption, the calm
rate-limit sentence, the `noAccounts` matrix, the in-stream retry, the wall not
being retried, and a closed tab spending nothing. Section 11 of
`test_inline_provision.js` drives the real `playGame` with a `capacity` /
`noAccounts: false` answer and asserts the button stays hidden, nothing turns
red, one retry happens and the own-account route is shown; section 12 pins the
legacy fallback.

**3.1.0 — the check's own allowance was causing the lockout it warned about.**

The message *"The game service is limiting human checks for about 15 minutes"*
showed up on both the free-play offer and Settings → Account, which is correct
behaviour and a bad number, for three reasons that compound:

- The local allowance was **six asks per 15 minutes**, while Raccoon's own
  ceiling is about five in a window and its refusal is `Too many puzzle attempts.
  Please try again in 3543 seconds.` So the budget allowed exactly the run that
  earns the hour-long block. It is now **three per hour** — deliberately slower
  than the pool target, because each solved check creates one account that is
  then reused forever, and three an hour beats a burst followed by an hour of
  nothing.
- The allowance was **in memory only**. Every deploy handed the new object a
  fresh window, so the first few players after a deploy spent the whole budget in
  a row and walked straight into the lockout. It is persisted now
  (`puzzleIssueTimes`) and loaded in `ready`.
- Both gates **shared one sentence that blamed the game service**, including our
  own budget. `puzzleUnavailable` now returns `limited_by: "service" | "site"`,
  `/healthz` reports `checks_left_this_hour` and `check_limited_by`, and the site
  says the true thing: Raccoon's lockout clears by itself, while the site's
  allowance is a choice we made and reopens gradually.

The modal copy is also neutral now (`app.js?v=20`): it opens from Play *and* from
Settings, where "press Play again later" was nonsense. Both versions say what a
check is for — one shared account — and point at the own-account route.

Tests: section 10 of `test_puzzle_cache.mjs` asserts three asks, the `site`
label, that the allowance is written to storage, and that a revived object still
honours it. Section 13 of `test_inline_provision.js` pins both sentences and the
legacy fallback for a Worker without `limited_by`.

**3.2.0 — the way in that needs no check at all.**

The owner registered at raccongame.com by hand and the game loaded straight
after a short queue, while this site stayed empty. That is the whole clue, and
re-probed directly on 2026-10-27 it says exactly which half is broken:

| Probe (from this machine, 2026-10-27) | Answer |
|---|---|
| `emailRegister` for `@tmaily.com`, junk code | `400 Human verification is required. Please request a new email code.` |
| `emailRegister` for `@duckmail.sbs`, junk code | same — so **duckmail is not blocked** |
| `emailRegister` for `@mail.gw` / `@niceground.shop` | `400 Temporary email addresses are not supported.` |
| `sendEmail` for a fresh, acceptable address | `400 Please complete the puzzle verification.` |
| `emailLogin` with real credentials | **a token, and no challenge at all** |

Two things fall out of that. First, the gate was never about mail domains —
`sendEmail` refuses even an address Raccoon is happy to accept, so no provider
swap and no amount of lane rotation can get an account made unattended. Second
and more usefully: **registration needs a human; logging in needs nothing.**

The check allowance is per *egress IP*. A player registering at Raccoon's own
site from their own connection has their own allowance and always succeeds — that
is why the owner's manual test worked. This Worker egresses from Cloudflare
addresses shared with the whole internet, so its allowance is tiny and shared:
that is the entire reason the pool cannot refill itself.

So the fix is not to defeat the gate but to stop depending on it:

- **`POST /cloud/v1/manualLogin`** `{email, password}` → Raccoon `emailLogin` →
  `{sn, token, email}`. No mailbox, no mail provider, no puzzle, no shared
  budget. An account a player made at raccongame.com works here as-is, and the
  token is the same shape `Play` already saves, so nothing else had to change.
- The site (Settings → Account, `app.js?v=21`) gained **"Use an account you
  already have"** with a *Share it with everyone* switch. On, it seeds the
  account into the pool via the existing `seedPool`, which is what turns one
  hand-made account into free play for everybody; off, the account is simply the
  player's. A share the pool refuses (usually because it is full) is reported as
  exactly that, never as a success.
- `NO_ACCOUNT_MESSAGE` and `OUTAGE_MESSAGE` now name that destination instead of
  ending on "Nothing is wrong on your side" with nothing to press.

Tests: `test_verification_visibility.js` §13–15 pin that a sign-in reaches
`emailLogin` and nothing else (no captcha, no `sendEmail`, no `emailRegister`),
that a refusal passes Raccoon's own reason through without starting a cooldown,
and that the token is read from the cookie when it lands there. §14 of
`test_inline_provision.js` drives the real `signInExistingAccount()` — the account
is saved where `Play` reads it, the switch seeds it, an unshared sign-in seeds
nothing, and a refused one saves nothing.

## "I redeployed and nothing changed"

The most common cause is that the new build is not the one being served — an edge
cache holding `js/app.js?v=N`, or an upload that landed somewhere else. Nothing
about the old and new builds looks different from the outside, so check instead
of guessing:

1. **The site says it out loud.** Settings → Account prints either
   `✓ API build <version> — the human check is available.` or the actual reason
   it failed (unreachable, 401 key, 403 origin, or an older API). The **Check API
   build** button re-runs it on demand. `node .freebuff/test_puzzle_relay.js`
   asserts the same endpoint.
2. **Bump the site's asset version.** `js/app.js?v=…` in `index.html` is part of
   the URL, so a browser that already has `?v=9` will keep serving it from cache
   even after the file is replaced. Change the number whenever `app.js` or
   `style.css` changes.
3. **A 403 here is the origin allowlist, not a stale build.** `src/sites.js`
   lists the allowed origins; add the address you are actually loading the site
   from (an origin the list does not name answers `403 Origin not allowed`, which
   looks exactly like "the check is missing").
4. **Confirm the endpoints exist**: `curl -s <api>/cloud/v1/capabilities -H
   "x-api-key: <your key>"`. A 404 means the Worker being served predates the
   human-check work.

**Paths forward** (this needs a decision, not a patch):

1. **Reuse accounts across sessions — implemented.** Every session used to burn
   a brand-new Raccoon account, which is exactly the volume that got the
   registration endpoint gated in the first place; a real player registers once
   and then plays many games. `recycleAccount()` now returns a finished
   session's account to the pool, so the next player reuses it.

   - A fresh (`plays === 0`) account is preferred, then the **least-used**, which
     spreads reuse across the pool instead of hammering one account.
   - The play count is stored with the account and survives a restart.
   - Accounts are **not** recycled when the account is what failed:
     `upstream_terminated` (Raccoon's status 3013), `creation_error`, an account
     that hit the play-credits retry, a session that never left `creating`, or an
     account a player supplied themselves (it is theirs, not the pool's).
   - `GHOSTCLOUD_REUSE_ACCOUNTS = "off"` restores one-account-per-session.
   - `diagMail` reports `reuse: { enabled, ready, fresh, reused, totalPlays }`.
     A pool that stays mostly `reused` is the confirmation that registration
     volume has dropped as intended.

   Verified with `node .freebuff/test_account_reuse.js`: **three sessions, one
   registration, one pooled account.**

   The caveat is play credits — a fresh account may have credits a reused one
   has spent. That is what the existing `isDiamondError` retry works around, and
   an account that trips it is marked dead rather than pooled, so the same
   failure cannot be handed on to the next player.
2. **Own-domain mail lane** (`GHOSTCLOUD_MAIL_DOMAIN` +
   `GHOSTCLOUD_INBOUND_KEY` + Cloudflare Email Routing → the Email Worker).
   Removes the free-provider rate limits and the domain blocklisting, but does
   not by itself defeat a client-side bot check.
3. **Manual accounts.** Wired to the site's `getManualAccount()`: a player who
   has their own Raccoon account can supply `{sn, token}` and skip registration
   entirely. These sessions take no registration slot and their account is never
   pooled — the test above asserts both. The settings screen now also *creates*
   an account through the puzzle (see above) and, when the mailbox came from this
   site rather than the player's inbox, hands it to `seedPool` instead of keeping
   it locally: one solved puzzle then serves every player after it, and two live
   copies of one account cannot knock each other off.

   The risk this carries, stated plainly: Raccoon put that check there to stop
   automated signups, and rate-limits it per address. Relaying a human's solve
   keeps the check meaningful — no offset is ever computed by a machine — but it
   still means accounts are created from one shared egress address at whatever
   rate players solve puzzles. If Raccoon tightens that limit, the honest answer
   is an official arrangement with them rather than a cleverer relay.

**3.2.1 — an empty pool answers now instead of after six minutes.** Reproduced
live on 2026-10-29 with the pool at 0: one Play request sat at `#10` in the
`account_setup` line, reached the front after **364 seconds**, and was answered
with "We're at our busiest right now…" — `needVerification: false`, no
`noAccounts`, and nothing to click. The cause was not the queue being slow but
the queue being pointless: with the pool empty and every fill failing, the two
registration slots are held by attempts that cannot succeed, so the player waits
out `ACCOUNT_SLOT_WAIT_MS` (6 min) for an account that was never coming.

- **The slot timeout is labelled.** `waitForAccountSlot`'s failure threw
  `{busy: true}` without `auto`, so `sessionErrorEvent` treated it as a generic
  congestion and printed `BUSY_MESSAGE`. It now carries `auto`, and with an
  empty pool that is not being refilled (`poolFillFails >= 3` or a wall) the
  event says `noAccounts: true` with `NO_ACCOUNT_MESSAGE` — the label the site
  turns into the human check. A healthy pool keeps the busy wording.
- **The doomed wait is skipped.** Before `waitForAccountSlot`, an empty pool
  with failing fills answers at once, and `createAccountWithRetries` no longer
  spends three rounds (~70s of gaps) finding out what the fill loop already
  knows. `poolFilling` is excluded: a fill in flight may still succeed.

The effect is that a dead pool costs a player a sentence, not six minutes of
line. It does not by itself create accounts — that still needs the check or a
player's own account — which is why the wording names both.Verified with a Hub-level check of the event (`noAccounts`, the honest sentence,
 the wall countdown, the healthy-pool and manual-path cases) plus the existing
`test_verification_visibility.js` and `test_raccoon_wall.js`.

**3.2.2 — the pool was empty because no mailbox can be made at all.** `/diagMail`
on 2026-10-29, live: `tempmail.lol` HTTP 429, `api.duckmail.sbs` *every domain*
refused with "Temporary email addresses are not supported.", `api.mail.gw` HTTP
521, `ownDomain: (not configured)`, and Raccoon's own `sendEmail` answering
"Please complete the puzzle verification." (`walled: true`). Three separate
failures, none of them the "busy" the player was shown.

The domain question is now closed empirically: `maxxspace.com` (mail.tm),
`sharklasers.com` and `guerrillamail.com` (Guerrilla Mail) all answer the same
domain refusal, so **no free provider can ever work again**. A registration code
needs a domain whose reputation Raccoon has not retired — the own-domain lane,
or an account the player already has.

- **`mailRouteDead()`** — no own domain, and every lane has failed at least five
  times without one success. A lane that has never been tried does not count as
  dead (a cold start is not proof of failure).
- **`createMailbox` names the route.** When every lane throws and the route is
  dead it answers `MAIL_REFUSED_MESSAGE` with `needOwnAccount: true`, instead of
  `BUSY_MESSAGE` ("try again in a moment") for a condition no retry can change.
- **No check is spent on an undeliverable address.** `captchaChallenge` refuses
  before `takePuzzleBudget()`, because a solve whose code can never arrive costs
  one of the three hourly checks every other player shares.
- **`/healthz` says `mail_lanes_dead`** and reports `mail_route:
  own_domain|dead|free_lanes`. `pool_fill_failing` was true but useless: it
  pointed at the fill loop, not at the dead providers.

What actually restores free play, in order of effort:

1. **Sign in with an account you already have** (works today, no infra). Raccoon
   gates registration, not login; `manualLogin` + the share switch seeds it into
   the pool, and `GHOSTCLOUD_REUSE_ACCOUNTS` keeps that account serving players
   afterwards.
2. **Own-domain lane** — any domain (~$10/yr), Cloudflare Email Routing catch-all
   → the Email Worker, then `GHOSTCLOUD_MAIL_DOMAIN` + `GHOSTCLOUD_INBOUND_KEY`.
   The code is pushed straight into the Worker, so no provider outage and no
   blocklist can stop it. Each human solve then creates a reusable pooled account
   (three an hour at most, and reuse means they are not re-registered).

Verified on the built file with a Hub-level check of `mailRouteDead`, the health
reason, the mailbox answer, the challenge refusal (and that it spends no budget),
plus `test_puzzle_cache.mjs` (which also asserts the opt-in unlock offer is
still made), `test_raccoon_wall.js`, `test_account_reuse.js` and
`test_verification_visibility.js`.
