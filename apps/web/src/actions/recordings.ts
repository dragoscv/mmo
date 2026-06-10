"use server";

import { db } from "@/db";
import { recordings, type Recording } from "@/db/schema";
import { auth } from "@/auth";
import { desc, eq, and } from "drizzle-orm";
import { getSetting, updateSetting } from "@/actions/settings";
import { revalidatePath } from "next/cache";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { z } from "zod";

export type RecordingSource = "live" | "mixer" | "daw" | "editor";

const SOURCE_LABELS: Record<RecordingSource, string> = {
    live: "Live",
    mixer: "Mixer",
    daw: "DAW",
    editor: "Editor",
};

const recordingIdSchema = z.number().int().positive();
const recordingNameSchema = z.string().trim().min(1).max(200);
const recordingSourceSchema = z.enum(["live", "mixer", "daw", "editor"]);
// 500 MB hard cap on a single recording — anything bigger is almost
// certainly a runaway browser bug, not a real session.
const MAX_RECORDING_BYTES = 500 * 1024 * 1024;
const saveRecordingShapeSchema = z.object({
    source: recordingSourceSchema,
    mimeType: z.string().min(1).max(128),
    durationMs: z.number().int().min(0).max(24 * 60 * 60 * 1000),
    name: z.string().max(200).optional(),
}).strict().passthrough();

function failedValidation(err: z.ZodError): { success: false; error: string } {
    return { success: false, error: err.issues.map((i) => `${i.path.join(".") || "root"}: ${i.message}`).join("; ") };
}

/**
 * Get the configured recordings folder, falling back to:
 *   <music_root>/Recordings  →  <home>/Music/Recordings
 *
 * Resolves and creates the folder if it doesn't exist.
 */
export async function getRecordingsFolder(): Promise<string> {
    const explicit = await getSetting("recordings_folder");
    if (explicit) {
        await fs.mkdir(explicit, { recursive: true });
        return explicit;
    }

    const musicRoot = await getSetting("music_root");
    const base = musicRoot || path.join(os.homedir(), "Music");
    const folder = path.join(base, "Recordings");
    await fs.mkdir(folder, { recursive: true });
    return folder;
}

export async function setRecordingsFolder(folder: string): Promise<{ success: boolean; error?: string }> {
    // Auth gate runs before any FS work: previously `fs.mkdir(folder)` ran on a
    // caller-controlled path before `updateSetting` did its own auth check, so
    // an unauthenticated caller could create arbitrary directories on the host.
    const session = await auth();
    if (!session?.user?.id) return { success: false, error: "Not authenticated" };
    if (!folder?.trim()) return { success: false, error: "Folder path required" };
    try {
        await fs.mkdir(folder, { recursive: true });
        const r = await updateSetting("recordings_folder", folder);
        if (!r.success) return { success: false, error: r.error || "Failed to save" };
        revalidatePath("/settings");
        revalidatePath("/recordings");
        return { success: true };
    } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : "Failed to create folder" };
    }
}

function sanitizeFilename(name: string): string {
    return name.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").trim();
}

function timestampSlug(): string {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/**
 * Save a recording to disk + DB. Called from a Route Handler that received
 * the blob via FormData. Returns the inserted row.
 */
export async function saveRecording(input: {
    source: RecordingSource;
    arrayBuffer: ArrayBuffer;
    mimeType: string;
    durationMs: number;
    name?: string;
    metadata?: Record<string, unknown>;
}): Promise<{ success: true; recording: Recording } | { success: false; error: string }> {
    // Auth required: this writes a caller-supplied buffer to disk and inserts a
    // DB row. The previous `auth().catch(()=>null)` allowed `userId = null`
    // anonymous saves, which is meaningless on the cloud (no FS) and an
    // unauthenticated arbitrary-write surface in any deployment that does have
    // FS. Local/companion mode still works because the local user is authed.
    const session = await auth();
    if (!session?.user?.id) return { success: false, error: "Not authenticated" };
    const userId = session.user.id;
    const shapeCheck = saveRecordingShapeSchema.safeParse({
        source: input.source,
        mimeType: input.mimeType,
        durationMs: input.durationMs,
        name: input.name,
    });
    if (!shapeCheck.success) return failedValidation(shapeCheck.error);
    if (input.arrayBuffer.byteLength > MAX_RECORDING_BYTES) {
        return { success: false, error: `Recording exceeds ${MAX_RECORDING_BYTES} bytes` };
    }
    try {
        const folder = await getRecordingsFolder();
        const ext = input.mimeType.includes("ogg") ? "ogg"
            : input.mimeType.includes("wav") ? "wav"
                : input.mimeType.includes("mp4") ? "m4a"
                    : "webm";
        const ts = timestampSlug();
        const baseName = sanitizeFilename(input.name?.trim() || `${SOURCE_LABELS[input.source]} ${ts}`);
        const filename = `${baseName}.${ext}`;
        const filepath = path.join(folder, filename);

        await fs.writeFile(filepath, Buffer.from(input.arrayBuffer));
        const stat = await fs.stat(filepath);

        const inserted = await db.insert(recordings).values({
            userId,
            source: input.source,
            name: baseName,
            filepath,
            filename,
            mimeType: input.mimeType,
            durationMs: Math.round(input.durationMs),
            sizeBytes: stat.size,
            metadata: input.metadata ?? null,
        }).returning();

        revalidatePath("/recordings");
        return { success: true, recording: inserted[0] };
    } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : "Save failed" };
    }
}

