# Deploying Ebbwell on TrueNAS SCALE behind Authentik

```
Phone / browser ──HTTPS──► reverse proxy ──HTTP──► TrueNAS :30480 ──► Ebbwell container ──► /mnt/<pool>/apps/ebbwell
                                                                         │   │
                                  Authentik ◄──── OIDC (discovery, token exchange, JWKS)
                     Apple / Google / Mozilla / Microsoft push services ◄── encrypted Web Push (reminders)
```

Ebbwell performs the Authentik login **itself** (OpenID Connect, authorization code + PKCE) and verifies every ID token. It never trusts identity headers, so **don't put Authentik forward-auth in front of it**. It isn't needed, and it breaks the PWA: the manifest, service worker and API calls would get redirected to the login page.

Any OIDC provider works (Authentik, Authelia, Keycloak, Pocket ID, Zitadel…). Authentik is used as the example below.

## 1. Authentik

1. **Group** (optional but recommended): *Directory → Groups → Create* `ebbwell-users`, and add everyone who may use the app, partners included.
2. **Provider**: *Applications → Providers → Create → OAuth2/OpenID Provider*
   - Name: `Ebbwell`
   - Authorization flow: `default-provider-authorization-implicit-consent`
   - Client type: **Confidential**. Note the *Client ID* and *Client Secret*.
   - Redirect URIs: `strict` · `https://ebbwell.example.com/auth/callback`
   - Signing key: **authentik Self-signed Certificate** (RS256). Don't leave it empty.
   - Scopes: keep the defaults (`openid`, `profile`, `email`). Ebbwell only requests `openid profile` and stores just the display name.
   - Subject mode: *Based on the User's hashed ID* (default)
3. **Application**: *Applications → Applications → Create*
   - Name `Ebbwell`, slug `ebbwell`, provider `Ebbwell`, launch URL `https://ebbwell.example.com`
   - *Policy / Group / User Bindings* → bind group `ebbwell-users`. Authentik then refuses everyone else before they reach Ebbwell. Ebbwell double-checks with `OIDC_ALLOWED_GROUPS`.
4. The issuer is `https://auth.example.com/application/o/ebbwell/`, as shown on the provider page as *OpenID Configuration Issuer*.

Signing out of Ebbwell also ends the Authentik session (`OIDC_LOGOUT_SSO=true`), which is what you want on a shared device.

**Forgotten app-lock PIN:** *Forgot PIN? Sign in again* sends the user to Authentik with `prompt=login` and `max_age=0`. Ebbwell only allows a PIN reset when the returned `auth_time` is less than 5 minutes old. So a still-valid Authentik SSO cookie is **not** enough: the user must actually enter their Authentik credentials (and MFA, if configured).

## 2. TrueNAS

1. **Dataset:** *Datasets → Add Dataset* `apps/ebbwell`.
   - Tick **Encryption** (recommended: protects the data if disks or snapshots leave the machine).
   - Permissions: owner user/group **apps (568)**, mode `700`.
2. **Snapshots:** *Data Protection → Periodic Snapshot Tasks* on `apps/ebbwell`, for example daily with 30-day retention. Add a replication task if you have a second machine.
3. **Encryption key for the app:** generate it once and store it in your password manager.
   ```bash
   openssl rand -base64 32
   ```
   Without this key the database and backups **cannot be decrypted**.
4. **Install:** *Apps → Discover Apps → ⋮ → Install via YAML*. Paste [`deploy/truenas-compose.yaml`](../deploy/truenas-compose.yaml) and replace every `CHANGE_ME`. The image `ghcr.io/maxren2/ebbwell` is public.

The container runs as UID 568 with a read-only root filesystem, no Linux capabilities and `no-new-privileges`. It writes only to `/data`. It needs outbound HTTPS to your identity provider and, for reminders, to the browsers' push services.

## 3. Reverse proxy

Terminate TLS at your proxy and forward to `http://<nas-ip>:30480`. Don't forward the port from the internet directly.

