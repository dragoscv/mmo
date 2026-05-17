/**
 * Companion video client — server-side wrapper around `/video/*` routes.
 *
 * Uses the same device-token + user-id auth as `companion-library.ts`.
 * Returns null on any failure so server components render an empty
 * state gracefully (companion may be offline / unpaired).
 */

import "server-only";
import { getCompanionLink, getCompanionLinkForDevice, type CompanionLink } from "./companion-library";

async function videoCall<T>(
    link: CompanionLink,
    method: "GET" | "POST",
    path: string,
    body?: unknown,
): Promise<T | null> {
    try {
        const res = await fetch(`${link.apiUrl}/video${path}`, {
            method,
            headers: {
                "X-Device-Token": link.token,
                "X-User-Id": link.userId,
                ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
            },
            body: body !== undefined ? JSON.stringify(body) : undefined,
            cache: "no-store",
            signal: AbortSignal.timeout(60_000),
        });
        if (!res.ok) return null;
        return await res.json() as T;
    } catch {
        return null;
    }
}

export interface CompanionVideoFile {
    fileId: string;
    path: string;
    sizeBytes: number;
    container: string | null;
    videoCodec: string | null;
    audioCodec: string | null;
    width: number | null;
    height: number | null;
    durationSec: number | null;
    bitrateKbps: number | null;
    hdr: string | null;
    audioTracks: Array<{ index: number; codec: string; channels: number; lang: string | null; title: string | null }>;
    subtitleTracks: Array<{ index: number; codec: string; lang: string | null; title: string | null; forced: boolean }>;
    parsed: { title: string; year: number | null; season: number | null; episode: number | null };
}

export async function scanCompanionVideos(roots?: string[]): Promise<{ files: CompanionVideoFile[]; rootsScanned: number } | null> {
    const link = await getCompanionLink();
    if (!link) return null;
    return videoCall(link, "POST", "/scan", { roots });
}

export async function getCompanionVideoFlags(): Promise<{ vidsrcEnabled: boolean } | null> {
    const link = await getCompanionLink();
    if (!link) return null;
    return videoCall(link, "GET", "/flags");
}

/** Build a browser-facing URL that proxies a TMDB image through the
 *  companion's local cache. Returns null when there's no companion. */
export async function companionTmdbImageUrl(size: string, imagePath: string | null): Promise<string | null> {
    if (!imagePath) return null;
    const link = await getCompanionLink();
    if (!link) return null;
    return `${link.apiUrl}/video/tmdb-image/${size}${imagePath}?t=${link.token}&u=${link.userId}`;
}

/** Build the browser-facing direct-play URL for a video file. */
export function companionDirectUrl(apiUrl: string, fileId: string, token: string, userId: string): string {
    const u = new URL(`${apiUrl}/video/direct/${fileId}`);
    u.searchParams.set("t", token);
    u.searchParams.set("u", userId);
    return u.toString();
}

/** Build the HLS playlist URL. */
export function companionHlsUrl(apiUrl: string, fileId: string, quality: string, token: string, userId: string, startSec = 0): string {
    const u = new URL(`${apiUrl}/video/stream/${fileId}`);
    u.searchParams.set("q", quality);
    if (startSec > 0) u.searchParams.set("start", String(startSec));
    u.searchParams.set("t", token);
    u.searchParams.set("u", userId);
    return u.toString();
}

export async function getPlaybackHandle(): Promise<{ apiUrl: string; token: string; userId: string } | null> {
    const link = await getCompanionLink();
    if (!link) return null;
    return { apiUrl: link.apiUrl, token: link.token, userId: link.userId };
}
