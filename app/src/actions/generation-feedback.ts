"use server";

/**
 * Generation feedback — thumbs up / thumbs down on `generated_assets`.
 *
 * Drives two downstream uses:
 *  1. Auto-built "tastebox" datasets (see `buildDatasetFromThumbsUp`).
 *  2. DPO preference pairs for the conductor + ACE-Step preference tracks.
 *
 * Pairs are mined in `getDpoPairs` by joining feedback on equal-prompt
 * generations: thumbs-up = chosen, thumbs-down = rejected. Future work:
 * also pair by embedding similarity when prompts differ slightly.
 */

import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import { auth } from "@/auth";
import { db } from "@/db";
import { generatedAssets } from "@/db/schema-ai";
import { syncLog } from "@/db/schema";
import { generationFeedback, loraAssets } from "@/db/schema-training";
import { FEEDBACK_REASONS, type RecordFeedbackInput } from "@/lib/maestro/feedback-constants";

async function uid(): Promise<string> {
    const s = await auth();
    const id = s?.user?.id;
    if (!id) throw new Error("Not signed in");
    return id;
}

const RecordSchema = z.object({
    assetId: z.string(),
    verdict: z.enum(["up", "down", "flag"]),
    reasons: z.array(z.enum(FEEDBACK_REASONS)).max(8).optional(),
    note: z.string().max(2000).optional(),
    score: z.number().int().min(1).max(5).optional(),
});

export async function recordGenerationFeedback(
    raw: RecordFeedbackInput,
): Promise<
    | { ok: true; created: boolean }
    | { ok: false; error: string }
> {
    const userId = await uid();
    const parsed = RecordSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: `invalid-input: ${parsed.error.message}` };
    const input = parsed.data;

    // Make sure the asset exists and the caller owns it (or it's a public
    // sample, but we don't have those yet — for now scope is strict).
    const [asset] = await db
        .select({ id: generatedAssets.id, userId: generatedAssets.userId, params: generatedAssets.params })
        .from(generatedAssets)
        .where(eq(generatedAssets.id, input.assetId))
        .limit(1);
    if (!asset) return { ok: false, error: "asset-not-found" };
    if (asset.userId !== userId) return { ok: false, error: "forbidden" };

    // Upsert — one feedback row per (user, asset). Re-rating overwrites.
    const existing = await db
        .select({ id: generationFeedback.id })
        .from(generationFeedback)
        .where(and(eq(generationFeedback.userId, userId), eq(generationFeedback.assetId, input.assetId)))
        .limit(1);

    if (existing.length > 0) {
        await db
            .update(generationFeedback)
            .set({
                verdict: input.verdict,
                reasons: input.reasons ?? [],
                note: input.note ?? null,
                score: input.score ?? null,
                usedInDpo: false, // reset so the new verdict is considered
            })
            .where(eq(generationFeedback.id, existing[0].id));
    } else {
        await db.insert(generationFeedback).values({
            userId,
            assetId: input.assetId,
            verdict: input.verdict,
            reasons: input.reasons ?? [],
            note: input.note ?? null,
            score: input.score ?? null,
        });
    }

    // Update derived metric on lora_assets when the generation used one.
    // params.loraId is set by the inference router when present.
    const params = (asset.params ?? null) as { loraId?: string; loraIds?: string[] } | null;
    const usedLoraIds = params?.loraIds ?? (params?.loraId ? [params.loraId] : []);
    if (usedLoraIds.length > 0) {
        await recomputeLoraThumbsUpRate(usedLoraIds);
    }

    await db.insert(syncLog).values({
        userId,
        entity: "generationFeedback",
        entityId: input.assetId,
        op: "upsert",
        payload: { assetId: input.assetId, verdict: input.verdict, reasons: input.reasons ?? [] } as object,
        originDeviceId: null,
    });

    return { ok: true, created: existing.length === 0 };
}

export async function listFeedbackForAsset(assetId: string): Promise<
    Array<{ id: string; verdict: string; reasons: string[]; note: string | null; score: number | null; createdAt: string }>
> {
    const userId = await uid();
    const rows = await db
        .select()
        .from(generationFeedback)
        .where(and(eq(generationFeedback.assetId, assetId), eq(generationFeedback.userId, userId)))
        .orderBy(desc(generationFeedback.createdAt));
    return rows.map((r) => ({
        id: r.id,
        verdict: r.verdict,
        reasons: (r.reasons ?? []) as string[],
        note: r.note,
        score: r.score,
        createdAt: (r.createdAt ?? new Date()).toISOString(),
    }));
}

export interface FeedbackSummary {
    total: number;
    up: number;
    down: number;
    flagged: number;
    topReasons: Array<{ reason: string; count: number }>;
    recentNotes: Array<{ note: string; verdict: string; createdAt: string }>;
}

