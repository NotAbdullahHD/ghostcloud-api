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

`GHOSTCLOUD_POOL_TARGET` (pre-warmed accounts, 3–20) is already set to `10` in
`wrangler.toml`; override it here if you want a different size.

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
