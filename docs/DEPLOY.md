# Deploying Lune on TrueNAS SCALE behind Authentik

```
Phone / browser ──HTTPS──► reverse proxy ──HTTP──► TrueNAS :30480 ──► Lune container ──► /mnt/<pool>/apps/lune
                                                                         │
                                  Authentik ◄──── OIDC (discovery, token exchange, JWKS)
```

Lune performs the Authentik login **itself** (OpenID Connect, authorization code + PKCE) and verifies every ID token. It never trusts identity headers, so **don't put Authentik forward-auth in front of it**. It isn't needed, and it breaks the PWA: the manifest, service worker and API calls would get redirected to the login page.

## 1. Authentik

1. **Group** (optional but recommended): *Directory → Groups → Create* `lune-users`, and add the people who may use the app.
2. **Provider**: *Applications → Providers → Create → OAuth2/OpenID Provider*
   - Name: `Lune`
   - Authorization flow: `default-provider-authorization-implicit-consent`
   - Client type: **Confidential**. Note the *Client ID* and *Client Secret*.
   - Redirect URIs: `strict` · `https://lune.example.com/auth/callback`
   - Signing key: **authentik Self-signed Certificate** (RS256). Don't leave it empty.
   - Scopes: keep the defaults (`openid`, `profile`, `email`). Lune only requests `openid profile` and stores just the display name.
   - Subject mode: *Based on the User's hashed ID* (default)
3. **Application**: *Applications → Applications → Create*
   - Name `Lune`, slug `lune`, provider `Lune`, launch URL `https://lune.example.com`
   - *Policy / Group / User Bindings* → bind group `lune-users`. Authentik then refuses everyone else before they reach Lune. Lune double-checks with `OIDC_ALLOWED_GROUPS`.
4. The issuer is `https://auth.example.com/application/o/lune/`, as shown on the provider page as *OpenID Configuration Issuer*.

Signing out of Lune also ends the Authentik session (`OIDC_LOGOUT_SSO=true`), which is what you want on a shared device.

## 2. TrueNAS

1. **Dataset:** *Datasets → Add Dataset* `apps/lune`.
   - Tick **Encryption** (recommended: protects the data if disks or snapshots leave the machine).
   - Permissions: owner user/group **apps (568)**, mode `700`.
2. **Snapshots:** *Data Protection → Periodic Snapshot Tasks* on `apps/lune`, for example daily with 30-day retention. Add a replication task if you have a second machine.
3. **Encryption key for the app:** generate it once and store it in your password manager.
   ```bash
   openssl rand -base64 32
   ```
   Without this key the database and backups **cannot be decrypted**.
4. **Image access:** the repository is private, so the GHCR image is private too. Pick one option:
   - Add a registry credential in TrueNAS (*Apps → Configuration → Manage Container Image Registries* on 25.04+). Use registry `ghcr.io`, your GitHub username, and a classic personal access token with only `read:packages`.
   - Or build the image on the NAS (`docker build -t lune:local .` from a clone) and set `image: lune:local`.
5. **Install:** *Apps → Discover Apps → ⋮ → Install via YAML*. Paste [`deploy/truenas-compose.yaml`](../deploy/truenas-compose.yaml) and replace every `CHANGE_ME`.

The container runs as UID 568 with a read-only root filesystem, no Linux capabilities and `no-new-privileges`. It writes only to `/data`.

## 3. Reverse proxy

Terminate TLS at your proxy and forward to `http://<nas-ip>:30480`. Don't forward the port from the internet directly.

- **Nginx Proxy Manager:** new proxy host `lune.example.com` → `http://<nas-ip>:30480`. Enable *Force SSL*, *HTTP/2* and *HSTS*. No custom locations or forward-auth needed.
- **Traefik:** a router for `Host(\`lune.example.com\`)` with TLS, pointing at the service on port 8080 (or `<nas-ip>:30480`). No `forwardAuth` middleware.
- **Caddy:**
  ```
  lune.example.com {
      reverse_proxy <nas-ip>:30480
  }
  ```

Set `TRUST_PROXY` to your proxy's address range so rate limiting sees real client IPs (default: loopback + private ranges).

## 4. Install on phones

- **iPhone / iPad:** open `https://lune.example.com` in **Safari** → *Share* → *Add to Home Screen*. Open the app from the icon and sign in once. The installed app keeps its own cookies, separate from Safari.
- **Android:** open it in Chrome → menu → *Install app* (or accept the install banner).
- **Desktop:** Chrome/Edge show an install icon in the address bar. It also works as a normal web page.

Sessions last 14 days of inactivity and 90 days at most. You can change this with `SESSION_IDLE_DAYS` / `SESSION_MAX_DAYS`. See and revoke devices in *Settings → Signed-in devices*.

## 5. Backups and restore

- Lune writes a consistent SQLite backup to `/data/backups/` once a day and keeps `BACKUP_RETENTION_DAYS` (14) of them. Backups are encrypted the same way as the live database.
- To restore: stop the app, then replace `lune.sqlite` with a backup file and delete `lune.sqlite-wal` and `lune.sqlite-shm`. Start the app again with the **same** `DATA_ENCRYPTION_KEY`.
- Users can also export their own data (JSON/CSV) from *Settings → Your data*. Exports are **not** encrypted.

## 6. Rotating the encryption key

1. Generate a new key.
2. Set `DATA_ENCRYPTION_KEY=<new>` and `DATA_ENCRYPTION_KEY_PREVIOUS=<old>`, then restart. The log says *Key rotation: re-encrypted N records*.
3. Remove `DATA_ENCRYPTION_KEY_PREVIOUS` and restart. Old backups still need the old key, so keep it until those backups expire.

## 7. Updating

The CI publishes `ghcr.io/maxren2/lune:latest` on every push to `main`, plus version tags such as `v0.2.0`. In TrueNAS, update the app (or pin a version tag in the YAML). Database migrations run automatically at startup, and the daily backup gives you a rollback point.
