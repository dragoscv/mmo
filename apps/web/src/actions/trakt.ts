"use server";

import { auth } from "@/auth";
import { db } from "@/db";
import { userPreferences } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { traktScrobble } from "@/lib/trakt";

const TRAKT_KEY = "trakt.tokens";

export interface TraktTokens {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    scope?: string;
    syncedAt?: number;
}

async function readTokens(userId: string): Promise<TraktTokens | null> {
    const row = await db.select().from(userPreferences).where(
        and(eq(userPreferences.userId, userId), eq(userPreferences.key, TRAKT_KEY)),
    ).limit(1).then(r => r[0]);
    if (!row) return null;
    try { return JSON.parse(row.value) as TraktTokens; } catch { return null; }
}

async function writeTokens(userId: string, t: TraktTokens) {
    const value = JSON.stringify(t);
    const existing = await db.select().from(userPreferences).where(
        and(eq(userPreferences.userId, userId), eq(userPreferences.key, TRAKT_KEY)),
    ).limit(1).then(r => r[0]);
    if (existing) {
        await db.update(userPreferences).set({ value, updatedAt: new Date() }).where(eq(userPreferences.id, existing.id));
    } else {
        await db.insert(userPreferences).values({ userId, key: TRAKT_KEY, value });
    }
}

/** Build the OAuth authorize URL for Trakt. The user is redirected here,
 *  approves the app, and is returned to /api/trakt/callback?code=... */
export async function getTraktAuthUrl(returnTo = "/watch/settings"): Promise<{ url?: string; error?: string }> {
    const clientId = process.env.TRAKT_CLIENT_ID;
    const base = process.env.NEXT_PUBLIC_APP_URL || process.env.AUTH_URL || "";
    if (!clientId || !base) return { error: "Trakt not configured (missing TRAKT_CLIENT_ID or NEXT_PUBLIC_APP_URL)" };
    const redirect = encodeURIComponent(`${base.replace(/\/$/, "")}/api/trakt/callback`);
    const state = encodeURIComponent(returnTo);
    const url = `https://trakt.tv/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${redirect}&state=${state}`;
    return { url };
}

export async function disconnectTrakt() {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) return { error: "unauthorized" } as const;
    await db.delete(userPreferences).where(
        and(eq(userPreferences.userId, userId), eq(userPreferences.key, TRAKT_KEY)),
    );
    return { ok: true } as const;
}

export async function getTraktStatus(): Promise<{ connected: boolean; expiresAt?: number; syncedAt?: number }> {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) return { connected: false };
    const t = await readTokens(userId);
    if (!t) return { connected: false };
    return { connected: true, expiresAt: t.expiresAt, syncedAt: t.syncedAt };
}

/** Internal — refresh access token if expired. Returns valid token or null. */
async function ensureFreshToken(userId: string): Promise<string | null> {
    const t = await readTokens(userId);
    if (!t) return null;
    if (Date.now() < t.expiresAt - 60_000) return t.accessToken;
    const clientId = process.env.TRAKT_CLIENT_ID;
    const clientSecret = process.env.TRAKT_CLIENT_SECRET;
    const base = process.env.NEXT_PUBLIC_APP_URL || process.env.AUTH_URL || "";
    if (!clientId || !clientSecret) return t.accessToken;
    try {
        const resp = await fetch("https://api.trakt.tv/oauth/token", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                refresh_token: t.refreshToken,
                client_id: clientId,
                client_secret: clientSecret,
                redirect_uri: `${base.replace(/\/$/, "")}/api/trakt/callback`,
                grant_type: "refresh_token",
            }),
            signal: AbortSignal.timeout(6000),
        });
        if (!resp.ok) return null;
        const j = await resp.json() as { access_token: string; refresh_token: string; expires_in: number; scope?: string };
        const fresh: TraktTokens = {
            accessToken: j.access_token,
            refreshToken: j.refresh_token,
            expiresAt: Date.now() + j.expires_in * 1000,
            scope: j.scope,
            syncedAt: t.syncedAt,
        };
        await writeTokens(userId, fresh);
        return fresh.accessToken;
    } catch {
        return null;
    }
}

/** Persist tokens received via OAuth callback. Called from the route handler. */
export async function saveTraktTokens(userId: string, t: { accessToken: string; refreshToken: string; expiresIn: number; scope?: string }) {
    await writeTokens(userId, {
        accessToken: t.accessToken,
        refreshToken: t.refreshToken,
        expiresAt: Date.now() + t.expiresIn * 1000,
        scope: t.scope,
    });
}

/**
 * Scrobble to Trakt for the current user. Safe to call even when not configured —
 * returns silently. Wrapped around `traktScrobble` so callers don't need
 * to fetch tokens themselves.
 */
export async function scrobbleToTrakt(input: {
    action: "start" | "pause" | "stop";
    progress: number;
    movie?: { tmdbId: number; title: string; year?: number };
    episode?: { showTmdbId: number; season: number; episode: number };
}) {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) return { ok: false, reason: "unauthorized" };
    const accessToken = await ensureFreshToken(userId);
    if (!accessToken) return { ok: false, reason: "no token" };
    const res = await traktScrobble({ ...input, accessToken });
    if (res.ok) {
        // Update syncedAt timestamp
        const existing = await db.select().from(userPreferences).where(
            and(eq(userPreferences.userId, userId), eq(userPreferences.key, TRAKT_KEY)),
        ).limit(1).then(r => r[0]);
        if (existing) {
            try {
                const parsed = JSON.parse(existing.value) as TraktTokens;
                parsed.syncedAt = Date.now();
                await db.update(userPreferences).set({ value: JSON.stringify(parsed) }).where(eq(userPreferences.id, existing.id));
            } catch { /* ignore */ }
        }
    }
    return res;
}
