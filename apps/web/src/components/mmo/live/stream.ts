/**
 * Attach a live / catch-up / recording stream to a <video> (WP16-41). Port of tv-tizen `livetv/stream.ts`.
 * hls.js (MSE) first; Safari without MSE (iOS) → native HLS. `/livetv/stream/:id?proxy=1` rewrites HLS
 * playlists to signed `/livetv/proxy/...` URLs, so no CORS/headers are needed (auth rides on `?t=`).
 * A manifest parse error means raw MPEG-TS (HDHomeRun): native `<video src>` is tried, and when the browser
 * cannot decode it either, `onFatal("unsupported")` lets the UI explain.
 *
 *   const h = await attachStream(video, url, { preload: true, onFatal });   h.promote(); h.destroy();
 */
import type Hls from "hls.js";

export interface StreamHandle {
    readonly url: string;
    readonly mode: "hls.js" | "native";
    /** Preload → normal buffer targets (call when the element becomes the visible one). */
    promote(): void;
    destroy(): void;
}

export interface AttachOpts {
    /** Small buffer (hidden zap slot / hover preview). */
    preload?: boolean;
    /** VOD (recording / catch-up): larger buffer, no live sync. */
    vod?: boolean;
    /** "unsupported" when neither hls.js nor the element can play the format; else a short reason. */
    onFatal?: (reason: string) => void;
}

type HlsCtor = typeof Hls;
let ctorPromise: Promise<HlsCtor> | null = null;

/** Lazy hls.js (one chunk, shared by every live surface). */
export function loadHls(): Promise<HlsCtor> {
    if (!ctorPromise) ctorPromise = import("hls.js").then((m) => m.default);
    return ctorPromise;
}

function canNativeHls(video: HTMLVideoElement): boolean {
    return video.canPlayType("application/vnd.apple.mpegurl") !== "";
}

function nativeAttach(video: HTMLVideoElement, url: string, onFatal?: (m: string) => void): StreamHandle {
    const onErr = () => {
        const code = video.error?.code;
        onFatal?.(code === 4 ? "unsupported" : `media ${code ?? "?"}`);
    };
    video.addEventListener("error", onErr);
    video.src = url;
    video.load();
    return {
        url,
        mode: "native",
        promote: () => undefined,
        destroy: () => {
            video.removeEventListener("error", onErr);
            video.removeAttribute("src");
            video.load();
        },
    };
}

export async function attachStream(video: HTMLVideoElement, url: string, opts: AttachOpts = {}): Promise<StreamHandle> {
    const HlsC = await loadHls().catch(() => null);
    if (!HlsC || !HlsC.isSupported()) {
        if (canNativeHls(video) || !HlsC) return nativeAttach(video, url, opts.onFatal);
        opts.onFatal?.("unsupported");
        return { url, mode: "native", promote: () => undefined, destroy: () => undefined };
    }
    const hls = new HlsC({
        lowLatencyMode: false,
        startFragPrefetch: true,
        liveSyncDurationCount: 3,
        maxBufferLength: opts.preload ? 4 : opts.vod ? 60 : 20,
        maxMaxBufferLength: opts.vod ? 120 : 40,
        backBufferLength: opts.vod ? 30 : 10,
        manifestLoadingMaxRetry: 2,
        levelLoadingMaxRetry: 3,
        fragLoadingMaxRetry: 4,
        capLevelToPlayerSize: true,
    });
    let destroyed = false;
    let fallback: StreamHandle | null = null;
    let recovered = false;
    hls.on(HlsC.Events.ERROR, (_e, data) => {
        if (!data.fatal || destroyed) return;
        if (data.details === HlsC.ErrorDetails.MANIFEST_PARSING_ERROR) {
            // Not a playlist (MPEG-TS pipe) → let the element try the bytes directly.
            hls.destroy();
            fallback = nativeAttach(video, url, opts.onFatal);
            return;
        }
        if (data.type === HlsC.ErrorTypes.MEDIA_ERROR && !recovered) { recovered = true; hls.recoverMediaError(); return; }
        opts.onFatal?.(String(data.details));
    });
    hls.attachMedia(video);
    hls.loadSource(url);
    return {
        url,
        get mode() { return fallback ? "native" as const : "hls.js" as const; },
        promote: () => {
            if (fallback || destroyed) return;
            hls.config.maxBufferLength = 20;
        },
        destroy: () => {
            destroyed = true;
            if (fallback) { fallback.destroy(); return; }
            hls.destroy();
            video.removeAttribute("src");
            video.load();
        },
    };
}
