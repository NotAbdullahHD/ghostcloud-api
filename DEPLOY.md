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

`GHOSTCLOUD_POOL_TARGET` (pre-warmed accounts, 3–20) is set to `3` in
`wrangler.toml`; override it here if you want a different size. Each pre-warmed
account is a full registration, and topping the pool up is what drives the
alarm loop — a bigger pool costs more of the daily request budget.

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
  target. Now 3.

If real traffic still exceeds 100k/day, **Workers Paid ($5/mo)** removes the
daily cliff entirely (10M requests/month included). That is the honest fix once
the site has steady users.
