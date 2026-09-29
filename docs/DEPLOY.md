# Deploying Ebbwell on TrueNAS SCALE

```
Phone / browser ──HTTPS──► reverse proxy ──HTTP──► TrueNAS :30504 ──► Ebbwell container ──► /mnt/<pool>/apps/ebbwell
                                                                         │   │
                                  Authentik ◄──── OIDC (discovery, token exchange, JWKS)
                     Apple / Google / Mozilla / Microsoft push services ◄── encrypted Web Push (reminders)
```

Ebbwell performs the Authentik login **itself** (OpenID Connect, authorization code + PKCE) and verifies every ID token. It never trusts identity headers, so **don't put Authentik forward-auth in front of it**. It isn't needed, and it breaks the PWA: the manifest, service worker and API calls would get redirected to the login page.

Any OIDC provider works (Authentik, Authelia, Keycloak, Pocket ID, Zitadel…); Authentik is used as the example below.
Ebbwell also has **local accounts** (username + password), and you decide from which networks they may sign in. See section 2.

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

**Forgotten app-lock PIN:** for single sign-on users, *Forgot PIN? Sign in again* sends them to Authentik with `prompt=login` and `max_age=0`. Ebbwell only allows a PIN reset when the returned `auth_time` is less than 5 minutes old. So a still-valid Authentik SSO cookie is **not** enough: the user must actually enter their Authentik credentials (and MFA, if configured). Local accounts simply sign in again with their password.

## 2. Local accounts: where passwords are accepted

A login form reachable from the internet is an attack surface. So by default Ebbwell accepts **no passwords at all** (`LOCAL_LOGIN=disabled`), and you choose where local accounts may sign in.

| `LOCAL_LOGIN` | Password sign-in allowed | Typical use |
|---|---|---|
| `disabled` (default) | Nowhere; single sign-on only | Everyone has an Authentik account |
| `local-network` (recommended with local accounts) | Only from `LOCAL_NETWORKS`, **and never through the public domain** | SSO from outside and through the domain; passwords only at home, by the NAS address (e.g. `http://192.168.1.10:30504`) |
| `everywhere` | From anywhere, including the public domain | Not recommended |

With `local-network`, the public domain never even shows a password form. It sends people straight to single sign-on, and a password posted there is refused.

How Ebbwell decides, on every request:

- **Local network.** The connecting address *and every* client address forwarded by proxies (`X-Forwarded-For`, `X-Real-IP`, `Forwarded`) must be in `LOCAL_NETWORKS` (default: loopback + private ranges). A public or unparseable address anywhere in the chain means "outside". This fails closed, even if `TRUST_PROXY` is wrong.
- **Public domain.** The request's `Host` (or a forwarded host) equals the host of an `https://` `APP_URL`. An `http://` `APP_URL` means a LAN-only install without a public domain.
- **Never over plain HTTP from outside.** Even with `everywhere`, passwords are only accepted over plain HTTP when the client is on the local network.
- **Sessions follow the same rule.** A local account's session is refused wherever its sign-in would be refused.

**Check it yourself:** *Settings → Administration* shows how the current connection is classified (local or not, through the domain or not, HTTPS or not, password sign-in allowed or not) and the addresses it saw. Do this once from outside, for example on mobile data.

**Plain HTTP on the LAN.** Browsers only keep `Secure` cookies over HTTPS, so direct `http://nas-ip:port` access uses a separate, non-Secure, HTTP-only session cookie that is valid only for that address. Service workers, reminders, app installation and biometrics need HTTPS. Over plain HTTP, Ebbwell works as a regular web page, and the PIN lock still works.

**Accounts and administrators:**

- **First administrator.** Set `ADMIN_USERNAME` / `ADMIN_PASSWORD`; the account is created at startup if it doesn't exist. Remove the password from the configuration afterwards. Single sign-on users can be administrators through `OIDC_ADMIN_GROUPS`.
- **Other accounts.** In *Settings → Administration*, administrators create local accounts (with a one-time temporary password the user must replace), reset passwords, grant admin rights, disable or delete accounts.
- **Limits.** The last active administrator can't be removed. Administrators **never** see anyone's cycle data.
- **Where the policy lives.** It is deployment configuration, not an in-app setting, so a stolen administrator session cannot open password sign-in to the internet.
- **Password rules.** At least 10 characters, not containing the username. 10 wrong passwords lock the account for 15 minutes, and each device is rate-limited to 10 attempts per minute.

