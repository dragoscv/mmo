/**
 * /mixai-profile/* HTTP API.
 *
 * Stores a single opaque JSON "profile" blob per user — the MIXAI app's
 * settings backup (themes, deck layout, MIDI mapping, companion config). This
 * is the server side of MIXAI's account sync: the desktop app PUTs its local
 * profile and GETs it back on another machine.
 *
 * Auth is identical to the rest of the companion's user-scoped routes:
 *   - `X-Device-Token` (device auth, checked by the shared authMiddleware)
 *   - `X-User-Id` (per-user scoping)
 *
 * The blob is stored verbatim (the companion never interprets it); the desktop
 * app owns the schema and validates on import. We cap the size so a malformed
 * or malicious client can't bloat the SQLite file.
 */

import express from "express";
import { getLibrarySqlite } from "../library/db";

/** Hard cap on a stored profile blob (256 KB is far above any real profile). */
const MAX_PROFILE_BYTES = 256 * 1024;

interface AuthedRequest extends express.Request {
    userId: string;
}

function requireUser(
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
) {
    const userId = (req.headers["x-user-id"] as string | undefined)?.trim();
    if (!userId) {
        res.status(400).json({ error: "Missing X-User-Id header" });
        return;
    }
    (req as AuthedRequest).userId = userId;
    next();
}

/** Lazily ensure the storage table exists (mirrors the companion's
 *  no-migrations, CREATE-IF-NOT-EXISTS convention). */
function ensureTable() {
    const db = getLibrarySqlite();
    db.exec(`
        CREATE TABLE IF NOT EXISTS mixai_profiles (
            user_id TEXT PRIMARY KEY,
            data TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
    `);
    return db;
}

export function createProfileRouter(authMiddleware: express.RequestHandler): express.Router {
    const router = express.Router();
    router.use(authMiddleware);
    router.use(requireUser);

    // ── Get the stored profile for this user ─────────────────────────────
    router.get("/", (req, res) => {
        const { userId } = req as AuthedRequest;
        const db = ensureTable();
        const row = db
            .prepare("SELECT data, updated_at FROM mixai_profiles WHERE user_id = ?")
            .get(userId) as { data: string; updated_at: string } | undefined;
        if (!row) {
            res.json({ profile: null, updatedAt: null });
            return;
        }
        let profile: unknown;
        try {
            profile = JSON.parse(row.data);
        } catch {
            // Corrupt row — report empty rather than 500 so the client can
            // simply overwrite it with a fresh push.
            res.json({ profile: null, updatedAt: null });
            return;
        }
        res.json({ profile, updatedAt: row.updated_at });
    });

    // ── Store / replace the profile for this user ────────────────────────
    router.put("/", (req, res) => {
        const { userId } = req as AuthedRequest;
        const profile = (req.body as { profile?: unknown })?.profile;
        if (profile === undefined || profile === null || typeof profile !== "object") {
            res.status(400).json({ error: "Body must be { profile: object }" });
            return;
        }
        const data = JSON.stringify(profile);
        if (Buffer.byteLength(data, "utf8") > MAX_PROFILE_BYTES) {
            res.status(413).json({ error: "Profile too large" });
            return;
        }
        const db = ensureTable();
        const updatedAt = new Date().toISOString();
        db.prepare(
            `INSERT INTO mixai_profiles (user_id, data, updated_at)
             VALUES (?, ?, ?)
             ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
        ).run(userId, data, updatedAt);
        res.json({ success: true, updatedAt });
    });

    return router;
}
