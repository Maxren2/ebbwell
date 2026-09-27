# Lune

A private, self-hosted period tracker and ovulation estimator. It runs as a web app you can install on iPhone and Android, is hosted on your own TrueNAS, and uses Authentik for login.

- **Reliable by design.** Lune learns from the user's own cycles and reports ranges and confidence instead of a single "day 14". It confirms ovulation with the Sensiplan temperature rule (both exceptions included), the cervical-mucus peak day and LH tests. It flags irregular cycles using FIGO 2018 thresholds and detects late periods. See [docs/PROPOSAL.md](docs/PROPOSAL.md) for the research behind each feature.
- **Private.** Every health record is encrypted with AES-256-GCM in the database. Login uses OIDC with PKCE against Authentik. The CSP is strict, and the app makes zero third-party requests. The service worker caches only the app shell, never health data. Users get full export and one-click deletion.
- **Simple to run.** One container on Node 24 using its built-in SQLite, with no native modules. The server needs no build step and writes one data directory with daily backups.

> Lune is a journal, **not a medical device and not a contraceptive**. The Sensiplan evaluation is opt-in and meant for people who have learned the method.

## Screens

| Today | Calendar | Chart | Insights | Settings |
|---|---|---|---|---|
| Cycle ring, next period ± range, ovulation status, alerts | Logged / predicted period, fertile window, ovulation (confirmed vs estimated) | Temperature curve, cover line, higher readings, mucus / bleeding / LH rows | Cycle statistics, regularity, per-cycle ovulation & luteal length, exclude cycle | Goal, tracking options, units, export/import, devices, delete all |

## Deploy

See **[docs/DEPLOY.md](docs/DEPLOY.md)** for Authentik, TrueNAS "Install via YAML", reverse proxy, phone installation, backups and key rotation.

## Develop

```bash
npm ci
cp .env.example .env.dev    # then set AUTH_MODE=dev, ALLOW_INSECURE_DEV_AUTH=true, APP_URL=http://localhost:8080, DATA_DIR=.data and a key
npm run build               # builds the PWA into dist/
node --env-file=.env.dev scripts/seed-demo.ts   # optional: 7 demo cycles
node --env-file=.env.dev server/index.ts        # http://localhost:8080/auth/login
```

`npm run dev:web` runs Vite with hot reload on :5173, proxying `/api` and `/auth` to :8080. The service worker is only active in the built app.

```bash
npm test          # engine rules, API security, encryption, OIDC flow against a mock provider
npm run typecheck
```

## Layout

```
shared/   cycle engine (pure TS, runs in the browser) + zod schemas
server/   Fastify API, OIDC, sessions, encrypted SQLite store, backups
web/      React PWA
test/     vitest suites
deploy/   TrueNAS compose file
docs/     proposal & deployment guide
```