export async function summarizeFeedback(opts?: { sinceDays?: number }): Promise<FeedbackSummary> {
    const userId = await uid();
    const since = new Date(Date.now() - (opts?.sinceDays ?? 30) * 86400_000);
    const rows = await db
        .select()
        .from(generationFeedback)
        .where(and(eq(generationFeedback.userId, userId), gte(generationFeedback.createdAt, since)))
        .orderBy(desc(generationFeedback.createdAt))
        .limit(500);
    const reasonCounts: Record<string, number> = {};
    let up = 0;
    let down = 0;
    let flagged = 0;
    const recentNotes: Array<{ note: string; verdict: string; createdAt: string }> = [];
    for (const r of rows) {
        if (r.verdict === "up") up++;
        else if (r.verdict === "down") down++;
        else if (r.verdict === "flag") flagged++;
        for (const reason of (r.reasons ?? []) as string[]) {
            reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
        }
        if (r.note && recentNotes.length < 8) {
            recentNotes.push({ note: r.note, verdict: r.verdict, createdAt: (r.createdAt ?? new Date()).toISOString() });
        }
    }
    return {
        total: rows.length,
        up,
        down,
        flagged,
        topReasons: Object.entries(reasonCounts)
            .map(([reason, count]) => ({ reason, count }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 10),
        recentNotes,
    };
}

async function recomputeLoraThumbsUpRate(loraIds: string[]): Promise<void> {
    if (loraIds.length === 0) return;
    // Counts of up/down by lora across the user's assets in the last 90d.
    // Cheap to recompute on every feedback because volume is low.
    const since = new Date(Date.now() - 90 * 86400_000);
    const rows = await db
        .select({
            assetId: generationFeedback.assetId,
            verdict: generationFeedback.verdict,
            params: generatedAssets.params,
        })
        .from(generationFeedback)
        .innerJoin(generatedAssets, eq(generatedAssets.id, generationFeedback.assetId))
        .where(gte(generationFeedback.createdAt, since));
    const buckets = new Map<string, { up: number; total: number }>();
    for (const id of loraIds) buckets.set(id, { up: 0, total: 0 });
    for (const r of rows) {
        const p = (r.params ?? null) as { loraId?: string; loraIds?: string[] } | null;
        const ids = p?.loraIds ?? (p?.loraId ? [p.loraId] : []);
        for (const id of ids) {
            if (!buckets.has(id)) continue;
            const b = buckets.get(id)!;
            b.total++;
            if (r.verdict === "up") b.up++;
        }
    }
    const updates = Array.from(buckets.entries()).filter(([, v]) => v.total > 0);
    for (const [id, v] of updates) {
        await db
            .update(loraAssets)
            .set({
                thumbsUpRate: v.up / v.total,
                usageCount: v.total,
                updatedAt: new Date(),
            })
            .where(eq(loraAssets.id, id));
    }
}

// ─── DPO pair mining ────────────────────────────────────────────────────

export interface DpoPair {
    chosenAssetId: string;
    rejectedAssetId: string;
    prompt: string;
    chosenScore: number;
    rejectedScore: number;
}

/** Mine preference pairs: for each prompt with at least one up and one down
 *  generation, take the most-up and most-down. Bounded by `limit`. */
export async function getDpoPairs(limit = 200): Promise<DpoPair[]> {
    const userId = await uid();
    const rows = await db
        .select({
            assetId: generatedAssets.id,
            prompt: generatedAssets.promptText,
            verdict: generationFeedback.verdict,
            score: generationFeedback.score,
        })
        .from(generationFeedback)
        .innerJoin(generatedAssets, eq(generatedAssets.id, generationFeedback.assetId))
        .where(
            and(
                eq(generatedAssets.userId, userId),
                eq(generationFeedback.usedInDpo, false),
                inArray(generationFeedback.verdict, ["up", "down"]),
            ),
        )
        .limit(2000);

    type Row = { assetId: string; prompt: string | null; verdict: string; score: number | null };
    const byPrompt = new Map<string, Row[]>();
    for (const r of rows as Row[]) {
        const key = (r.prompt ?? "").trim().toLowerCase();
        if (!key) continue;
        const list = byPrompt.get(key) ?? [];
        list.push(r);
        byPrompt.set(key, list);
    }
    const pairs: DpoPair[] = [];
    for (const [prompt, list] of byPrompt) {
        const ups = list.filter((r) => r.verdict === "up").sort((a, b) => (b.score ?? 1) - (a.score ?? 1));
        const downs = list.filter((r) => r.verdict === "down").sort((a, b) => (a.score ?? 1) - (b.score ?? 1));
        if (ups.length === 0 || downs.length === 0) continue;
        pairs.push({
            chosenAssetId: ups[0].assetId,
            rejectedAssetId: downs[0].assetId,
            prompt,
            chosenScore: ups[0].score ?? 1,
            rejectedScore: downs[0].score ?? 1,
        });
        if (pairs.length >= limit) break;
    }
    return pairs;
}
