# Ebbwell — proposal

A self-hosted period tracker and ovulation estimator for TrueNAS SCALE. It runs as a web app that can be installed on iPhone and Android (PWA), behind Authentik and a reverse proxy.

The name and icon are deliberately neutral: "Ebbwell" (the ebb of the moon-driven tide, and well-being) with a crescent-moon icon, so the home-screen icon does not say "period tracker".

---

## 1. What the research says about reliability

| Finding | Source | Consequence for the app |
|---|---|---|
| Real cycles are rarely textbook: in 612,613 cycles the mean length was 29.3 days. Mean follicular phase was 16.9 days (95% CI 10–30) and mean luteal phase was 12.4 days (7–17). Most of the variation comes from the follicular phase. | Bull et al., *npj Digit. Med.* 2019 | Don't assume "28 days, ovulation day 14". Learn each person's own lengths. Predict ovulation *backwards* from the next period (luteal phase is the stable part). |
| Calendar-only apps predict the ovulation day correctly in only ~8–21% of cases, with errors up to 6+ days. | Johnson et al., *Curr Med Res Opin* 2018; Worsfold et al., *Hum. Reprod.* 2021 (abstract P-469) | Calendar predictions must be shown as **ranges with a confidence level**, never as a single "ovulation day". Ovulation is only **confirmed** from a body sign. |
| Pregnancy only happens with intercourse in the 6 days ending on ovulation day (conception probability ~10% at −5 days, ~33% on the day). | Wilcox et al., *NEJM* 1995 | Fertile window = ovulation −5 … +1 (one day of margin), widened by the prediction uncertainty. |
| A basal body temperature (BBT) shift confirms ovulation after the fact. The Sensiplan rule: 3 readings above the highest of the 6 before, with the 3rd ≥ 0.2 °C above. Two exceptions exist and cannot be combined. Disturbed readings (illness, alcohol, short sleep, different time) must be excluded. | Sensiplan / Arbeitsgruppe NFP | Log temperature with time plus "disturbance" flags. Implement the full Sensiplan rule including the exceptions. Show the cover line on a chart. |
| Cervical mucus peak day plus 3 days of lower quality, cross-checked with the temperature shift ("double check"), is the most effective fertility-awareness method studied (0.4% perfect-use pregnancy rate). | Frank-Herrmann et al., *Hum. Reprod.* 2007 | Log mucus as sensation + appearance and map it to the Sensiplan categories (t, ∅, f, S, S+). Detect the peak day. Only declare the post-ovulatory infertile phase when **both** signs agree. |
| LH tests predict ovulation 24–36 h ahead. They do not confirm that ovulation happened. | Clinical consensus | Log LH results. Use a positive result as a "likely soon" signal and never as confirmation. |
| FIGO 2018: normal cycles last 24–38 days. Shortest-to-longest variation should be ≤ 7–9 days depending on age. | Munro et al., *IJGO* 2018 | Detect and explain irregular, frequent or infrequent cycles instead of silently producing bad predictions. Suggest seeing a clinician when the pattern persists. |
| Some cycles are not representative: after stopping hormonal contraception, postpartum, breastfeeding, emergency contraception, illness. | Sensiplan, NICE | Let the user **exclude a cycle** from the statistics. Add a "pregnant / paused" mode. |
| Commercial period apps have shared health data with third parties (FTC v. Flo Health, 2021). Reproductive data can be sensitive legally. | FTC | Self-host, no third parties, no analytics, no CDN. Encrypt at rest. Allow full export and full deletion. |

**Bottom line.** A tracker is reliable when it (1) personalises from the user's own history, (2) confirms ovulation with body signs (temperature, mucus, optionally LH), (3) shows how uncertain every prediction is, and (4) is honest about when data is insufficient or irregular.

> Ebbwell is **not a medical device and not a contraceptive**. The Sensiplan evaluation is provided for people who have *learned* the method (course or official book). It is hidden until the user explicitly enables it.

---

## 2. Proposed features

### A. Needed for reliable predictions (Phase 1 — built)

1. **Daily log.** Bleeding (spotting / light / medium / heavy, with an "exclude" flag), basal temperature (value, time, disturbance flags, exclude), cervical mucus (sensation + appearance → Sensiplan category), cervix (optional), LH test, pregnancy test, sex (protected / unprotected), symptoms, mood, notes.
2. **Cycle detection.** A cycle starts on the first day of real bleeding (spotting excluded) after a bleeding-free gap. Implausible cycles (< 15 days) are flagged for review.
3. **Personal statistics.** Mean, median, standard deviation, min/max and period length over the last 12 usable cycles. Personal luteal length from cycles with a confirmed ovulation.
4. **Regularity check** against the FIGO 2018 definitions: regular, irregular, frequent or infrequent, with an explanation.
5. **Ovulation confirmation per cycle.** Sensiplan temperature rule (regular rule plus both exceptions, disturbed readings skipped), mucus peak day detection, LH positive. Each cycle shows *how* ovulation was determined: confirmed (temperature + mucus), confirmed (temperature), likely (mucus/LH), or estimated (calendar).
6. **Predictions with ranges.** Next period, ovulation and fertile window for the current cycle and 3 cycles ahead, each with a ± range and a confidence level (low / medium / high) based on how many cycles are logged and how regular they are. Once ovulation is confirmed in the current cycle, the next-period prediction switches to ovulation + personal luteal length, which is much tighter.
7. **Late-period detection.** When the period is later than the predicted range, the app says so. If there was unprotected sex in the fertile window, it suggests a pregnancy test.
8. **Exclude cycle / paused (pregnant) mode.**
9. **Sensiplan evaluation (opt-in).** Pre-ovulatory rules (5-day rule, minus-8 after 12 temperature cycles, ends at first mucus sign) and post-ovulatory double check. Hidden behind an explicit acknowledgment.
10. **Symptothermal chart.** Temperature curve per cycle with cover line, higher readings, excluded readings, and mucus and bleeding rows.
11. **Goal modes:** *track only*, *trying to conceive* (highlights the best days), *avoid pregnancy* (requires the Sensiplan acknowledgment).

