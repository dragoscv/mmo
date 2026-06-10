/**
 * Audio similarity recommendations powered by pgvector + CLAP embeddings.
 *
 * GET /api/recommendations/similar?assetId=<id>&assetKind=generated&limit=10
 *
 * Returns up to `limit` other embeddings sorted by cosine distance to the
 * query asset's embedding. Excludes the query itself. Both the query asset
 * and candidates must already be embedded — use embedAudio() (lib/clap-embed)
 * to backfill before calling this endpoint.
 */

import { NextRequest } from "next/server";
import { auth } from "@/auth";
import { db } from "@/db";
import { audioEmbeddings, generatedAssets } from "@/db/schema-ai";
import { and, eq, sql } from "drizzle-orm";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) {
        return new Response(JSON.stringify({ error: "Not signed in" }), {
            status: 401,
            headers: { "content-type": "application/json" },
        });
    }

    const url = new URL(req.url);
    const assetId = url.searchParams.get("assetId");
    const assetKind = url.searchParams.get("assetKind") ?? "generated";
    const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit") ?? "10")));

    if (!assetId) {
        return new Response(JSON.stringify({ error: "assetId required" }), {
            status: 400,
            headers: { "content-type": "application/json" },
        });
    }

    // Look up the source embedding. If it doesn't exist yet we can't recommend.
    const [src] = await db
        .select({ embedding: audioEmbeddings.embedding })
        .from(audioEmbeddings)
        .where(and(eq(audioEmbeddings.assetId, assetId), eq(audioEmbeddings.assetKind, assetKind)))
        .limit(1);

    if (!src) {
        return new Response(JSON.stringify({
            error: "asset-not-embedded",
            hint: "POST /api/embeddings/embed first, or wait for the auto-embed-on-upload hook.",
        }), {
            status: 404,
            headers: { "content-type": "application/json" },
        });
    }

    // Format the query vector for pg's text protocol: "[0.1,0.2,...]".
    const vec = `[${src.embedding.join(",")}]`;

    // Find nearest neighbours that ALSO belong to this user (for generated
    // assets — for scanned tracks we'd need a similar join; defer until
    // scanned-track embeddings exist).
    //
    // The <=> operator is pgvector's cosine distance. Lower = more similar.
    // We add `1 - distance` as a similarity score for the response payload.
    const rows = await db.execute<{
        id: string;
        asset_id: string;
        asset_kind: string;
        distance: number;
        duration_sec: number | null;
        tempo_bpm: number | null;
        prompt: string | null;
        kind: string | null;
    }>(sql`
        SELECT
            ae.id,
            ae.asset_id,
            ae.asset_kind,
            ae.embedding <=> ${vec}::vector AS distance,
            ae.duration_sec,
            ae.tempo_bpm,
            ga.prompt_text AS prompt,
            ga.kind
        FROM ${audioEmbeddings} ae
        LEFT JOIN ${generatedAssets} ga
               ON ga.id = ae.asset_id
              AND ae.asset_kind = 'generated'
              AND ga.user_id = ${userId}
        WHERE NOT (ae.asset_id = ${assetId} AND ae.asset_kind = ${assetKind})
          AND (ae.asset_kind <> 'generated' OR ga.user_id = ${userId})
        ORDER BY distance ASC
        LIMIT ${limit}
    `);

    const arr = rows as unknown as Array<{
        id: string;
        asset_id: string;
        asset_kind: string;
        distance: number;
        duration_sec: number | null;
        tempo_bpm: number | null;
        prompt: string | null;
        kind: string | null;
    }>;
    const results = arr.map((r) => ({
        embeddingId: r.id,
        assetId: r.asset_id,
        assetKind: r.asset_kind,
        similarity: Math.max(0, 1 - Number(r.distance)),
        durationSec: r.duration_sec ?? null,
        tempoBpm: r.tempo_bpm ?? null,
        prompt: r.prompt ?? null,
        kind: r.kind ?? null,
        url: r.asset_kind === "generated" ? `/api/generated/${r.asset_id}` : null,
    }));

    return new Response(JSON.stringify({ ok: true, count: results.length, results }), {
        headers: { "content-type": "application/json" },
    });
}
