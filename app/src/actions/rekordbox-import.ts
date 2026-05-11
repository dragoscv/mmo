"use server";

import { auth } from "@/auth";
import { db } from "@/db";
import { tracks } from "@/db/schema";
import { parseRekordboxXml } from "@/lib/rekordbox-import";
import { revalidatePath } from "next/cache";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";

export interface ImportResult {
    ok: boolean;
    tracksParsed: number;
    tracksInserted: number;
    playlistsParsed: number;
    errors: string[];
}

const MAX_BYTES = 25 * 1024 * 1024; // 25 MB — generous for very large libraries

/**
 * Import a rekordbox.xml uploaded by the user.
 *
 * The actual file body is sent as `xml` (a string) inside the FormData. We
 * write it to a temp file because `parseRekordboxXml` already takes a
 * filesystem path; that keeps the parser portable across companion + web
 * use without duplicating the fast-xml-parser plumbing.
 *
 * Inserted tracks are tagged with `sourcePlatform = "rekordbox"` and
 * `sourceId = <rekordboxId>` so re-imports are deduped by `(userId, sourcePlatform, sourceId)`.
 * Existing rows are left alone (we never overwrite — the companion is
 * the authority on track metadata once a file is locally scanned).
 */
export async function importRekordboxXmlAction(formData: FormData): Promise<ImportResult> {
    const session = await auth();
    if (!session?.user?.id) {
        return { ok: false, tracksParsed: 0, tracksInserted: 0, playlistsParsed: 0, errors: ["Unauthorized"] };
    }
    const userId = session.user.id;

    const file = formData.get("xml");
    if (!(file instanceof File)) {
        return { ok: false, tracksParsed: 0, tracksInserted: 0, playlistsParsed: 0, errors: ["Missing 'xml' file in form data"] };
    }
    if (file.size > MAX_BYTES) {
        return { ok: false, tracksParsed: 0, tracksInserted: 0, playlistsParsed: 0, errors: [`File too large (${file.size} bytes; max ${MAX_BYTES})`] };
    }

    // Spool to a temp file under the OS temp dir, randomised name.
    const tmpPath = path.join(os.tmpdir(), `mmo-rb-${crypto.randomUUID()}.xml`);
    try {
        const buf = Buffer.from(await file.arrayBuffer());
        await fs.writeFile(tmpPath, buf);

        const parsed = parseRekordboxXml(tmpPath);
        const errors = [...parsed.errors];

        let inserted = 0;
        for (const t of parsed.tracks) {
            try {
                // ON CONFLICT DO NOTHING by relying on the partial unique index
                // (userId, sha256) — but rekordbox doesn't carry sha256. We
                // dedupe by (userId, sourcePlatform, sourceId) at the application
                // layer with a quick existence check.
                const existing = await db.query.tracks.findFirst({
                    where: (rows, { and: a, eq }) =>
                        a(eq(rows.userId, userId), eq(rows.sourcePlatform, "rekordbox"), eq(rows.sourceId, String(t.rekordboxId))),
                    columns: { id: true },
                });
                if (existing) continue;

                await db.insert(tracks).values({
                    userId,
                    title: t.title ?? null,
                    artist: t.artist ?? null,
                    album: t.album ?? null,
                    remix: t.remix ?? null,
                    label: t.label ?? null,
                    bpm: t.bpm ?? null,
                    keyCamelot: t.keyCamelot ?? null,
                    keyMusical: t.keyMusical ?? null,
                    durationMs: t.duration != null ? Math.round(t.duration * 1000) : null,
                    energy: t.energy != null ? Number(t.energy) : null,
                    genre: t.genre ?? null,
                    color: t.color ?? null,
                    format: t.format ?? null,
                    bitrate: t.bitrate ?? null,
                    sampleRate: t.sampleRate ?? null,
                    fileSize: t.fileSize ?? null,
                    sourcePlatform: "rekordbox",
                    sourceId: String(t.rekordboxId),
                });
                inserted++;
            } catch (e) {
                errors.push(`Track ${t.rekordboxId}: ${e instanceof Error ? e.message : String(e)}`);
            }
        }

        revalidatePath("/library");
        return {
            ok: parsed.errors.length === 0,
            tracksParsed: parsed.tracks.length,
            tracksInserted: inserted,
            playlistsParsed: parsed.playlists.length,
            errors,
        };
    } finally {
        // Best-effort cleanup; ignore errors (file may already be gone).
        await fs.unlink(tmpPath).catch(() => { /* swallow */ });
    }
}
