"use server";

/**
 * Project persistence — unified server actions for DAW, Sound Editor,
 * Live, Mixer, Visualization presets.
 *
 * Storage model: one row per project; `document` JSONB holds the full
 * structured state. Per-row LWW via `updatedAt`/`fieldVersions` (see
 * sync-apply.ts) keeps cross-device edits consistent without a CRDT.
 *
 * Auth: every action requires the caller to be signed in (cloud session).
 * For companion-driven writes the existing `/api/sync` POST path is used
 * with a device token; this file is the cloud/web counterpart.
 *
 * Sync: every write appends a `syncLog` row so paired companions pick the
 * change up on their next `GET /api/sync` poll.
 */

import { auth } from "@/auth";
import { db } from "@/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import {
    PROJECT_TABLES,
    PROJECT_SYNC_ENTITY,
    projectSnapshots,
    projectAssets,
    type ProjectKind,
} from "@/db/schema-projects";
import { syncLog } from "@/db/schema";
import { revalidatePath } from "next/cache";

async function requireUserId(): Promise<string> {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) throw new Error("Unauthorized");
    return userId;
}

function nowIso(): string {
    return new Date().toISOString();
}

async function appendLog(
    userId: string,
    entity: string,
    entityId: string,
    op: "upsert" | "delete",
    payload: Record<string, unknown> | null,
): Promise<void> {
    await db.insert(syncLog).values({
        userId,
        entity,
        entityId,
        op,
        payload: payload as object | null,
        originDeviceId: null,
    });
}

export interface ProjectSummary {
    externalId: string;
    name: string;
    updatedAt: string | null;
    createdAt: string | null;
}

export async function listProjects(kind: ProjectKind): Promise<ProjectSummary[]> {
    const userId = await requireUserId();
    const table = PROJECT_TABLES[kind];
    const rows = await db
        .select({
            externalId: table.externalId,
            name: table.name,
            updatedAt: table.updatedAt,
            createdAt: table.createdAt,
        })
        .from(table)
        .where(and(eq(table.userId, userId), isNull(table.deletedAt)))
        .orderBy(desc(table.updatedAt))
        .limit(200);
    return rows.map((r) => ({
        externalId: r.externalId,
        name: r.name,
        updatedAt: r.updatedAt ? r.updatedAt.toISOString() : null,
        createdAt: r.createdAt ? r.createdAt.toISOString() : null,
    }));
}

export async function getProject(
    kind: ProjectKind,
    externalId: string,
): Promise<{ externalId: string; name: string; document: Record<string, unknown>; updatedAt: string | null } | null> {
    const userId = await requireUserId();
    const table = PROJECT_TABLES[kind];
    const rows = await db
        .select({
            externalId: table.externalId,
            name: table.name,
            document: table.document,
            updatedAt: table.updatedAt,
            deletedAt: table.deletedAt,
        })
        .from(table)
        .where(and(eq(table.userId, userId), eq(table.externalId, externalId)))
        .limit(1);
    if (rows.length === 0 || rows[0].deletedAt) return null;
    return {
        externalId: rows[0].externalId,
        name: rows[0].name,
        document: rows[0].document as Record<string, unknown>,
        updatedAt: rows[0].updatedAt ? rows[0].updatedAt.toISOString() : null,
    };
}

export interface SaveProjectInput {
    kind: ProjectKind;
    externalId: string;
    name?: string;
    document: Record<string, unknown>;
    /** Extra typed columns (e.g. daw: { bpm, keyCamelot }). */
    extras?: Record<string, unknown>;
}

export async function saveProject(input: SaveProjectInput): Promise<{ externalId: string; updatedAt: string }> {
    const userId = await requireUserId();
    const table = PROJECT_TABLES[input.kind];
    const ts = nowIso();

    const payload: Record<string, unknown> = {
        ...(input.name !== undefined ? { name: input.name } : {}),
        document: input.document,
        ...(input.extras ?? {}),
    };

    const existing = await db
        .select({ id: table.id, fv: table.fieldVersions })
        .from(table)
        .where(and(eq(table.userId, userId), eq(table.externalId, input.externalId)))
        .limit(1);

    const fv = (existing[0]?.fv ?? {}) as Record<string, string>;
    const nextFv: Record<string, string> = { ...fv };
    for (const key of Object.keys(payload)) nextFv[key] = ts;

    if (existing.length === 0) {
        await db.insert(table).values({
            userId,
            externalId: input.externalId,
            ...payload,
            fieldVersions: nextFv,
            updatedAt: new Date(ts),
        } as never);
    } else {
        await db
            .update(table)
            .set({
                ...payload,
                fieldVersions: nextFv,
                updatedAt: new Date(ts),
            } as never)
            .where(eq(table.id, existing[0].id));
    }

    await appendLog(userId, PROJECT_SYNC_ENTITY[input.kind], input.externalId, "upsert", {
        ...payload,
        updatedAt: ts,
    });

    return { externalId: input.externalId, updatedAt: ts };
}

