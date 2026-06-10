import { Suspense } from "react";

export const dynamic = "force-dynamic";
export const revalidate = 0;

interface HealthBody {
    ok: boolean;
    version: string;
    commitSha: string | null;
    env: string;
    timestamp: string;
    uptimeSeconds: number;
    latencyMs: number;
    db: { ok: boolean; latencyMs: number | null; error: string | null };
}

async function fetchHealth(): Promise<{ body: HealthBody | null; status: number; error?: string }> {
    // Build an absolute URL even when called server-side: prefer the deploy
    // origin from env (Vercel sets `VERCEL_URL`); fall back to localhost dev
    // so this page works without any extra config in `pnpm dev`.
    const origin =
        process.env.NEXT_PUBLIC_APP_URL
        ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:13789");
    try {
        const res = await fetch(`${origin}/api/health`, { cache: "no-store" });
        const body = (await res.json()) as HealthBody;
        return { body, status: res.status };
    } catch (e) {
        return { body: null, status: 0, error: e instanceof Error ? e.message : String(e) };
    }
}

function Pill({ ok, label }: { ok: boolean; label: string }) {
    return (
        <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ${ok ? "bg-emerald-500/10 text-emerald-300 border border-emerald-500/30" : "bg-red-500/10 text-red-300 border border-red-500/30"}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${ok ? "bg-emerald-400" : "bg-red-400"}`} />
            {label}
        </span>
    );
}

async function StatusBody() {
    const { body, status, error } = await fetchHealth();
    return (
        <div className="space-y-6">
            <header className="flex items-center justify-between">
                <h1 className="text-3xl font-bold">Status</h1>
                <Pill ok={status === 200 && !!body?.ok} label={status === 200 && body?.ok ? "Operational" : "Degraded"} />
            </header>

            <section className="rounded-xl border border-border bg-card p-5 space-y-3">
                <h2 className="text-base font-semibold">Web app</h2>
                {body ? (
                    <dl className="grid grid-cols-2 gap-3 text-sm">
                        <dt className="text-muted-foreground">Version</dt>
                        <dd className="font-mono">{body.version}</dd>
                        <dt className="text-muted-foreground">Commit</dt>
                        <dd className="font-mono">{body.commitSha?.slice(0, 7) ?? "—"}</dd>
                        <dt className="text-muted-foreground">Environment</dt>
                        <dd>{body.env}</dd>
                        <dt className="text-muted-foreground">Uptime</dt>
                        <dd>{body.uptimeSeconds}s</dd>
                        <dt className="text-muted-foreground">Last check</dt>
                        <dd className="font-mono text-xs">{body.timestamp}</dd>
                    </dl>
                ) : (
                    <p className="text-sm text-red-300">Health probe failed: {error ?? `HTTP ${status}`}</p>
                )}
            </section>

            <section className="rounded-xl border border-border bg-card p-5 space-y-3">
                <h2 className="flex items-center justify-between text-base font-semibold">
                    <span>Postgres</span>
                    <Pill ok={!!body?.db.ok} label={body?.db.ok ? "Reachable" : "Down"} />
                </h2>
                {body?.db.ok ? (
                    <p className="text-sm text-muted-foreground">
                        Round-trip <code className="rounded bg-muted px-1 py-0.5 text-xs">SELECT 1</code> in {body.db.latencyMs} ms.
                    </p>
                ) : (
                    <p className="text-sm text-red-300">{body?.db.error ?? "No response"}</p>
                )}
            </section>

            <section className="rounded-xl border border-border bg-card p-5 space-y-3">
                <h2 className="text-base font-semibold">Diagnostics</h2>
                <p className="text-sm text-muted-foreground">
                    Companion connectivity is per-device — see <a href="/devices" className="underline decoration-dotted">Devices</a>.
                    TURN credentials are issued on demand via <code className="rounded bg-muted px-1 py-0.5 text-xs">/api/turn-credentials</code>.
                </p>
                <a href="/api/health" className="inline-block text-sm underline decoration-dotted text-purple-300">View raw /api/health JSON →</a>
            </section>
        </div>
    );
}

export default function StatusPage() {
    return (
        <div className="px-3 sm:px-4 md:px-6 py-4 sm:py-5 md:py-6 max-w-2xl mx-auto">
            <Suspense fallback={<div className="text-sm text-muted-foreground">Loading status…</div>}>
                <StatusBody />
            </Suspense>
        </div>
    );
}
