"use server";

import { auth } from "@/auth";
import { db } from "@/db";
import { userPreferences, movies, tvShows } from "@/db/schema";
import { and, eq, inArray } from "drizzle-orm";

const WATCHLIST_KEY = "watchlist";

interface WatchlistItem {
    kind: "movie" | "show";
    id: number;
    addedAt: number;
}

async function readList(userId: string): Promise<WatchlistItem[]> {
    const row = await db.select().from(userPreferences).where(
        and(eq(userPreferences.userId, userId), eq(userPreferences.key, WATCHLIST_KEY)),
    ).limit(1).then(r => r[0]);
    if (!row) return [];
    try { return JSON.parse(row.value) as WatchlistItem[]; } catch { return []; }
}

async function writeList(userId: string, list: WatchlistItem[]) {
    const value = JSON.stringify(list);
    const existing = await db.select().from(userPreferences).where(
        and(eq(userPreferences.userId, userId), eq(userPreferences.key, WATCHLIST_KEY)),
    ).limit(1).then(r => r[0]);
    if (existing) {
        await db.update(userPreferences).set({ value, updatedAt: new Date() }).where(eq(userPreferences.id, existing.id));
    } else {
        await db.insert(userPreferences).values({ userId, key: WATCHLIST_KEY, value });
    }
}

export async function addToWatchlist(kind: "movie" | "show", id: number) {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) return { error: "unauthorized" } as const;
    const list = await readList(userId);
    if (list.find(it => it.kind === kind && it.id === id)) return { ok: true, alreadyIn: true } as const;
    list.unshift({ kind, id, addedAt: Date.now() });
    await writeList(userId, list.slice(0, 200));
    return { ok: true } as const;
}

export async function removeFromWatchlist(kind: "movie" | "show", id: number) {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) return { error: "unauthorized" } as const;
    const list = await readList(userId);
    await writeList(userId, list.filter(it => !(it.kind === kind && it.id === id)));
    return { ok: true } as const;
}

export async function isInWatchlist(kind: "movie" | "show", id: number) {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) return false;
    const list = await readList(userId);
    return list.some(it => it.kind === kind && it.id === id);
}

export interface WatchlistEntry {
    kind: "movie" | "show";
    id: number;
    title: string;
    posterPath: string | null;
    addedAt: number;
    year: number | null;
}

export async function getWatchlist(): Promise<WatchlistEntry[]> {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) return [];
    const list = await readList(userId);
    if (list.length === 0) return [];

    const movieIds = list.filter(it => it.kind === "movie").map(it => it.id);
    const showIds = list.filter(it => it.kind === "show").map(it => it.id);

    const [mvs, shs] = await Promise.all([
        movieIds.length
            ? db.select({ id: movies.id, title: movies.title, posterPath: movies.posterPath, year: movies.year }).from(movies).where(and(eq(movies.userId, userId), inArray(movies.id, movieIds)))
            : Promise.resolve([] as Array<{ id: number; title: string; posterPath: string | null; year: number | null }>),
        showIds.length
            ? db.select({ id: tvShows.id, title: tvShows.title, posterPath: tvShows.posterPath, year: tvShows.firstAirYear }).from(tvShows).where(and(eq(tvShows.userId, userId), inArray(tvShows.id, showIds)))
            : Promise.resolve([] as Array<{ id: number; title: string; posterPath: string | null; year: number | null }>),
    ]);

    const mMap = new Map(mvs.map(m => [m.id, m]));
    const sMap = new Map(shs.map(s => [s.id, s]));
    const out: WatchlistEntry[] = [];
    for (const it of list) {
        const src = it.kind === "movie" ? mMap.get(it.id) : sMap.get(it.id);
        if (!src) continue;
        out.push({ kind: it.kind, id: it.id, title: src.title, posterPath: src.posterPath, addedAt: it.addedAt, year: src.year });
    }
    return out;
}
