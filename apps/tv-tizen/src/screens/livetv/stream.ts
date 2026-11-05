/**
 * Live stream attach (WP16-34). `/livetv/stream/:id?proxy=1&t=` — the server rewrites HLS playlists to signed
 * `/livetv/proxy/...` URLs, so hls.js works from file://. hls.js (MSE) is preferred; on a manifest parse error
 * (raw MPEG-TS from HDHomeRun) or without MSE we fall back to the native `<video src>`.
 *   const h = await attachLive(video, url, { preload: true, onFatal });   h.promote(); h.destroy();
 */
import type Hls from "hls.js";

export interface LiveHandle {
    readonly url: string;
    readonly mode: "hls.js" | "native";
    /** Preload → live buffer targets (call when the element becomes the visible one). */
    promote(): void;
    destroy(): void;
}

export interface AttachOpts {
    /** Small buffer, no autoplay (hidden zap slot / list preview warm-up). */
    preload?: boolean;
    onFatal?: (message: string) => void;
}

type HlsCtor = typeof Hls;
let ctorPromise: Promise<HlsCtor> | null = null;

/** Lazy hls.js (one chunk, shared by every live surface). */
export function loadHls(): Promise<HlsCtor> {
    if (!ctorPromise) ctorPromise = import("hls.js").then((m) => m.default);
    return ctorPromise;
}

function preferNative(): boolean {
    try { return localStorage.getItem("mixai-tv:live-native") === "1"; } catch { return false; }
}

function nativeAttach(video: HTMLVideoElement, url: string, onFatal?: (m: string) => void): LiveHandle {
    const onErr = () => onFatal?.(`media ${video.error?.code ?? "?"}`);
    video.addEventListener("error", onErr);
    video.src = url;
    video.load();
    return {
        url, mode: "native",
        promote: () => undefined,
        destroy: () => {
            video.removeEventListener("error", onErr);
            video.removeAttribute("src");
            video.load();
        },
    };
}

export async function attachLive(video: HTMLVideoElement, url: string, opts: AttachOpts = {}): Promise<LiveHandle> {
    const HlsC = preferNative() ? null : await loadHls().catch(() => null);
    if (!HlsC || !HlsC.isSupported()) return nativeAttach(video, url, opts.onFatal);
    const hls = new HlsC({
        enableWorker: false, // Tizen workers + blob URLs are flaky on older firmware
        lowLatencyMode: false,
        startFragPrefetch: true,
        liveSyncDurationCount: 3,
        maxBufferLength: opts.preload ? 4 : 20,
        maxMaxBufferLength: 40,
        backBufferLength: 10,
        manifestLoadingMaxRetry: 2,
        levelLoadingMaxRetry: 3,
        fragLoadingMaxRetry: 4,
        capLevelToPlayerSize: true,
    });
    let destroyed = false;
    let fallback: LiveHandle | null = null;
    let recovered = false;
    hls.on(HlsC.Events.ERROR, (_e, data) => {
        if (!data.fatal || destroyed) return;
        if (data.details === HlsC.ErrorDetails.MANIFEST_PARSING_ERROR) {
            // Not a playlist (MPEG-TS pipe) → native element plays the proxied bytes directly.
            hls.destroy();
            fallback = nativeAttach(video, url, opts.onFatal);
            return;
        }
        if (data.type === HlsC.ErrorTypes.MEDIA_ERROR && !recovered) { recovered = true; hls.recoverMediaError(); return; }
        opts.onFatal?.(`HLS: ${data.details}`);
    });
    hls.attachMedia(video);
    hls.loadSource(url);
    return {
        url,
        get mode() { return fallback ? "native" : "hls.js"; },
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
    } as LiveHandle;
}
