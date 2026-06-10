# Mobile native Google sign-in

The Capacitor Android shell currently loads `https://muzicai.ro` directly in
the WebView and lets NextAuth handle sign-in inside the WebView. That works,
but the OAuth redirect to `accounts.google.com` happens inside the embedded
WebView — Google increasingly blocks this for security reasons and the UX
is worse than the system Google one-tap / account chooser.

This document captures the work needed to flip the mobile shell to a
native Google sign-in flow that mints a NextAuth session for the WebView.

## Why this is deferred

- Picked plugin (`@capgo/capacitor-social-login`) requires **Capacitor 8**.
  The project is currently on **Capacitor 7** (`@capacitor/core@^7.0.0`).
  Upgrading is a separate, larger task (peer-bumping, plugin compat,
  potential Gradle / Android Gradle Plugin bumps).
- Requires Google Cloud Console setup that the operator must perform:
  - Android OAuth 2.0 client ID bound to `ro.muzicai.app` + SHA-1
    fingerprint of the debug keystore (and release later).
  - Web OAuth 2.0 client ID used for **server-side ID token verification**
    (`aud` claim check).

## Plan

### 1. Upgrade Capacitor 7 → 8 (`apps/native/`)

```jsonc
// apps/native/package.json
{
    "dependencies": {
        "@capacitor/android": "^8.0.0",
        "@capacitor/cli": "^8.0.0",
        "@capacitor/core": "^8.0.0",
        "@capacitor/ios": "^8.0.0"
    }
}
```

Then `pnpm install`, `pnpm exec cap sync android`, fix any Gradle warnings.

### 2. Install the native auth plugin

```bash
pnpm -C apps/native add @capgo/capacitor-social-login
pnpm -C apps/native exec cap sync android
```

### 3. Configure the plugin (Android)

```ts
// apps/native/capacitor.config.ts
const config: CapacitorConfig = {
    // ...existing...
    plugins: {
        SocialLogin: {
            google: {
                webClientId: process.env.GOOGLE_WEB_CLIENT_ID, // for ID token aud
                mode: "online",
            },
        },
    },
};
```

Operator steps in Google Cloud Console:
1. Create OAuth Android client; supply `ro.muzicai.app` + SHA-1 from
   `apps/native/android/app/`'s debug keystore (`keytool -list -v -keystore ~/.android/debug.keystore`).
2. Create OAuth Web client (or reuse the existing one used by NextAuth).
3. Set `GOOGLE_WEB_CLIENT_ID` in `apps/native/.env` (Capacitor build env).

### 4. New web endpoint: `app/src/app/api/auth/mobile/google/route.ts`

POST receives `{ idToken: string }` from the native plugin. Server:

1. Verify the JWT using Google's JWKS (`https://www.googleapis.com/oauth2/v3/certs`).
   - `iss` must be `https://accounts.google.com` or `accounts.google.com`.
   - `aud` must equal the project's web client ID (`AUTH_GOOGLE_ID`).
   - `exp` must be in the future.
   - `email_verified` must be `true`.
2. Find or create the user in `users` via the same logic the NextAuth
   `signIn` callback uses (allowlist check on `AUTH_ALLOWED_EMAILS`).
3. Insert a row into `sessions` (sessionToken = `crypto.randomUUID()`,
   expires = +30d) — same pattern as `/api/auth/desktop-bootstrap`.
4. Set the `authjs.session-token` (or `__Secure-` prefixed) cookie and
   respond 200 with `{ ok: true }`.

Use `jose` for the JWKS verify (lighter than `google-auth-library`):

```ts
import { createRemoteJWKSet, jwtVerify } from "jose";

const JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

const { payload } = await jwtVerify(idToken, JWKS, {
    issuer: ["https://accounts.google.com", "accounts.google.com"],
    audience: process.env.AUTH_GOOGLE_ID!,
});
```

### 5. Modify `app/src/components/login-form.tsx`

Detect Capacitor at click time (lazy import to keep the web bundle clean):

```ts
async function handleGoogleSignIn() {
    setLoading(true);
    try {
        const cap = await import("@capacitor/core").catch(() => null);
        if (cap?.Capacitor?.isNativePlatform?.()) {
            const { SocialLogin } = await import("@capgo/capacitor-social-login");
            await SocialLogin.initialize({ google: { webClientId: process.env.NEXT_PUBLIC_GOOGLE_WEB_CLIENT_ID! } });
            const res = await SocialLogin.login({ provider: "google", options: {} });
            // res.result.idToken is the JWT we forward to the server.
            await fetch("/api/auth/mobile/google", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify({ idToken: res.result.idToken }),
            });
            window.location.replace(callbackUrl);
            return;
        }
        await signIn("google", { callbackUrl });
    } catch {
        setLoading(false);
    }
}
```

Add `NEXT_PUBLIC_GOOGLE_WEB_CLIENT_ID` to `app/.env` (mirrors `AUTH_GOOGLE_ID`).

### 6. Verify

- Build Android (`pnpm -C apps/native exec cap run android`), tap "Sign in
  with Google", confirm the native chooser appears (no WebView OAuth page).
- After selecting an account, the WebView should reload with the user
  signed in (`/api/auth/session` returns the user).

## Risk notes

- Database session strategy means each native sign-in inserts a session
  row — same as the desktop bootstrap. The web NextAuth flow uses
  `DrizzleAdapter.createSession`; both paths produce identical row shape.
- Anyone with a valid Google ID token issued for `AUTH_GOOGLE_ID` can mint
  a session for that Google account on this server. That is the entire
  point of Google ID tokens and the same trust model as the OAuth code
  flow — no extra exposure.
- iOS: the same plugin supports Apple sign-in; revisit when iOS is in
  scope (requires Apple Developer Program + an OAuth Apple client).