**Two-factor authentication (local accounts).** Users turn it on in *Settings → Account* with any authenticator app (Aegis, 2FAS, Google/Microsoft Authenticator, 1Password…), and receive 10 single-use recovery codes.

- `LOCAL_2FA=required` makes it mandatory: right after their password, users must set it up before they can do anything else. It pairs well with `LOCAL_LOGIN=everywhere`.
- The secret and recovery codes are stored encrypted (AES-256-GCM, covered by key rotation).
- A code can't be used twice, and wrong codes count toward the account lockout.
- Turning 2FA off or creating new recovery codes needs the password *and* a current code.
- If someone loses both their phone and their recovery codes, an administrator uses *Reset two-factor*; the user then signs in with the password and sets it up again.
- Single sign-on users get their second factor from the identity provider (e.g. Authentik MFA).

**Recovery from the server** (for example, a forgotten admin password):

```bash
docker exec -it <container> node server/cli.ts list-users
docker exec -it <container> node server/cli.ts reset-password <username>   # prints a temporary password
docker exec -it <container> node server/cli.ts set-admin <username> on
docker exec -it <container> node server/cli.ts enable <username>           # re-enable + clear a lockout
docker exec -it <container> node server/cli.ts disable-2fa <username>      # lost authenticator and recovery codes
```

## 3. TrueNAS

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

## 4. Reverse proxy

Terminate TLS at your proxy and forward to `http://<nas-ip>:30504`. Don't forward the port from the internet directly.

- **Nginx Proxy Manager:** new proxy host `ebbwell.example.com` → `http://<nas-ip>:30504`. Enable *Force SSL*, *HTTP/2* and *HSTS*. No custom locations or forward-auth needed.
- **Traefik:** a router for `Host(\`ebbwell.example.com\`)` with TLS, pointing at the service on port 8080 (or `<nas-ip>:30504`). No `forwardAuth` middleware.
- **Caddy:**
  ```
  ebbwell.example.com {
      reverse_proxy <nas-ip>:30504
  }
  ```

Set `TRUST_PROXY` to your proxy's address range so rate limiting sees real client IPs (default: loopback + private ranges).

## 5. Install on phones

- **iPhone / iPad:** open `https://ebbwell.example.com` in **Safari** → *Share* → *Add to Home Screen*. Open the app from the icon and sign in once. The installed app keeps its own cookies, separate from Safari.
- **Android:** open it in Chrome → menu → *Install app* (or accept the install banner).
- **Desktop:** Chrome/Edge show an install icon in the address bar. It also works as a normal web page.

Sessions last 14 days of inactivity and 90 days at most. You can change this with `SESSION_IDLE_DAYS` / `SESSION_MAX_DAYS`. See and revoke devices in *Settings → Signed-in devices*.

## 6. Reminders (Web Push)

- In *Settings → Reminders*, tap **Enable notifications on this device**. On iPhone and iPad this only works in the app installed to the Home Screen (iOS 16.4+).
- Available reminders:
  - morning temperature;
  - evening check-in;
  - period coming (0–7 days before);
  - fertile window starting (conceive/avoid goals);
  - partner's period coming.
- Payloads are end-to-end encrypted to the device, so the push services can't read them. *Discreet wording* (on by default) keeps the lock-screen text generic.
- Push keys (VAPID) are generated on first start and stored encrypted in the database. To pin them yourself, set `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`, and optionally `VAPID_SUBJECT` (`mailto:` or `https:`, defaults to `APP_URL`).

## 7. App lock (PIN and biometrics)

*Settings → App lock* adds a 4–8 digit PIN on top of the Authentik login. It is enforced by the server, per session:

