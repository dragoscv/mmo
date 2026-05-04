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

export type RecordingSource = "live" | "mixer" | "daw" | "editor";

const SOURCE_LABELS: Record<RecordingSource, string> = {
    live: "Live",
    mixer: "Mixer",
    daw: "DAW",
    editor: "Editor",
};

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

        const session = await auth().catch(() => null);
        const userId = session?.user?.id ?? null;

        const inserted = db.insert(recordings).values({
            userId,
            source: input.source,
            name: baseName,
            filepath,
            filename,
            mimeType: input.mimeType,
            durationMs: Math.round(input.durationMs),
            sizeBytes: stat.size,
            metadata: input.metadata ? JSON.stringify(input.metadata) : null,
        }).returning().all();

        revalidatePath("/recordings");
        return { success: true, recording: inserted[0] };
    } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : "Save failed" };
    }
}

export async function listRecordings(opts?: { source?: RecordingSource; limit?: number }): Promise<Recording[]> {
    const session = await auth().catch(() => null);
    const userId = session?.user?.id;

    const conditions = [];
    if (userId) conditions.push(eq(recordings.userId, userId));
    if (opts?.source) conditions.push(eq(recordings.source, opts.source));

    const q = db.select().from(recordings)
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(desc(recordings.createdAt))
        .limit(opts?.limit ?? 200);
    return q.all();
}

export async function renameRecording(id: number, name: string): Promise<{ success: boolean; error?: string }> {
    const trimmed = name.trim();
    if (!trimmed) return { success: false, error: "Name required" };
    try {
        const row = db.select().from(recordings).where(eq(recordings.id, id)).get();
        if (!row) return { success: false, error: "Not found" };

        // Rename on disk too — keep extension
        const ext = path.extname(row.filename);
        const newFilename = `${sanitizeFilename(trimmed)}${ext}`;
        const newPath = path.join(path.dirname(row.filepath), newFilename);
        if (newPath !== row.filepath) {
            await fs.rename(row.filepath, newPath);
        }

        db.update(recordings).set({
            name: trimmed,
            filename: newFilename,
            filepath: newPath,
        }).where(eq(recordings.id, id)).run();

        revalidatePath("/recordings");
        return { success: true };
    } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : "Rename failed" };
    }
}

export async function deleteRecording(id: number): Promise<{ success: boolean; error?: string }> {
    try {
        const row = db.select().from(recordings).where(eq(recordings.id, id)).get();
        if (!row) return { success: false, error: "Not found" };
        // Best-effort delete from disk; DB row is authoritative
        await fs.unlink(row.filepath).catch(() => { /* file already gone */ });
        db.delete(recordings).where(eq(recordings.id, id)).run();
        revalidatePath("/recordings");
        return { success: true };
    } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : "Delete failed" };
    }
}

export async function toggleRecordingFavorite(id: number): Promise<{ success: boolean; isFavorite?: boolean }> {
    const row = db.select().from(recordings).where(eq(recordings.id, id)).get();
    if (!row) return { success: false };
    const next = !row.isFavorite;
    db.update(recordings).set({ isFavorite: next }).where(eq(recordings.id, id)).run();
    revalidatePath("/recordings");
    return { success: true, isFavorite: next };
}
