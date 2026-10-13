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

Measured end-to-end in workerd (`node .freebuff/test_wall_live.js`): attempt 1
~2.3s and records `raccoonWallCooldownSeconds: 600`; attempt 2 answers in **0.1s**
with zero outbound requests. `node .freebuff/test_raccoon_wall.js` pins the
cooldown, the zero-request guarantee, the alarm suppression, the restart
round-trip, and the message wording. `node .freebuff/test_puzzle_relay.js` pins
the relay contract: real challenge with data-URI images and geometry, the `sn`
that has to be reused, a wrong offset rejected rather than passed, the
`needVerification` flag that makes the site open the puzzle, and seeding the pool
exactly once per account.

### Still unproven: the success path

Every part of the relay is verified except the one that needs a human eye: **no
correct-offset solve has been confirmed end-to-end from here.** Probing the
puzzle repeatedly tripped Raccoon's per-address limit, after which even a
brand-new challenge answers `"The puzzle has expired"` — so a recorded
*successful* verify (`{verified: true}` → `sendEmail` → code) is still
unconfirmed by the author of this change. It is the same two calls their own site
makes, and the widget math was read off their file rather than guessed, but treat
it as verified-by-construction until someone solves one.

To confirm it in 30 seconds: open the site → Settings → Account → **Get temp
mailbox** → **Solve check & continue** → drag the piece into the gap. A working
run ends with `✓ Account created and shared` and `diagMail` showing `pool 1/6`.

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