- Locks when the user leaves the app, or after 1, 5, 15 or 60 minutes of inactivity.
- New sign-ins start locked.
- Five wrong PINs sign that device out.
- Face ID, Touch ID or an Android fingerprint can unlock it (WebAuthn platform authenticator, user verification required). Register it per device from the same screen.

## 8. Partner sharing

*Settings → Sharing with a partner → Invite a partner* creates a single-use link, valid 7 days. The partner needs their own account: in Authentik, add them to the group in `OIDC_ALLOWED_GROUPS` (if you set one), or create a local account for them.

If the partner opens the link while signed out, the invite reopens after they sign in. Someone who hasn't logged anything yet is then asked how they'll use Ebbwell:

- **Only follow the shared cycle** (partner-only): the app shows just the shared cycle and Settings, and sends only the partner reminder. They can start tracking their own cycle later in Settings; nothing is deleted either way.
- **Also track my own cycle**: the full app, with the shared cycle on Today.

- The partner gets a read-only view: period predictions and cycle day, plus the scopes the owner picked (fertility, history, symptoms and mood).
- Notes, sex, pregnancy tests and cervix observations are never shared.
- Either side can end the share at any time.

## 9. Backups and restore

- Ebbwell writes a consistent SQLite backup to `/data/backups/` once a day and keeps `BACKUP_RETENTION_DAYS` (14) of them. Backups are encrypted the same way as the live database.
- To restore: stop the app, then replace `ebbwell.sqlite` with a backup file and delete `ebbwell.sqlite-wal` and `ebbwell.sqlite-shm`. Start the app again with the **same** `DATA_ENCRYPTION_KEY`.
- Users can also export their own data (JSON/CSV) from *Settings → Your data*. Exports are **not** encrypted.

## 10. Rotating the encryption key

1. Generate a new key.
2. Set `DATA_ENCRYPTION_KEY=<new>` and `DATA_ENCRYPTION_KEY_PREVIOUS=<old>`, then restart. The log says *Key rotation: re-encrypted N records*.
3. Remove `DATA_ENCRYPTION_KEY_PREVIOUS` and restart. Old backups still need the old key, so keep it until those backups expire.

## 11. Updating

The CI publishes `ghcr.io/maxren2/ebbwell` for every version tag (`0.2.0`, …) and `latest` for `main`. Pin a version in the YAML and update it deliberately. Database migrations run automatically at startup, and the daily backup gives you a rollback point.

## 12. Feedback links

*Settings → Feedback* has "Report a bug" and "Suggest a feature" buttons. By default they open the project's GitHub issue forms, with only the app version and the device type (e.g. "iPhone · Safari · installed app") filled in. Nothing is sent until the user submits the form on GitHub. Set `FEEDBACK_URL` to another https address (your own forum or tracker) or to `off` to hide the section.

## 13. Voice input

*Settings → Voice input* is a choice per device:

- **Keyboard dictation** (default): Quick entry is filled by the keyboard's own microphone. Where the speech is processed depends on the keyboard (on iPhone mostly on the device; with Gboard, turn on offline voice typing).
- **Whisper on this device**: a *Speak* button in Quick entry. OpenAI's Whisper model runs in the browser (WebAssembly, in a background worker). The audio and the transcript never leave the phone; only the model is downloaded, once, from your Ebbwell server (not from the internet), and kept in the browser's cache. *Remove from this device* frees the space.

`VOICE_MODEL` chooses what the server offers: `base` (default, ~79 MB, noticeably better, especially in Arabic), `tiny` (~43 MB, faster on old phones) or `off`. Both models are in the image (about +120 MB); only signed-in users can download them.

Notes:

- The microphone needs HTTPS (or `localhost`), like push notifications.
- A sentence takes a few seconds to recognise on a recent phone; the first use also downloads the model (on Wi-Fi if possible: *Download now* in Settings).
- For this the app sends `Cross-Origin-Embedder-Policy: require-corp` (several threads for the recogniser) and allows `'wasm-unsafe-eval'` (WebAssembly only, not JavaScript `eval`) and `microphone=(self)`. If your reverse proxy rewrites security headers, keep these.