export async function deleteProject(kind: ProjectKind, externalId: string): Promise<void> {
    const userId = await requireUserId();
    const table = PROJECT_TABLES[kind];
    const ts = nowIso();
    await db
        .update(table)
        .set({ deletedAt: new Date(ts), updatedAt: new Date(ts) } as never)
        .where(and(eq(table.userId, userId), eq(table.externalId, externalId)));
    await appendLog(userId, PROJECT_SYNC_ENTITY[kind], externalId, "delete", null);
}

// ─── Snapshots ───────────────────────────────────────────────────────────

export interface SnapshotSummary {
    externalId: string;
    label: string | null;
    auto: boolean;
    createdAt: string | null;
    gitCommitSha: string | null;
}

export async function listSnapshots(
    kind: ProjectKind,
    projectExternalId: string,
): Promise<SnapshotSummary[]> {
    const userId = await requireUserId();
    const rows = await db
        .select({
            externalId: projectSnapshots.externalId,
            label: projectSnapshots.label,
            auto: projectSnapshots.auto,
            createdAt: projectSnapshots.createdAt,
            gitCommitSha: projectSnapshots.gitCommitSha,
        })
        .from(projectSnapshots)
        .where(and(
            eq(projectSnapshots.userId, userId),
            eq(projectSnapshots.projectKind, kind),
            eq(projectSnapshots.projectExternalId, projectExternalId),
        ))
        .orderBy(desc(projectSnapshots.createdAt))
        .limit(100);
    return rows.map((r) => ({
        externalId: r.externalId,
        label: r.label,
        auto: r.auto ?? true,
        createdAt: r.createdAt ? r.createdAt.toISOString() : null,
        gitCommitSha: r.gitCommitSha,
    }));
}

export async function createSnapshot(
    kind: ProjectKind,
    projectExternalId: string,
    document: Record<string, unknown>,
    label?: string,
): Promise<{ externalId: string; gitCommitSha: string | null }> {
    const userId = await requireUserId();
    const externalId = crypto.randomUUID();

    // Best-effort GitHub commit. If the user hasn't linked GitHub yet,
    // commitSnapshot returns null and we just persist the snapshot row.
    let gitCommitSha: string | null = null;
    try {
        const { commitSnapshot } = await import("@/lib/git/github");
        const res = await commitSnapshot({
            userId,
            projectKind: kind,
            projectExternalId,
            snapshotExternalId: externalId,
            label: label ?? null,
            document,
        });
        if (res) gitCommitSha = res.sha;
    } catch (err) {
        // Don't block the snapshot on a transient GitHub error.
        console.warn("[createSnapshot] github commit failed:", err);
    }

    await db.insert(projectSnapshots).values({
        userId,
        externalId,
        projectKind: kind,
        projectExternalId,
        label: label ?? null,
        auto: !label,
        document,
        gitCommitSha,
    });
    await appendLog(userId, "project_snapshots", externalId, "upsert", {
        projectKind: kind,
        projectExternalId,
        label: label ?? null,
        auto: !label,
        document,
        gitCommitSha,
    });

    // Retention: keep the 50 most-recent auto snapshots per project.
    // Manual (labeled) snapshots are NEVER pruned automatically.
    if (!label) {
        const autoRows = await db
            .select({ id: projectSnapshots.id, externalId: projectSnapshots.externalId })
            .from(projectSnapshots)
            .where(and(
                eq(projectSnapshots.userId, userId),
                eq(projectSnapshots.projectKind, kind),
                eq(projectSnapshots.projectExternalId, projectExternalId),
                eq(projectSnapshots.auto, true),
            ))
            .orderBy(desc(projectSnapshots.createdAt));
        const stale = autoRows.slice(50);
        for (const s of stale) {
            await db.delete(projectSnapshots).where(eq(projectSnapshots.id, s.id));
            await appendLog(userId, "project_snapshots", s.externalId, "delete", null);
        }
    }

    return { externalId, gitCommitSha };
}

