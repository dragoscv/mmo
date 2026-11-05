/**
 * Player network helpers that work for BOTH a paired browser (device token headers / `?t=`) and a Watch
 * Together guest (`?inv=`; server.ts maps a valid invite to the room's current file only — stream, direct,
 * subs, thumbs, intro, credits, recap, chapters, file info).
 */
import { authHeaders, guestPath, pauseStreamUrl, type FileInfo, type StreamAuth } from "./model";

const trim = (b: string) => b.replace(/\/+$/, "");
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

async function getJson(baseUrl: string, path: string, auth: StreamAuth, timeoutMs: number, signal?: AbortSignal): Promise<{ status: number; body: unknown }> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const onAbort = () => ctrl.abort();
    signal?.addEventListener("abort", onAbort);
    try {
        const res = await fetch(trim(baseUrl) + guestPath(path, auth), { headers: authHeaders(auth), signal: ctrl.signal, cache: "no-store" });
        const body: unknown = await res.json().catch(() => null);
        return { status: res.status, body };
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
    }
}

function asInfo(body: unknown, fileId: string): FileInfo | null {
    if (!body || typeof body !== "object") return null;
    const o = body as Record<string, unknown>;
    return {
        fileId,
        path: typeof o.path === "string" ? o.path : undefined,
        sizeBytes: num(o.sizeBytes) ?? undefined,
        container: typeof o.container === "string" ? o.container : null,
        videoCodec: typeof o.videoCodec === "string" ? o.videoCodec : null,
        audioCodec: typeof o.audioCodec === "string" ? o.audioCodec : null,
        width: num(o.width),
        height: num(o.height),
        durationSec: num(o.durationSec),
        hdr: typeof o.hdr === "string" ? o.hdr : null,
        audioTracks: Array.isArray(o.audioTracks) ? (o.audioTracks as FileInfo["audioTracks"]) : [],
        subtitleTracks: Array.isArray(o.subtitleTracks) ? (o.subtitleTracks as FileInfo["subtitleTracks"]) : [],
    };
}

/**
 * `GET /video/file/:id/info`. After a server restart the registry is empty (404): a paired browser re-registers
 * the file via `/video/lookup?path=` (guests cannot — they only get the room's file).
 */
export async function fetchFileInfo(baseUrl: string, auth: StreamAuth, fileId: string, path?: string | null, signal?: AbortSignal): Promise<FileInfo | null> {
    const r = await getJson(baseUrl, `/video/file/${encodeURIComponent(fileId)}/info`, auth, 15_000, signal);
    if (r.status >= 200 && r.status < 300) return asInfo(r.body, fileId);
    if (r.status === 404 && path && auth.kind === "token") {
        const l = await getJson(baseUrl, `/video/lookup?path=${encodeURIComponent(path)}`, auth, 30_000, signal);
        const id = l.body && typeof l.body === "object" ? (l.body as { fileId?: unknown }).fileId : undefined;
        if (typeof id === "string" && id) {
            const r2 = await getJson(baseUrl, `/video/file/${encodeURIComponent(id)}/info`, auth, 15_000, signal);
            if (r2.status >= 200 && r2.status < 300) return asInfo(r2.body, id);
        }
    }
    return null;
}

export interface Span { start: number; end: number }
export interface Markers { intro: Span | null; recap: Span | null; credits: number | null }
export const NO_MARKERS: Markers = { intro: null, recap: null, credits: null };

/** Marker routes run ffmpeg analyses in the server's idle queue: allow them time, never block playback. */
const MARKER_TIMEOUT_MS = 150_000;

async function marker(baseUrl: string, auth: StreamAuth, kind: string, fileId: string, signal: AbortSignal): Promise<Record<string, unknown> | null> {
    try {
        const r = await getJson(baseUrl, `/video/${kind}/${encodeURIComponent(fileId)}`, auth, MARKER_TIMEOUT_MS, signal);
        return r.status === 200 && r.body && typeof r.body === "object" ? (r.body as Record<string, unknown>) : null;
    } catch {
        return null;
    }
}

const span = (o: Record<string, unknown> | null): Span | null => {
    const s = num(o?.start), e = num(o?.end);
    return s !== null && e !== null && e > s ? { start: s, end: e } : null;
};

export async function fetchMarkers(baseUrl: string, auth: StreamAuth, fileId: string, signal: AbortSignal): Promise<Markers> {
    const [intro, recap, credits] = await Promise.all([
        marker(baseUrl, auth, "intro", fileId, signal),
        marker(baseUrl, auth, "recap", fileId, signal),
        marker(baseUrl, auth, "credits", fileId, signal),
    ]);
    const c = num(credits?.start);
    return { intro: span(intro), recap: span(recap), credits: c !== null && c > 0 ? c : null };
}

/** Best effort: tear down the server's ffmpeg session (pause / leave). */
export function pauseStream(baseUrl: string, fileId: string, auth: StreamAuth): void {
    fetch(pauseStreamUrl(baseUrl, fileId, auth), { method: "POST", keepalive: true }).catch(() => undefined);
}

/** Whether the guest/owner device prefers Safari's native HLS over hls.js (MSE). */
export function prefersNativeHls(el: HTMLMediaElement, ua: string, mseSupported: boolean): boolean {
    const native = !!el.canPlayType("application/vnd.apple.mpegurl");
    if (!native) return false;
    if (!mseSupported) return true;
    return /safari/i.test(ua) && !/chrome|crios|chromium|android|edg|fxios|firefox/i.test(ua);
}
