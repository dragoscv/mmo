/**
 * Mint a Google-signed ID token for a Cloud Run service URL.
 *
 * Used to authenticate the Next.js server against `--no-allow-unauthenticated`
 * Cloud Run services (mastering, CLAP, ace-step). Two paths:
 *
 *   1. **On GCE / Cloud Run / Vercel-OIDC**: the metadata server at
 *      `metadata.google.internal` mints tokens for free in ~5 ms.
 *   2. **Local dev**: falls back to `google-auth-library` which reads
 *      ADC (`GOOGLE_APPLICATION_CREDENTIALS` JSON key) and exchanges
 *      it for an ID token. A 200–400 ms cost on cold call.
 *
 * Returns null on any failure so callers can degrade to a "cloud GPU
 * unavailable" path instead of crashing the request.
 */

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

/** Cache tokens for 50 minutes (Google ID tokens are valid for 60). */
const TOKEN_TTL_MS = 50 * 60 * 1000;

export async function mintGoogleIdToken(audience: string): Promise<string | null> {
    const cached = tokenCache.get(audience);
    if (cached && cached.expiresAt > Date.now()) return cached.token;

    const token = await fetchIdToken(audience);
    if (token) {
        tokenCache.set(audience, { token, expiresAt: Date.now() + TOKEN_TTL_MS });
    }
    return token;
}

async function fetchIdToken(audience: string): Promise<string | null> {
    // Path 1: GCE / Cloud Run metadata server.
    try {
        const res = await fetch(
            `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${encodeURIComponent(audience)}`,
            { headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(2000) },
        );
        if (res.ok) return await res.text();
    } catch {
        // Fall through to ADC path.
    }

    // Path 2: ADC via google-auth-library (local dev / Vercel with SA key).
    try {
        const mod = await import("google-auth-library").catch(() => null);
        if (!mod) return null;
        const auth = new mod.GoogleAuth();
        const client = await auth.getIdTokenClient(audience);
        const headers = await client.getRequestHeaders();
        const h = headers as unknown as { get?: (k: string) => string | null } & Record<string, string>;
        const authHeader = typeof h.get === "function" ? h.get("Authorization") : h["Authorization"];
        if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
            return authHeader.slice("Bearer ".length);
        }
        return null;
    } catch {
        return null;
    }
}
