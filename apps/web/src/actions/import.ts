"use server";

/**
 * Import a rekordbox XML file. Tracks are parsed locally (the web app
 * has access to the XML on disk) and bulk-pushed to the companion's
 * /library/tracks/ingest endpoint.
 *
 * Playlist creation is intentionally NOT done here in v1 — it would
 * require resolving rekordbox track-ids to companion-issued ids, which
 * needs a follow-up endpoint. Tracks alone is the most-requested case.
 */

import fs from "node:fs";
import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { findRekordboxXml, parseRekordboxXml } from "@/lib/rekordbox-import";
import { companionLibrary, getCompanionLink } from "@/lib/companion-library";

/**
 * Reject obviously hostile or oversized paths before they reach
 * `fs.*` / `parseRekordboxXml`. We can't safely whitelist roots here
 * (the rekordbox XML location is user-configurable across OSes), but
 * we can stop the cheap classes of abuse: NUL/control bytes (used to
 * truncate paths or smuggle through layered checks), unbounded length
 * (multi-MB strings reaching kernel), and empty input.
 */
function isSafeFsPath(p: unknown): p is string {
    return typeof p === "string"
        && p.length > 0
        && p.length <= 4096
        && !/[\x00-\x1F]/.test(p);
}

export async function importRekordboxAction(xmlPath?: string) {
    // Auth required: action reads (and parses) an arbitrary caller-supplied
    // path from the web-server FS. Without this, any unauthenticated POST
    // to the action endpoint could coerce the server into reading any file
    // it has FS access to and shipping the parsed payload to a companion
    // (or surfacing parse errors that leak file contents).
    const session = await auth();
    if (!session?.user?.id) {
        return {
            success: false,
            error: "Not authenticated",
            imported: 0, updated: 0, playlistsCreated: 0,
        };
    }
    const link = await getCompanionLink();
    if (!link) {
        return {
            success: false,
            error: "Companion not connected. Sign in and link a companion to import.",
            imported: 0, updated: 0, playlistsCreated: 0,
        };
    }

    if (xmlPath !== undefined && !isSafeFsPath(xmlPath)) {
        return {
            success: false,
            error: "Invalid xmlPath",
            imported: 0, updated: 0, playlistsCreated: 0,
        };
    }
    const resolvedPath = xmlPath || findRekordboxXml();
    if (!resolvedPath) {
        return {
            success: false,
            error: "Rekordbox XML not found. Specify the path in Settings or export from rekordbox (File → Export Collection in xml format).",
            imported: 0, updated: 0, playlistsCreated: 0,
        };
    }
    if (!fs.existsSync(resolvedPath)) {
        return {
            success: false,
            error: `File not found: ${resolvedPath}`,
            imported: 0, updated: 0, playlistsCreated: 0,
        };
    }

    try {
        const parsed = parseRekordboxXml(resolvedPath);
        // ImportedTrack has rekordboxId/playCount/dateAdded — strip them
        // before sending to the companion (it doesn't store these).
        const tracksToIngest = parsed.tracks.map((t) => {
            const { rekordboxId: _r, playCount: _p, dateAdded: _d, ...rest } = t;
            void _r; void _p; void _d;
            return rest;
        });
        const r = await companionLibrary.ingestTracks(link, tracksToIngest);

        revalidatePath("/");
        revalidatePath("/library");
        revalidatePath("/playlists");

        return {
            success: true,
            imported: r.inserted,
            updated: 0, // companion ingest is insert-only (idempotent via UNIQUE)
            playlistsCreated: 0,
            totalTracks: r.total,
            totalPlaylists: parsed.playlists.length,
            errors: parsed.errors.slice(0, 10),
        };
    } catch (e) {
        return {
            success: false,
            error: `Import failed: ${e instanceof Error ? e.message : String(e)}`,
            imported: 0, updated: 0, playlistsCreated: 0,
        };
    }
}

export async function findRekordboxXmlPath() {
    const session = await auth();
    if (!session?.user?.id) return null;
    return findRekordboxXml();
}

export async function checkFileExists(filePath: string) {
    // Auth required: previously an unauthenticated FS-existence oracle on
    // the host — useful for fingerprinting installed software, layouts,
    // and reachable config files.
    const session = await auth();
    if (!session?.user?.id) return false;
    if (!isSafeFsPath(filePath)) return false;
    return fs.existsSync(filePath);
}

export async function getFileSize(filePath: string) {
    // Same: previously unauthenticated FS metadata read.
    const session = await auth();
    if (!session?.user?.id) return 0;
    if (!isSafeFsPath(filePath)) return 0;
    try { return fs.statSync(filePath).size; }
    catch { return 0; }
}
