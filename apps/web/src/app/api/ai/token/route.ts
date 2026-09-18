/**
 * POST /api/ai/token — mint a short-lived codai ephemeral token for the
 * browser / TV surface (audio transcription, embeddings, realtime).
 *
 * The user's long-lived codai key never leaves the server: we call
 * `POST {CODAI_BASE_URL}/tokens` with it and hand back the
 * `codai_eph_v1…` token plus its expiry. Scopes are whitelisted.
 *
 * Auth: signed-in session; light per-user rate limit (20/min).
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSessionWithRate } from "@/lib/api-guard";
import { resolveCodaiKey } from "@/lib/codai/client";
import { codaiBaseUrl } from "@mmo/ai/providers/codai";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
    scopes: z.array(z.enum(["audio", "embeddings", "realtime"])).min(1).max(3),
    ttlSeconds: z.number().int().min(60).max(3600).optional(),
});

const DEFAULT_TTL_SECONDS = 600;

export async function POST(req: Request) {
    const guard = await requireSessionWithRate(req, { bucket: "ai-token", windowMs: 60_000, max: 20 });
    if (guard.response) return guard.response;
    const userId = guard.userId!;

    let raw: unknown;
    try {
        raw = await req.json();
    } catch {
        return NextResponse.json({ error: "invalid_json" }, { status: 400 });
    }
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) {
        return NextResponse.json({ error: "invalid_body", issues: parsed.error.issues }, { status: 400 });
    }
    const scopes = Array.from(new Set(parsed.data.scopes));
    const ttlSeconds = parsed.data.ttlSeconds ?? DEFAULT_TTL_SECONDS;

    const resolved = await resolveCodaiKey(userId);
    if (!resolved) {
        return NextResponse.json({ error: "codai_not_configured" }, { status: 503 });
    }

    const upstream = await fetch(`${codaiBaseUrl()}/tokens`, {
        method: "POST",
        headers: {
            authorization: `Bearer ${resolved.key}`,
            "content-type": "application/json",
            "x-codai-session-id": userId,
        },
        body: JSON.stringify({ scopes, ttlSeconds }),
    });

    if (!upstream.ok) {
        const status = upstream.status === 401 || upstream.status === 403 ? 502 : upstream.status >= 500 ? 502 : 400;
        return NextResponse.json({ error: "codai_token_failed", upstreamStatus: upstream.status }, { status });
    }

    const json = (await upstream.json().catch(() => ({}))) as {
        token?: string;
        expiresAt?: string | number;
        expires_at?: string | number;
        ttlSeconds?: number;
        data?: { token?: string; expiresAt?: string | number };
    };
    const token = json.token ?? json.data?.token;
    if (!token) {
        return NextResponse.json({ error: "codai_token_malformed" }, { status: 502 });
    }
    const expiresAtRaw = json.expiresAt ?? json.expires_at ?? json.data?.expiresAt;
    const expiresAt = normalizeExpiry(expiresAtRaw, json.ttlSeconds ?? ttlSeconds);

    return NextResponse.json({ token, expiresAt, scopes }, { headers: { "cache-control": "no-store" } });
}

function normalizeExpiry(raw: string | number | undefined, ttlSeconds: number): string {
    if (typeof raw === "string") return raw;
    if (typeof raw === "number") return new Date(raw < 1e12 ? raw * 1000 : raw).toISOString();
    return new Date(Date.now() + ttlSeconds * 1000).toISOString();
}
