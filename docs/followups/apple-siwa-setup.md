# Sign in with Apple, APNs, FCM and app links — setup (WP16-51)

State on 2026-11-05 (team **S6D533QSV2**, project `mmo-mw-prod`):

| Item | Status | Where |
|---|---|---|
| App ID `ro.mixai.app` with Sign in with Apple + Associated Domains | done (already enabled, checked via ASC API) | developer.apple.com → Identifiers |
| Services ID `ro.mixai.web` ("MixAI Web"), SIWA on, primary App ID `ro.mixai.app` | done | Identifiers → Services IDs |
| SIWA domains | `mixai.ro`, `www.mixai.ro`, `mixai-web-622082681070.europe-west1.run.app` | Services ID → Configure |
| SIWA return URLs | `https://{mixai.ro,www.mixai.ro,mixai-web-622082681070.europe-west1.run.app}/api/auth/callback/apple` | same |
| Key `F2YDTZV29A` "MixAI SIWA and APNs" (SIWA for `ro.mixai.app` + APNs, team scoped, sandbox & production) | done; .p8 stored, local copy deleted | Keys |
| Secret Manager | `mixai-web-apple-p8`, `mixai-web-apns-p8` (same .p8), `mixai-web-apple-key-id`, `mixai-web-apns-key-id` (`F2YDTZV29A`), `mixai-web-apple-services-id` (`ro.mixai.web`) | `gcloud secrets list --project mmo-mw-prod --filter=name~apple` |
| FCM service account `mixai-web-fcm-sa` | **not created** — Android push stays off until it exists | below |
| `assetlinks.json` release fingerprint | **placeholder** — fill after the first Play upload | below |
| Private Email Relay sources | not registered (only needed if we email `@privaterelay.appleid.com` users) | Services → Sign in with Apple for Email Communication |

Apple allows two APNs keys per team: codai's `TSN243T8W4` and MixAI's `F2YDTZV29A` now use both slots.
Rotating either one means revoking it first.

## How the web uses it

`apps/web/scripts/deploy-cloud-run.ps1` mounts the optional secrets only when a version exists
(`$OptionalSecretMap`): `AUTH_APPLE_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY`, `APNS_KEY_ID`, `APNS_PRIVATE_KEY`,
`FCM_SERVICE_ACCOUNT_JSON`. With `AUTH_APPLE_ID` + the key the app mints the 6-month client-secret JWT at boot,
so there is nothing to rotate every 6 months. `AUTH_APPLE_SECRET` (pre-built JWT) is supported too:

```powershell
node apps/web/scripts/apple-client-secret.mjs --key <AuthKey.p8> --key-id F2YDTZV29A --client-id ro.mixai.web --out $env:TEMP\apple-secret.txt
gcloud secrets versions add mixai-web-auth-apple-secret --project mmo-mw-prod --data-file $env:TEMP\apple-secret.txt
Remove-Item $env:TEMP\apple-secret.txt
```

Plain env (optional, defaults in code): `APPLE_TEAM_ID` (S6D533QSV2), `APPLE_BUNDLE_ID` (ro.mixai.app),
`APPLE_NATIVE_AUDIENCES` (ro.mixai.app), `GOOGLE_NATIVE_CLIENT_IDS`, `APNS_TEAM_ID`, `APNS_TOPIC` (ro.mixai.app),
`FCM_PROJECT_ID`.

Web SIWA does not work on `localhost` (Apple requires HTTPS + a registered return URL). After the mixai.ro
domain mapping, `-AppUrl https://mixai.ro` and the return URL above are already registered.

## Redo from scratch (if the key is lost)

1. developer.apple.com → Certificates, Identifiers & Profiles → **Keys** → `+` → name "MixAI SIWA and APNs",
   tick **Sign in with Apple** → Configure → Primary App ID `MixAI (S6D533QSV2.ro.mixai.app)` → Save; tick
   **APNs** → Configure → Sandbox & Production → Save → Continue → Register → **Download** (one time only).
2. Store without printing: `gcloud secrets versions add mixai-web-apple-p8 --project mmo-mw-prod --data-file D:\Downloads\AuthKey_<ID>.p8`
   (same for `mixai-web-apns-p8`), key id into `mixai-web-apple-key-id` / `mixai-web-apns-key-id` via a temp
   file, then delete the .p8. Revoke the old key in the portal.
3. Redeploy (deploy-clean + deploy-cloud-run.ps1).

## FCM (Android push)

1. Firebase console → add project for `mmo-mw-prod` (or link the GCP project) → add Android app `ro.mixai.app`
   → download `google-services.json` for `apps/phone-android/app/`.
2. IAM → service account `mixai-fcm-sender` with role **Firebase Cloud Messaging API Admin**
   (`roles/firebasecloudmessaging.admin`) → create JSON key →
   `gcloud secrets versions add mixai-web-fcm-sa --project mmo-mw-prod --data-file <key.json>` → delete the file.
3. Redeploy. `/api/push/relay` logs `skipped` for Android tokens until this exists.

## Android App Links (`public/.well-known/assetlinks.json`)

The file ships with a zero fingerprint. After the first upload to Play:
Play Console → MixAI → **Test and release → App integrity → App signing** → copy **SHA-256 certificate
fingerprint** of the *app signing key* (not the upload key) → replace the zeros, keep the upload-key
fingerprint as a second entry if debug/internal builds must verify too → bump web, deploy. Verify with
`https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://mixai.ro&relation=delegate_permission/common.handle_all_urls`.

## iOS Universal Links (`public/.well-known/apple-app-site-association`)

`applinks` for `S6D533QSV2.ro.mixai.app`: `/media/*`, `/together/*`, `/activate`, plus `webcredentials`
(password AutoFill). The iOS app needs the entitlement `applinks:mixai.ro` (and `webcredentials:mixai.ro`).
Apple's CDN caches the file: check `https://app-site-association.cdn-apple.com/a/v1/mixai.ro` after DNS is live.