export async function listRecordings(opts?: { source?: RecordingSource; limit?: number }): Promise<Recording[]> {
    // Require auth. The previous `auth().catch(() => null)` would make
    // `userId` undefined, drop the userId filter, and dump every
    // recording in the database (capped at 200 rows) to anyone hitting
    // this server action without a valid session — a full cross-tenant
    // disclosure.
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) return [];

    const conditions = [eq(recordings.userId, userId)];
    if (opts?.source) conditions.push(eq(recordings.source, opts.source));

    const q = db.select().from(recordings)
        .where(and(...conditions))
        .orderBy(desc(recordings.createdAt))
        .limit(opts?.limit ?? 200);
    return q;
}

export async function renameRecording(id: number, name: string): Promise<{ success: boolean; error?: string }> {
    const idCheck = recordingIdSchema.safeParse(id);
    if (!idCheck.success) return failedValidation(idCheck.error);
    const nameCheck = recordingNameSchema.safeParse(name);
    if (!nameCheck.success) return failedValidation(nameCheck.error);
    const trimmed = nameCheck.data;
    // Ownership scope: row.userId must be the caller. Previously this
    // also matched `isNull(userId)` for "legacy pre-multi-tenant rows";
    // that escape lets any signed-in user enumerate IDs and rename any
    // orphan recording (and move the underlying file via `fs.rename`).
    // Real legacy data should be backfilled with the owning userId, not
    // left readable by everyone.
    const session = await auth();
    if (!session?.user?.id) return { success: false, error: "Not authenticated" };
    const userId = session.user.id;
    const ownership = eq(recordings.userId, userId);
    try {
        const rows = await db.select().from(recordings)
            .where(and(eq(recordings.id, id), ownership)).limit(1);
        const row = rows[0];
        if (!row) return { success: false, error: "Not found" };

        // Rename on disk too — keep extension
        const ext = path.extname(row.filename);
        const newFilename = `${sanitizeFilename(trimmed)}${ext}`;
        const newPath = path.join(path.dirname(row.filepath), newFilename);
        if (newPath !== row.filepath) {
            await fs.rename(row.filepath, newPath);
        }

        await db.update(recordings).set({
            name: trimmed,
            filename: newFilename,
            filepath: newPath,
        }).where(and(eq(recordings.id, id), ownership));

        revalidatePath("/recordings");
        return { success: true };
    } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : "Rename failed" };
    }
}

export async function deleteRecording(id: number): Promise<{ success: boolean; error?: string }> {
    const idCheck = recordingIdSchema.safeParse(id);
    if (!idCheck.success) return failedValidation(idCheck.error);
    const session = await auth();
    if (!session?.user?.id) return { success: false, error: "Not authenticated" };
    const userId = session.user.id;
    const ownership = eq(recordings.userId, userId);
    try {
        const rows = await db.select().from(recordings)
            .where(and(eq(recordings.id, id), ownership)).limit(1);
        const row = rows[0];
        if (!row) return { success: false, error: "Not found" };
        // Best-effort delete from disk; DB row is authoritative
        await fs.unlink(row.filepath).catch(() => { /* file already gone */ });
        await db.delete(recordings).where(and(eq(recordings.id, id), ownership));
        revalidatePath("/recordings");
        return { success: true };
    } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : "Delete failed" };
    }
}

export async function toggleRecordingFavorite(id: number): Promise<{ success: boolean; isFavorite?: boolean }> {
    const idCheck = recordingIdSchema.safeParse(id);
    if (!idCheck.success) return { success: false };
    const session = await auth();
    if (!session?.user?.id) return { success: false };
    const userId = session.user.id;
    const ownership = eq(recordings.userId, userId);
    const rows = await db.select().from(recordings)
        .where(and(eq(recordings.id, id), ownership)).limit(1);
    const row = rows[0];
    if (!row) return { success: false };
    const next = !row.isFavorite;
    await db.update(recordings).set({ isFavorite: next })
        .where(and(eq(recordings.id, id), ownership));
    revalidatePath("/recordings");
    return { success: true, isFavorite: next };
}