- **Nginx Proxy Manager:** new proxy host `ebbwell.example.com` → `http://<nas-ip>:30480`. Enable *Force SSL*, *HTTP/2* and *HSTS*. No custom locations or forward-auth needed.
- **Traefik:** a router for `Host(\`ebbwell.example.com\`)` with TLS, pointing at the service on port 8080 (or `<nas-ip>:30480`). No `forwardAuth` middleware.
- **Caddy:**
  ```
  ebbwell.example.com {
      reverse_proxy <nas-ip>:30480
  }
  ```

Set `TRUST_PROXY` to your proxy's address range so rate limiting sees real client IPs (default: loopback + private ranges).

## 4. Install on phones

- **iPhone / iPad:** open `https://ebbwell.example.com` in **Safari** → *Share* → *Add to Home Screen*. Open the app from the icon and sign in once. The installed app keeps its own cookies, separate from Safari.
- **Android:** open it in Chrome → menu → *Install app* (or accept the install banner).
- **Desktop:** Chrome/Edge show an install icon in the address bar. It also works as a normal web page.

Sessions last 14 days of inactivity and 90 days at most. You can change this with `SESSION_IDLE_DAYS` / `SESSION_MAX_DAYS`. See and revoke devices in *Settings → Signed-in devices*.

## 5. Reminders (Web Push)

- In *Settings → Reminders*, tap **Enable notifications on this device**. On iPhone and iPad this only works in the app installed to the Home Screen (iOS 16.4+).
- Available reminders:
  - morning temperature;
  - evening check-in;
  - period coming (0–7 days before);
  - fertile window starting (conceive/avoid goals);
  - partner's period coming.
- Payloads are end-to-end encrypted to the device, so the push services can't read them. *Discreet wording* (on by default) keeps the lock-screen text generic.
- Push keys (VAPID) are generated on first start and stored encrypted in the database. To pin them yourself, set `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`, and optionally `VAPID_SUBJECT` (`mailto:` or `https:`, defaults to `APP_URL`).

## 6. App lock (PIN and biometrics)

*Settings → App lock* adds a 4–8 digit PIN on top of the Authentik login. It is enforced by the server, per session:

- Locks when the user leaves the app, or after 1, 5, 15 or 60 minutes of inactivity.
- New sign-ins start locked.
- Five wrong PINs sign that device out.
- Face ID, Touch ID or an Android fingerprint can unlock it (WebAuthn platform authenticator, user verification required). Register it per device from the same screen.

## 7. Partner sharing

*Settings → Sharing with a partner → Invite a partner* creates a single-use link, valid 7 days. The partner needs their own account in the allowed group.

- The partner gets a read-only view: period predictions and cycle day, plus the scopes the owner picked (fertility, history, symptoms and mood).
- Notes, sex, pregnancy tests and cervix observations are never shared.
- Either side can end the share at any time.

## 8. Backups and restore

- Ebbwell writes a consistent SQLite backup to `/data/backups/` once a day and keeps `BACKUP_RETENTION_DAYS` (14) of them. Backups are encrypted the same way as the live database.
- To restore: stop the app, then replace `ebbwell.sqlite` with a backup file and delete `ebbwell.sqlite-wal` and `ebbwell.sqlite-shm`. Start the app again with the **same** `DATA_ENCRYPTION_KEY`.
- Users can also export their own data (JSON/CSV) from *Settings → Your data*. Exports are **not** encrypted.

## 9. Rotating the encryption key

1. Generate a new key.
2. Set `DATA_ENCRYPTION_KEY=<new>` and `DATA_ENCRYPTION_KEY_PREVIOUS=<old>`, then restart. The log says *Key rotation: re-encrypted N records*.
3. Remove `DATA_ENCRYPTION_KEY_PREVIOUS` and restart. Old backups still need the old key, so keep it until those backups expire.

## 10. Updating

The CI publishes `ghcr.io/maxren2/ebbwell` for every version tag (`0.2.0`, …) and `latest` for `main`. Pin a version in the YAML and update it deliberately. Database migrations run automatically at startup, and the daily backup gives you a rollback point.
