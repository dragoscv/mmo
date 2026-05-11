/**
 * Next.js instrumentation hook (server + edge runtimes).
 *
 * Registered automatically by Next.js when the file exists. We use it
 * to lazy-init `@sentry/nextjs` ONLY when both a DSN is configured AND
 * the optional dependency is actually installed. Self-hosted deployments
 * that skip Sentry pay zero cost — no module resolution, no network.
 *
 * To enable in production:
 *   1. `pnpm add @sentry/nextjs` in /app
 *   2. Set SENTRY_DSN (and optionally SENTRY_ENVIRONMENT, SENTRY_RELEASE)
 *      in the deployment environment.
 *   3. Re-deploy. The init runs once per server cold-start.
 */

export async function register(): Promise<void> {
    // Validate env at boot. Throws on missing/weak production secrets so
    // the deploy fails loud instead of accepting requests with a silently
    // downgraded security posture (see app/src/lib/env.ts for the schema).
    if (process.env.NEXT_RUNTIME === "nodejs") {
        await import("@/lib/env");
    }

    if (!process.env.SENTRY_DSN) return;

    // Use a literal-string dynamic import so webpack doesn't try to
    // resolve @sentry/nextjs at build time when it isn't installed.
    const importPath = "@sentry/nextjs" as string;
    const mod = await import(/* webpackIgnore: true */ importPath).catch(() => null) as
        | { init?: (opts: Record<string, unknown>) => void }
        | null;
    if (!mod?.init) return;

    const runtime = process.env.NEXT_RUNTIME ?? "nodejs";
    mod.init({
        dsn: process.env.SENTRY_DSN,
        environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
        release: process.env.SENTRY_RELEASE,
        // Server-side: 100% errors, 10% performance traces (cheap on Vercel).
        // Edge: same (request volume is bounded by middleware reach).
        tracesSampleRate: runtime === "edge" ? 0.1 : 0.1,
        // Don't capture local PII by default; opt-in via SENTRY_SEND_PII=1.
        sendDefaultPii: process.env.SENTRY_SEND_PII === "1",
    });
}

/**
 * Forward unhandled request errors to Sentry. Next.js calls this for any
 * error thrown from a Route Handler, Server Action, or RSC render. The
 * signature is the official Next.js shape; the body uses the lazy shim
 * so missing-Sentry installs stay no-ops.
 */
export async function onRequestError(
    err: unknown,
    request: { path: string; method: string; headers: Record<string, string> },
    context: { routerKind: string; routePath: string; routeType: string },
): Promise<void> {
    const { captureException } = await import("./lib/sentry");
    captureException(err, { request, context });
}
