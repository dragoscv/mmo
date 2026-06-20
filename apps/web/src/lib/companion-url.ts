/**
 * Pure helpers for choosing how to reach a paired companion.
 *
 * Kept free of any server-only imports (`auth`, `db`, …) so the logic
 * can be unit-tested in isolation. `companion-library.ts` re-exports
 * and uses these.
 */

const LOCAL_PREFIXES = [
    "http://localhost:",
    "http://127.0.0.1:",
    "https://localhost:",
    "https://127.0.0.1:",
];

/** True when `url` is a loopback URL (points at the machine running the
 *  code, not a remote host). */
export function isLoopbackUrl(url: string): boolean {
    return LOCAL_PREFIXES.some((p) => url.startsWith(p));
}

/** True when the runtime is a hosted/serverless deployment (Vercel,
 *  Cloud Run, Lambda) rather than a process on the user's own machine.
 *  In hosted runtimes a loopback companion URL points at the container,
 *  NOT the user's laptop. */
export function isHostedRuntime(
    env: Record<string, string | undefined> = process.env,
): boolean {
    return (
        !!env.VERCEL ||
        !!env.AWS_LAMBDA_FUNCTION_NAME ||
        !!env.K_SERVICE // Cloud Run / Knative
    );
}

/**
 * Pick the best base URL to reach `device` from the current runtime.
 *
 *  Local runtime  → loopback `apiUrl` (if any) > `lanUrl` > `apiUrl`.
 *  Hosted runtime → non-loopback `lanUrl` > non-loopback `apiUrl`.
 *
 * The loopback preference when co-located fixes the case where the web
 * app and companion run on the same machine but the companion's
 * self-announced `lanUrl` (e.g. 192.168.x) is unreachable from the
 * server (flaky Wi-Fi, VPN, changed subnet).
 *
 * Returns `null` when no usable URL exists for the runtime.
 */
export function pickCompanionUrl(
    device: { apiUrl: string | null; lanUrl: string | null },
    hosted: boolean = isHostedRuntime(),
): string | null {
    const api = device.apiUrl ?? null;
    const lan = device.lanUrl ?? null;
    if (!hosted) {
        if (api && isLoopbackUrl(api)) return api;
        if (lan) return lan;
        return api;
    }
    if (lan && !isLoopbackUrl(lan)) return lan;
    if (api && !isLoopbackUrl(api)) return api;
    return null;
}
