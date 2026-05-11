/**
 * /v1/sync HTTP endpoint exposed by the companion.
 *
 * Direction: web → companion. Lets the cloud (or any authenticated
 * client) push remote changes INTO the companion's local SQLite. Mirrors
 * the cloud `POST /api/sync` shape so a single `SyncChange[]` envelope
 * works in either direction.
 *
 * Auth: the existing companion `authMiddleware` (device token). The
 * companion is single-tenant per signed-in user, so we don't validate
 * `X-User-Id` here — we trust whichever userId the cloud's SyncChange
 * payload carries because the companion itself is already locked to one
 * user via its persistent store.
 *
 * Conflict policy: for now we just enqueue every change into
 * `sync_queue` and let the existing CloudSyncClient pull-loop fold it
 * back to the cloud. A future refinement will short-circuit the loop and
 * apply remote changes directly to the local tables (per-field LWW for
 * tracks, row-level LWW for playlists, etc.) — that requires the
 * companion's `tracks` schema to grow a `sha256` column first, which is
 * tracked separately.
 */

import express from "express";
import type { SyncChange } from "./cloud-sync-client";
import { enqueueSyncChange } from "./index";

interface SyncRequestBody {
    changes?: unknown;
}

const VALID_ENTITIES = new Set([
    "tracks",
    "playlists",
    "playlist_tracks",
    "tags",
    "track_tags",
    "cuepoints",
]);

const VALID_OPS = new Set(["upsert", "delete"]);

function validateChange(c: unknown): { ok: true; value: SyncChange } | { ok: false; error: string } {
    if (!c || typeof c !== "object") return { ok: false, error: "change must be an object" };
    const r = c as Record<string, unknown>;
    if (typeof r.entity !== "string" || !VALID_ENTITIES.has(r.entity)) {
        return { ok: false, error: `entity must be one of ${[...VALID_ENTITIES].join(", ")}` };
    }
    if (typeof r.entityId !== "string" || r.entityId.length === 0) {
        return { ok: false, error: "entityId must be a non-empty string" };
    }
    if (r.entityId.length > 256) {
        return { ok: false, error: "entityId too long (max 256 chars)" };
    }
    if (typeof r.op !== "string" || !VALID_OPS.has(r.op)) {
        return { ok: false, error: "op must be 'upsert' or 'delete'" };
    }
    if (typeof r.updatedAt !== "string") {
        return { ok: false, error: "updatedAt must be an ISO-8601 string" };
    }
    return { ok: true, value: r as unknown as SyncChange };
}

export function createSyncRouter(authMiddleware: express.RequestHandler): express.Router {
    const router = express.Router();
    router.use(authMiddleware);

    router.post("/", (req, res) => {
        const body = (req.body ?? {}) as SyncRequestBody;
        if (!Array.isArray(body.changes)) {
            res.status(400).json({ error: "Body must be { changes: SyncChange[] }" });
            return;
        }
        if (body.changes.length > 5000) {
            res.status(413).json({ error: "too many changes per request (max 5000)" });
            return;
        }

        let applied = 0;
        const errors: Array<{ index: number; error: string }> = [];
        for (let i = 0; i < body.changes.length; i++) {
            const v = validateChange(body.changes[i]);
            if (!v.ok) {
                errors.push({ index: i, error: v.error });
                continue;
            }
            try {
                enqueueSyncChange(v.value);
                applied++;
            } catch (e) {
                errors.push({ index: i, error: e instanceof Error ? e.message : String(e) });
            }
        }

        res.json({ ok: errors.length === 0, applied, errors });
    });

    return router;
}
