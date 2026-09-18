/**
 * Pure mapping for `POST /api/media/sync` (MMO Server → web). The server
 * pushes `ProgressEntry[]` + `TrackPlay[]` (server/openapi.yaml); this
 * module validates the body, resolves the server-side string `profileId`
 * to a `watch_profiles.id`, and turns entries into `watch_history` /
 * `track_plays` upserts. No I/O — the route owns the DB.
 */

import { z } from "zod";

export const progressEntrySchema = z.object({
    profileId: z.string().min(1).max(64),
    kind: z.enum(["movie", "tv"]),
    tmdbId: z.number().int().positive(),
    season: z.number().int().min(0).default(0),
    episode: z.number().int().min(0).default(0),
    positionSec: z.number().min(0),
    durationSec: z.number().min(0),
    completed: z.boolean(),
    /** Epoch ms on the server. */
    updatedAt: z.number().int().positive(),
    rev: z.number().int().optional(),
});

export const trackPlayEntrySchema = z.object({
    id: z.number().int().optional(),
    profileId: z.string().min(1).max(64),
    /** Companion track id (numeric) or a `sha256:<hex>` content key. */
    trackKey: z.string().min(1).max(512),
    playedAt: z.number().int().positive(),
    durationSec: z.number().min(0).default(0),
    completed: z.boolean().default(false),
    rev: z.number().int().optional(),
});

export const syncBodySchema = z.object({
    deviceId: z.string().min(1).max(128),
    revision: z.number().int().min(0),
    since: z.number().int().min(0).optional(),
    full: z.boolean().optional(),
    progress: z.array(progressEntrySchema).max(5000).default([]),
    plays: z.array(trackPlayEntrySchema).max(5000).default([]),
});

export type ProgressEntry = z.infer<typeof progressEntrySchema>;
export type TrackPlayEntry = z.infer<typeof trackPlayEntrySchema>;
export type SyncBody = z.infer<typeof syncBodySchema>;

/**
 * Server profile ids are free strings; the web keys history by
 * `watch_profiles.id`. Numeric strings that belong to the user map 1:1;
 * `"default"` (or anything unknown) → the user's default profile.
 */
export function resolveProfileId(serverProfileId: string, owned: ReadonlyArray<number>, fallback: number | null): number | null {
    const n = Number(serverProfileId);
    if (Number.isInteger(n) && n > 0 && owned.includes(n)) return n;
    return fallback;
}

/** Parse the server `trackKey` into something we can look up in `tracks`. */
export function parseTrackKey(key: string): { companionTrackId: number } | { sha256: string } | null {
    const m = /^sha256:([0-9a-f]{64})$/i.exec(key);
    if (m) return { sha256: m[1]!.toLowerCase() };
    const n = Number(key);
    if (Number.isInteger(n) && n > 0) return { companionTrackId: n };
    return null;
}

/** 0..1 progress, guarded against a zero duration. */
export function fraction(positionSec: number, durationSec: number): number {
    if (!(durationSec > 0)) return 0;
    return Math.max(0, Math.min(1, positionSec / durationSec));
}

/** Last-writer-wins: apply the incoming entry only when it is newer than what we hold. */
export function shouldApply(incomingUpdatedAtMs: number, existingWatchedAt: Date | null | undefined): boolean {
    if (!existingWatchedAt) return true;
    return incomingUpdatedAtMs > existingWatchedAt.getTime();
}

/** Keep the newest entry per (profile, kind, tmdbId, season, episode) so one upsert per key. */
export function dedupeProgress(entries: ProgressEntry[]): ProgressEntry[] {
    const map = new Map<string, ProgressEntry>();
    for (const e of entries) {
        const k = `${e.profileId}|${e.kind}|${e.tmdbId}|${e.season}|${e.episode}`;
        const prev = map.get(k);
        if (!prev || e.updatedAt > prev.updatedAt) map.set(k, e);
    }
    return [...map.values()];
}

/** Drop exact repeats of (profile, trackKey, playedAt) inside one push. */
export function dedupePlays(plays: TrackPlayEntry[]): TrackPlayEntry[] {
    const seen = new Set<string>();
    return plays.filter((p) => {
        const k = `${p.profileId}|${p.trackKey}|${p.playedAt}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
    });
}

export interface WebProgressRow {
    kind: "movie" | "episode";
    tmdbId: number | null;
    season: number | null;
    episode: number | null;
    positionSec: number;
    durationSec: number | null;
    completed: boolean;
    watchedAt: Date | null;
    profileId: number;
}

/** Reverse direction (`GET /api/media/sync?since=`): web rows → server `ProgressEntry` shape. */
export function toServerProgress(rows: WebProgressRow[]): ProgressEntry[] {
    const out: ProgressEntry[] = [];
    for (const r of rows) {
        if (!r.tmdbId) continue;
        out.push({
            profileId: String(r.profileId),
            kind: r.kind === "movie" ? "movie" : "tv",
            tmdbId: r.tmdbId,
            season: r.season ?? 0,
            episode: r.episode ?? 0,
            positionSec: r.positionSec,
            durationSec: r.durationSec ?? 0,
            completed: r.completed,
            updatedAt: r.watchedAt?.getTime() ?? 0,
        });
    }
    return out;
}
