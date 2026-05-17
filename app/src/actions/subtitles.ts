"use server";

import { auth } from "@/auth";
import { db } from "@/db";
import { devices } from "@/db/schema";
import { eq } from "drizzle-orm";

const COMPANION_BASE = process.env.COMPANION_BASE_URL || "http://127.0.0.1:17899";

/**
 * Resolve the user's active companion device. We use the most recently
 * seen one. Returns null if the user has no paired companion.
 *
 * Note: the plaintext token never lives on the server (only encrypted
 * at rest) — so server actions can't proxy authenticated companion
 * requests. We expose `subtitleSearchUrl()` so the client (which has
 * the plaintext token in localStorage) can call the companion directly.
 */
async function activeDevice(userId: string): Promise<{ id: string } | null> {
    const rows = await db.select().from(devices)
        .where(eq(devices.userId, userId))
        .orderBy(devices.lastSeenAt).limit(5);
    const row = rows[0] ?? null;
    if (!row) return null;
    return { id: row.id };
}

/**
 * Generic subtitle search wrapper. Intended to be called from the
 * client (which has the plaintext token). For server-action use,
 * returns an empty list when no plaintext device token is available.
 */
export interface SubtitleSearchInput {
    title?: string;
    year?: number;
    tmdbId?: number;
    imdbId?: string;
    kind?: "movie" | "tv";
    season?: number;
    episode?: number;
    lang?: string;
}

export interface SubtitleResult {
    provider: "opensubtitles" | "addic7ed";
    id: string;
    language: string;
    title: string;
    release?: string;
    downloads?: number;
    downloadToken: string;
}

/**
 * Build the URL the client should call (companion lives on localhost
 * and the client has the device token). Returns a URL the client can
 * GET directly — server actions don't proxy because the plaintext
 * token only lives on the device.
 */
export async function subtitleSearchUrl(input: SubtitleSearchInput): Promise<{ url: string } | null> {
    const session = await auth();
    if (!session?.user?.id) return null;
    const dev = await activeDevice(session.user.id);
    if (!dev) return null;
    const params = new URLSearchParams();
    if (input.title) params.set("title", input.title);
    if (input.year) params.set("year", String(input.year));
    if (input.tmdbId) params.set("tmdb", String(input.tmdbId));
    if (input.imdbId) params.set("imdb", input.imdbId);
    if (input.kind) params.set("kind", input.kind);
    if (input.season != null) params.set("season", String(input.season));
    if (input.episode != null) params.set("episode", String(input.episode));
    if (input.lang) params.set("lang", input.lang);
    return { url: `${COMPANION_BASE}/video/subs/search?${params}` };
}
