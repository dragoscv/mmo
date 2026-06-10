"use server";

/**
 * LoRA asset registry — server actions.
 *
 * The inference router (actions/generate.ts → generateMusic) reads from
 * here to discover which LoRA adapters are available for the current
 * user, what trigger tokens they expose, and which are best-rated. The
 * Maestro `loras.*` tools wrap these so the model can list, activate,
 * and deactivate adapters interactively.
 */

import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { auth } from "@/auth";
import { db } from "@/db";
import { loraAssets } from "@/db/schema-training";

async function uid(): Promise<string> {
    const s = await auth();
    const id = s?.user?.id;
    if (!id) throw new Error("Not signed in");
    return id;
}

export interface LoraDto {
    id: string;
    userId: string | null;
    scope: "user" | "shared";
    kind: "style" | "user" | "stem" | "mood";
    jobId: string | null;
    name: string;
    description: string | null;
    triggerToken: string | null;
    baseModel: string;
    rank: number;
    weightsUri: string;
    previewUri: string | null;
    tags: string[];
    evalLoss: number | null;
    usageCount: number;
    thumbsUpRate: number | null;
    status: "active" | "deprecated" | "archived";
    createdAt: string;
}

function toDto(row: typeof loraAssets.$inferSelect): LoraDto {
    return {
        id: row.id,
        userId: row.userId,
        scope: row.scope as LoraDto["scope"],
        kind: row.kind as LoraDto["kind"],
        jobId: row.jobId,
        name: row.name,
        description: row.description,
        triggerToken: row.triggerToken,
        baseModel: row.baseModel,
        rank: row.rank,
        weightsUri: row.weightsUri,
        previewUri: row.previewUri,
        tags: (row.tags ?? []) as string[],
        evalLoss: row.evalLoss,
        usageCount: row.usageCount,
        thumbsUpRate: row.thumbsUpRate,
        status: row.status as LoraDto["status"],
        createdAt: (row.createdAt ?? new Date()).toISOString(),
    };
}

/** List LoRAs visible to the caller — their own plus shared ones. */
export async function listLoras(opts?: {
    kind?: "style" | "user" | "stem" | "mood";
    status?: "active" | "deprecated" | "archived";
}): Promise<LoraDto[]> {
    const userId = await uid();
    const conds: ReturnType<typeof sql>[] = [
        sql`(${loraAssets.userId} = ${userId} OR ${loraAssets.scope} = 'shared')`,
    ];
    if (opts?.kind) conds.push(sql`${loraAssets.kind} = ${opts.kind}`);
    conds.push(sql`${loraAssets.status} = ${opts?.status ?? "active"}`);
    const rows = await db
        .select()
        .from(loraAssets)
        .where(sql.join(conds, sql` AND `))
        .orderBy(desc(loraAssets.thumbsUpRate), desc(loraAssets.createdAt))
        .limit(100);
    return rows.map(toDto);
}

const UpdateSchema = z.object({
    id: z.string(),
    name: z.string().min(1).max(120).optional(),
    description: z.string().max(1000).nullable().optional(),
    triggerToken: z.string().max(60).nullable().optional(),
    tags: z.array(z.string().max(40)).max(20).optional(),
    status: z.enum(["active", "deprecated", "archived"]).optional(),
});

export async function updateLora(
    raw: z.infer<typeof UpdateSchema>,
): Promise<{ ok: true; lora: LoraDto } | { ok: false; error: string }> {
    const userId = await uid();
    const parsed = UpdateSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: `invalid-input: ${parsed.error.message}` };
    const [row] = await db
        .select()
        .from(loraAssets)
        .where(eq(loraAssets.id, parsed.data.id))
        .limit(1);
    if (!row) return { ok: false, error: "lora-not-found" };
    if (row.scope === "user" && row.userId !== userId) return { ok: false, error: "forbidden" };
    const updates: Partial<typeof loraAssets.$inferInsert> = { updatedAt: new Date() };
    if (parsed.data.name !== undefined) updates.name = parsed.data.name;
    if (parsed.data.description !== undefined) updates.description = parsed.data.description;
    if (parsed.data.triggerToken !== undefined) updates.triggerToken = parsed.data.triggerToken;
    if (parsed.data.tags !== undefined) updates.tags = parsed.data.tags;
    if (parsed.data.status !== undefined) updates.status = parsed.data.status;
    const [updated] = await db
        .update(loraAssets)
        .set(updates)
        .where(eq(loraAssets.id, parsed.data.id))
        .returning();
    return { ok: true, lora: toDto(updated) };
}

/** Find LoRAs that match a free-form genre/mood prompt. Used by the
 *  inference router to auto-attach style adapters when the user types
 *  "melodic techno" and a `<melodic_techno>` adapter exists. */
export async function findLorasForPrompt(prompt: string, limit = 4): Promise<LoraDto[]> {
    const userId = await uid();
    const tokens = prompt
        .toLowerCase()
        .split(/[,\s]+/)
        .filter((t) => t.length > 2);
    if (tokens.length === 0) return [];
    const rows = await db
        .select()
        .from(loraAssets)
        .where(
            sql`(${loraAssets.userId} = ${userId} OR ${loraAssets.scope} = 'shared') AND ${loraAssets.status} = 'active'`,
        )
        .limit(200);
    const scored = rows.map((r) => {
        const hay = [r.name, r.description ?? "", (r.tags ?? []).join(" "), r.triggerToken ?? ""].join(" ").toLowerCase();
        let score = 0;
        for (const t of tokens) {
            if (hay.includes(t)) score += 1;
        }
        // Boost by thumbs-up rate to prefer proven adapters.
        score += (r.thumbsUpRate ?? 0.5) * 0.5;
        return { row: r, score };
    });
    return scored
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((s) => toDto(s.row));
}