### B. Needed for security and privacy (Phase 1 — built)

| Threat | Mitigation |
|---|---|
| Someone reaches the app without logging in | Native **OIDC login to Authentik** inside the app (authorization code + PKCE + state + nonce, ID token verified). The app never trusts identity headers from the proxy, so it stays safe even if the container port is reachable directly. Optional `ALLOWED_GROUPS` check on the `groups` claim. |
| Stolen session cookie / CSRF | `__Host-` cookie, `HttpOnly`, `Secure`, `SameSite=Lax`. Random 256-bit session token stored **hashed**. Idle timeout and absolute timeout. Origin check plus a custom header on every write. "Sign out other devices" list. |
| Database or backup leaks (disk, snapshot, backup replicated off-site) | **AES-256-GCM application-level encryption** of every health record and setting. Row identity is bound as associated data, so ciphertexts can't be swapped between rows or users. Key rotation is supported. Also recommended: an encrypted ZFS dataset. |
| XSS / clickjacking / data leaks from the browser | Strict CSP (`script-src 'self'`, no inline scripts, `frame-ancestors 'none'`), `Referrer-Policy: no-referrer`, COOP/CORP, `nosniff`, `no-store` on every API response. No third-party requests at all: fonts, icons and scripts are all self-hosted. |
| Lost or shared phone | Neutral name and icon. Health data is **not** cached by the service worker (only the app shell is). Logout clears site data. |
| Brute force / abuse | Rate limiting (stricter on `/auth/*`). |
| Container escape / lateral movement | Non-root (UID 568, TrueNAS `apps`), read-only root FS, all capabilities dropped, `no-new-privileges`, tiny dependency set (SQLite is built into Node, no native modules). |
| Data loss | Automatic daily consistent SQLite backups with retention (encrypted content). ZFS snapshots recommended. Full JSON/CSV export and JSON import. |
| Right to be forgotten | "Delete all my data" wipes the user's entries, settings and sessions. |
| Multi-user leaks | Every query is scoped by the authenticated user ID. Tests cover cross-user access. |

### C. Platform (Phase 1 — built)

- Installable PWA (iOS "Add to Home Screen", Android install prompt, desktop). Offline app shell, safe-area support, dark mode.
- The login flow uses full-page redirects, never pop-ups. Pop-ups break in iOS standalone mode.
- One Docker image (Node 24, no native dependencies). TrueNAS "Install via YAML" compose file. GitHub Actions workflow that publishes the image to GHCR.

### D. Phase 2 — built

- **Reminders via Web Push** (iOS 16.4+ home-screen apps, Android, desktop):
  - Kinds: morning temperature (skipped if already logged), evening check-in, period coming (0–7 days before), fertile window starting, partner's period coming.
  - Sent in the user's local time zone, each one only once, with a 3-hour catch-up window after downtime.
  - Payloads are end-to-end encrypted (RFC 8291), so Apple, Google and Microsoft push servers can't read them. Discreet wording is on by default because the lock screen is visible to anyone.
- **App lock**, enforced by the server per session:
  - A PIN (scrypt-hashed) plus Face ID, Touch ID or fingerprint through WebAuthn platform authenticators, with user verification required.
  - Locks on leaving the app or after 1–60 minutes of inactivity. New sign-ins start locked, and five wrong attempts destroy the session.
  - A forgotten PIN can only be reset after a *fresh* identity-provider login (`prompt=login`, `auth_time` < 5 min), so a lingering SSO cookie is not enough.
- **Partner sharing**:
  - The owner creates a single-use invite link, valid 7 days and stored hashed. The code sits in the URL fragment, so it never appears in server logs.
  - The partner (another user of the instance) gets a read-only view computed on the server. It contains period predictions plus the scopes the owner chose: fertility, history, symptoms & mood.
  - Notes, sex, pregnancy tests and cervix observations are never shared. Either side can end the share.

### E. Recommended next (Phase 3)

- ~~**Local accounts**~~: built in 0.3.0. Passwords are accepted nowhere / on the local network only (never through the public domain) / everywhere, as set by the admin in the deployment configuration. Two-factor authentication (TOTP + recovery codes, optional or required) added in 0.4.0.
- **Import from other apps** (Clue, drip, Flo CSV exports).
- Translations (French, German…).
- **Offline logging queue**, stored encrypted on the device and synced later. This is a trade-off: it puts health data on the device.
- Doctor-ready PDF summary of the last 6–12 cycles.
- Extra wearables: temperature from Oura / Tempdrop exports.

---

## 3. Architecture

```
Phone / browser ──TLS──► Reverse proxy ──► Ebbwell container (:8080) ──► /data (SQLite, backups)
        │                                        │
        └────── OIDC redirect ─────► Authentik ◄─┘  (discovery, token exchange, JWKS)
```

- **Frontend:** React + Vite, PWA via `vite-plugin-pwa`. The cycle engine runs in the browser (pure TypeScript, shared with the server).
- **Backend:** Fastify 5 on Node 24. TypeScript is executed directly (native type stripping), so there is no build step for the server. SQLite comes from `node:sqlite`.
- **Auth:** `openid-client` (OIDC certified library) against an Authentik OAuth2/OpenID provider.
- **Storage:** one SQLite file. Health data columns are AES-256-GCM ciphertext.
