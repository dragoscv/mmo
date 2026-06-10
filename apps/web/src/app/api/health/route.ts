/**
 * GET /api/health — liveness + lightweight readiness probe.
 *
 * Returns 200 with the build sha, db round-trip latency, and the ISO
 * timestamp. CI smoke tests, uptime probes, and the companion's
 * "is the cloud reachable?" check all hit this. Intentionally cheap:
 * one `SELECT 1` against Postgres + a few Date constructors.
 *
 * Does NOT require auth — exposing per-request load avg or app version is
 * not sensitive, and protecting the probe would defeat its purpose.
 */

import { db } from "@/db";
import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
// Probes must always hit fresh state.
export const dynamic = "force-dynamic";

export async function GET() {
    const startedAt = Date.now();
    let dbOk = false;
    let dbLatencyMs: number | null = null;
    let dbError: string | null = null;

    try {
        const t0 = Date.now();
        await db.execute(sql`SELECT 1`);
        dbLatencyMs = Date.now() - t0;
        dbOk = true;
    } catch (e) {
        dbError = e instanceof Error ? e.message : String(e);
    }

    const body = {
        ok: dbOk,
        version: process.env.npm_package_version ?? "0.0.0",
        commitSha: process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.COMMIT_SHA ?? null,
        env: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "unknown",
        timestamp: new Date().toISOString(),
        uptimeSeconds: Math.round(process.uptime()),
        latencyMs: Date.now() - startedAt,
        db: { ok: dbOk, latencyMs: dbLatencyMs, error: dbError },
    } as const;

    return NextResponse.json(body, {
        status: dbOk ? 200 : 503,
        headers: { "cache-control": "no-store, max-age=0" },
    });
}