export async function getSnapshot(
    externalId: string,
): Promise<{ document: Record<string, unknown>; label: string | null } | null> {
    const userId = await requireUserId();
    const rows = await db
        .select({ document: projectSnapshots.document, label: projectSnapshots.label })
        .from(projectSnapshots)
        .where(and(eq(projectSnapshots.userId, userId), eq(projectSnapshots.externalId, externalId)))
        .limit(1);
    if (rows.length === 0) return null;
    return { document: rows[0].document as Record<string, unknown>, label: rows[0].label };
}

/** Restore a snapshot into its source project (overwrites current state). */
export async function restoreSnapshot(externalId: string): Promise<void> {
    const userId = await requireUserId();
    const rows = await db
        .select({
            projectKind: projectSnapshots.projectKind,
            projectExternalId: projectSnapshots.projectExternalId,
            document: projectSnapshots.document,
        })
        .from(projectSnapshots)
        .where(and(eq(projectSnapshots.userId, userId), eq(projectSnapshots.externalId, externalId)))
        .limit(1);
    if (rows.length === 0) throw new Error("Snapshot not found");
    const r = rows[0];
    await saveProject({
        kind: r.projectKind as ProjectKind,
        externalId: r.projectExternalId,
        document: r.document as Record<string, unknown>,
    });
}

// ─── Asset registry (binary blob references) ─────────────────────────────

export interface RegisterAssetInput {
    externalId?: string;
    projectKind?: ProjectKind;
    projectExternalId?: string;
    sha256: string;
    name: string;
    mimeType?: string;
    sizeBytes?: number;
    durationMs?: number;
    gcsObjectKey?: string;
    companionId?: string;
    companionPath?: string;
    metadata?: Record<string, unknown>;
}

export async function registerAsset(input: RegisterAssetInput): Promise<{ externalId: string }> {
    const userId = await requireUserId();
    const externalId = input.externalId ?? crypto.randomUUID();
    const ts = nowIso();
    const payload = {
        sha256: input.sha256,
        name: input.name,
        ...(input.projectKind ? { projectKind: input.projectKind } : {}),
        ...(input.projectExternalId ? { projectExternalId: input.projectExternalId } : {}),
        ...(input.mimeType ? { mimeType: input.mimeType } : {}),
        ...(input.sizeBytes !== undefined ? { sizeBytes: input.sizeBytes } : {}),
        ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
        ...(input.gcsObjectKey ? { gcsObjectKey: input.gcsObjectKey } : {}),
        ...(input.companionId ? { companionId: input.companionId } : {}),
        ...(input.companionPath ? { companionPath: input.companionPath } : {}),
        ...(input.metadata ? { metadata: input.metadata } : {}),
    };
    await db
        .insert(projectAssets)
        .values({
            userId,
            externalId,
            ...payload,
            updatedAt: new Date(ts),
        } as never)
        .onConflictDoNothing();
    await appendLog(userId, "project_assets", externalId, "upsert", { ...payload, updatedAt: ts });
    return { externalId };
}

export async function listProjectAssets(
    kind: ProjectKind,
    projectExternalId: string,
): Promise<Array<{ externalId: string; name: string; sha256: string; sizeBytes: number | null; mimeType: string | null; gcsObjectKey: string | null; companionId: string | null; companionPath: string | null }>> {
    const userId = await requireUserId();
    const rows = await db
        .select({
            externalId: projectAssets.externalId,
            name: projectAssets.name,
            sha256: projectAssets.sha256,
            sizeBytes: projectAssets.sizeBytes,
            mimeType: projectAssets.mimeType,
            gcsObjectKey: projectAssets.gcsObjectKey,
            companionId: projectAssets.companionId,
            companionPath: projectAssets.companionPath,
            deletedAt: projectAssets.deletedAt,
        })
        .from(projectAssets)
        .where(and(
            eq(projectAssets.userId, userId),
            eq(projectAssets.projectKind, kind),
            eq(projectAssets.projectExternalId, projectExternalId),
        ))
        .orderBy(desc(projectAssets.createdAt));
    return rows.filter((r) => !r.deletedAt).map((r) => ({
        externalId: r.externalId,
        name: r.name,
        sha256: r.sha256,
        sizeBytes: r.sizeBytes,
        mimeType: r.mimeType,
        gcsObjectKey: r.gcsObjectKey,
        companionId: r.companionId,
        companionPath: r.companionPath,
    }));
}

export async function revalidateProjectsList(kind: ProjectKind): Promise<void> {
    revalidatePath(`/${kind === "editor" ? "editor" : kind}`);
}
