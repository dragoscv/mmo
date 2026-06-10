"use server";

/**
 * Server actions for normalized project sub-entities.
 *
 * Generic shape: every sub-entity (daw_tracks, daw_clips,
 * editor_regions, live_cues, mixer_channels, viz_layers) shares the
 * same (userId, externalId, parentExternalId, fieldVersions) sync
 * contract. The single `upsertSubEntity` action accepts arbitrary
 * column patches and runs the same per-field LWW used by /api/sync.
 *
 * Apps call these helpers when they want true row-level granularity
 * (e.g. "user added a clip" instead of "user saved the whole project").
 * The hybrid `document` JSONB on the parent project row is still
 * updated by `saveProject()` from actions/projects.ts during the
 * rolling migration, so even an older client that hasn't switched to
 * granular writes still produces a consistent project on the wire.
 */

import { auth } from "@/auth";
import { db } from "@/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import { SUB_TABLES, type SubEntity } from "@/db/schema-projects-normalized";
import { syncLog } from "@/db/schema";

async function requireUserId(): Promise<string> {
    const s = await auth();
    if (!s?.user?.id) throw new Error("Unauthorized");
    return s.user.id;
}

const FORBIDDEN = new Set([
    "id", "userId", "user_id",
    "externalId", "external_id",
    "syncVersion", "sync_version",
    "fieldVersions", "field_versions",
    "createdAt", "created_at",
    "originDeviceId", "origin_device_id",
]);

export interface SubEntityPatch {
    entity: SubEntity;
    externalId: string;
    parentExternalId?: string;
    patch: Record<string, unknown>;
}

export async function upsertSubEntity(input: SubEntityPatch): Promise<{ externalId: string; updatedAt: string }> {
    const userId = await requireUserId();
    const table = SUB_TABLES[input.entity];
    const ts = new Date().toISOString();

    const existing = await db
        .select({ id: table.id, fv: table.fieldVersions })
        .from(table)
        .where(and(eq(table.userId, userId), eq(table.externalId, input.externalId)))
        .limit(1);

    const stored = (existing[0]?.fv ?? {}) as Record<string, string>;
    const cleaned: Record<string, unknown> = {};
    const nextFv = { ...stored };
    for (const [k, v] of Object.entries(input.patch)) {
        if (FORBIDDEN.has(k)) continue;
        cleaned[k] = v;
        nextFv[k] = ts;
    }

    if (existing.length === 0) {
        if (!input.parentExternalId) throw new Error("parentExternalId required on first insert");
        await db.insert(table).values({
            userId,
            externalId: input.externalId,
            parentExternalId: input.parentExternalId,
            ...cleaned,
            fieldVersions: nextFv,
            updatedAt: new Date(ts),
        } as never);
    } else {
        await db
            .update(table)
            .set({ ...cleaned, fieldVersions: nextFv, updatedAt: new Date(ts) } as never)
            .where(eq(table.id, existing[0].id));
    }

    await db.insert(syncLog).values({
        userId,
        entity: input.entity,
        entityId: input.externalId,
        op: "upsert",
        payload: {
            ...cleaned,
            ...(input.parentExternalId ? { parentExternalId: input.parentExternalId } : {}),
            updatedAt: ts,
        } as object,
        originDeviceId: null,
    });
    return { externalId: input.externalId, updatedAt: ts };
}

export async function deleteSubEntity(entity: SubEntity, externalId: string): Promise<void> {
    const userId = await requireUserId();
    const table = SUB_TABLES[entity];
    const ts = new Date().toISOString();
    await db
        .update(table)
        .set({ deletedAt: new Date(ts), updatedAt: new Date(ts) } as never)
        .where(and(eq(table.userId, userId), eq(table.externalId, externalId)));
    await db.insert(syncLog).values({
        userId,
        entity,
        entityId: externalId,
        op: "delete",
        payload: null,
        originDeviceId: null,
    });
}

export async function listSubEntities(
    entity: SubEntity,
    parentExternalId: string,
): Promise<Array<Record<string, unknown>>> {
    const userId = await requireUserId();
    const table = SUB_TABLES[entity];
    const rows = await db
        .select()
        .from(table)
        .where(and(
            eq(table.userId, userId),
            eq(table.parentExternalId, parentExternalId),
            isNull(table.deletedAt),
        ))
        .orderBy(desc(table.updatedAt))
        .limit(500);
    return rows as unknown as Array<Record<string, unknown>>;
}
