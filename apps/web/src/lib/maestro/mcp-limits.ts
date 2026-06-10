/**
 * In-memory MCP rate limiter + audit helpers (P11 hardening).
 *
 * Real production would push limits + audit rows into Postgres so they
 * survive restarts and aggregate across replicas. We stay in-process
 * for now — the goal is to stop a runaway client from hammering the
 * tools/call endpoint, not to enforce hard quotas across a fleet.
 */

type Bucket = { count: number; resetAt: number };
const BUCKETS = new Map<string, Bucket>();

const WINDOW_MS = 60_000;
const MAX_CALLS_PER_WINDOW = 120;

export function rateLimit(key: string): { ok: boolean; remaining: number; resetMs: number } {
    const now = Date.now();
    const cur = BUCKETS.get(key);
    if (!cur || cur.resetAt <= now) {
        const fresh = { count: 1, resetAt: now + WINDOW_MS };
        BUCKETS.set(key, fresh);
        return { ok: true, remaining: MAX_CALLS_PER_WINDOW - 1, resetMs: WINDOW_MS };
    }
    if (cur.count >= MAX_CALLS_PER_WINDOW) {
        return { ok: false, remaining: 0, resetMs: cur.resetAt - now };
    }
    cur.count += 1;
    return { ok: true, remaining: MAX_CALLS_PER_WINDOW - cur.count, resetMs: cur.resetAt - now };
}

export interface AuditEntry {
    ts: number;
    userId: string;
    jti: string;
    method: string;
    tool?: string;
    ok: boolean;
    durationMs: number;
    errorCode?: number;
}

export function audit(entry: AuditEntry): void {
    // Structured one-line log so prod ingest can grep mcp.audit.
    // eslint-disable-next-line no-console
    console.log(`[mcp.audit] ${JSON.stringify(entry)}`);
    // Fire-and-forget Postgres insert; failures must not break the
    // request path — they're already logged above.
    void persistAudit(entry);
}

async function persistAudit(entry: AuditEntry): Promise<void> {
    try {
        const { db } = await import("@/db");
        const { mcpAuditLog } = await import("@/db/schema-ai");
        await db.insert(mcpAuditLog).values({
            ts: new Date(entry.ts),
            userId: entry.userId,
            jti: entry.jti,
            method: entry.method,
            tool: entry.tool ?? null,
            ok: entry.ok,
            durationMs: entry.durationMs,
            errorCode: entry.errorCode ?? null,
        });
    } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("[mcp.audit] persist failed", err);
    }
}
