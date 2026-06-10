# Deploying skoda-reports to Render

This service is wired to deploy to **Render.com** out of the box. The
SQLite datamart auto-seeds on first boot, so there's no separate build
step to remember.

## Prerequisites

* A GitHub account
* A free Render account ([render.com](https://render.com))

## One-time setup (~5 minutes)

### 1. Push the folder to GitHub

If `skoda-reports/` is its own repo, push the whole thing:

```bash
cd skoda-reports
git init
git add .
git commit -m "skoda-reports: initial deploy"
git branch -M main
git remote add origin git@github.com:<you>/skoda-reports.git
git push -u origin main
```

If `skoda-reports/` lives inside the parent `dms/` repo, push the parent
repo as-is — `render.yaml` already sets `rootDir: skoda-reports`, so
Render will only build that subfolder.

### 2. Create the service on Render

1. Log in at <https://dashboard.render.com>.
2. **New +** → **Blueprint**.
3. Connect the GitHub repo you just pushed.
4. Render reads `render.yaml`, shows **skoda-reports** as the service it
   will create. Click **Apply**.
5. First build takes ~2 minutes (`npm install`); first boot then runs
   `seed.js` automatically and starts serving on port 10000 (mapped to
   the public HTTPS URL Render gives you).

That's it — open the URL Render shows you and the dashboard is live.

### 3. (Optional) Custom domain

Render → your service → **Settings** → **Custom Domain** →
add `reports.example.com` and copy the CNAME target into your DNS.
HTTPS is provisioned automatically.

## How the deploy is wired

| File              | Purpose                                                              |
|-------------------|----------------------------------------------------------------------|
| `render.yaml`     | Render Blueprint — declares the service, plan, build/start commands. |
| `package.json`    | `"engines": { "node": ">=20" }` pins the Node version on Render.     |
| `seed-runner.js`  | Lets `server.js` invoke `seed.js` programmatically on first boot.    |
| `server.js`       | `ensureDb()` checks for `data/reports.sqlite3` and seeds if missing. |
| `.gitignore`      | Excludes `node_modules/`, `data/`, `server.log`.                     |

## Free tier caveats

* **Spins down after ~15 min of inactivity.** First request after a
  cold start takes ~30 seconds while Render wakes the container.
  Upgrade to **Starter ($7/mo)** to keep it always-on.
* **Disk is ephemeral.** Every redeploy / wake-from-sleep wipes
  `data/reports.sqlite3`. The seeder regenerates it on boot, which is
  fine for the synthetic dataset shipped here. **For real DMS data,
  upgrade to Starter and add a persistent disk:**

  ```yaml
  # in render.yaml under the service:
  disk:
    name: reports-data
    mountPath: /opt/render/project/src/skoda-reports/data
    sizeGB: 1
  ```

* **No outbound DB connection.** This service reads only its own
  SQLite file, so no external connection limits or whitelist setup is
  required.

## Updating the deployed app

Push to your `main` branch — Render auto-deploys (`autoDeploy: true` in
`render.yaml`). Each deploy:

1. Runs `npm install`
2. Starts `npm start` (which runs `ensureDb()` then `app.listen()`)
3. Health-checks `/api/meta`; if it returns 200, traffic switches to
   the new instance.

## Smoke test after deploy

```bash
curl https://<your-service>.onrender.com/api/meta | jq '.reports | length'
# expect: 9
```

## Alternative: deploy somewhere else

The same code runs unchanged on:

* **Railway** — connect the repo, set Root Directory to `skoda-reports`,
  it picks up Node automatically.
* **Fly.io** — `fly launch` from inside `skoda-reports/`, accept the
  defaults, then `fly deploy`.
* **Docker / VPS** — see `Dockerfile` (not yet committed; ask if you
  want one written).

The only requirement of the host is: Node 20+, a writable `data/`
directory, and an inbound port mapped to whatever `process.env.PORT`
the host injects.
