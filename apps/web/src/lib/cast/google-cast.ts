/**
 * Google Cast Web Sender — thin wrapper over the CAF sender SDK.
 *
 * Loads `cast_sender.js?loadCastFramework=1` once (Chrome/Chromium only),
 * initialises `CastContext` against the Default Media Receiver and exposes
 * a tiny imperative API + a state subscription. Everything `any`-typed
 * from the SDK is confined to this file (the repo's ESLint config does not
 * enable `no-explicit-any`, so no disable directive is needed).
 *
 * Media handed to the receiver must be reachable by the Chromecast:
 * the companion's LAN URL with `?t=&u=` (see lib/cast/renderer-url.ts).
 * Subtitles must be WebVTT served with CORS (companion sets it).
 */

declare global {
    interface Window {
        __onGCastApiAvailable?: (ok: boolean) => void;
        cast?: any;
        chrome?: any;
    }
}

export type CastState = "unavailable" | "no-devices" | "not-connected" | "connecting" | "connected";

export interface CastTrack { src: string; lang: string; label: string }

export interface CastLoadRequest {
    url: string;
    mime: string;
    title: string;
    subtitle?: string;
    poster?: string | null;
    tracks?: CastTrack[];
    /** Index into `tracks` to activate on load. */
    activeTrack?: number;
    startSec?: number;
    /** "BUFFERED" for progressive MP4, "LIVE" never; HLS also BUFFERED. */
    streamType?: "BUFFERED" | "LIVE";
}

const SDK_URL = "https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1";

let loadPromise: Promise<boolean> | null = null;
let state: CastState = "unavailable";
const listeners = new Set<(s: CastState) => void>();

function emit(next: CastState) {
    if (next === state) return;
    state = next;
    for (const l of listeners) l(state);
}

function mapCastState(sdkState: string): CastState {
    switch (sdkState) {
        case "NO_DEVICES_AVAILABLE": return "no-devices";
        case "NOT_CONNECTED": return "not-connected";
        case "CONNECTING": return "connecting";
        case "CONNECTED": return "connected";
        default: return "unavailable";
    }
}

/** Load the SDK and init the CastContext. Resolves `true` when the Cast
 *  API is usable in this browser. Safe to call many times. */
export function ensureCastSdk(): Promise<boolean> {
    if (loadPromise) return loadPromise;
    if (typeof window === "undefined") return Promise.resolve(false);
    loadPromise = new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => resolve(false), 8_000);
        window.__onGCastApiAvailable = (ok: boolean) => {
            clearTimeout(timeout);
            if (!ok || !window.cast?.framework) { resolve(false); return; }
            try {
                const ctx = window.cast.framework.CastContext.getInstance();
                ctx.setOptions({
                    receiverApplicationId: window.chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
                    autoJoinPolicy: window.chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
                });
                emit(mapCastState(ctx.getCastState()));
                ctx.addEventListener(
                    window.cast.framework.CastContextEventType.CAST_STATE_CHANGED,
                    (ev: any) => emit(mapCastState(ev.castState)),
                );
                resolve(true);
            } catch {
                resolve(false);
            }
        };
        // Chrome exposes the Cast extension API only in Chromium browsers;
        // elsewhere the script loads but calls back with ok=false.
        if (document.querySelector(`script[src^="${SDK_URL.split("?")[0]}"]`)) return;
        const s = document.createElement("script");
        s.src = SDK_URL;
        s.async = true;
        s.onerror = () => { clearTimeout(timeout); resolve(false); };
        document.head.appendChild(s);
    });
    return loadPromise;
}

export function isCastAvailable(): boolean {
    return state !== "unavailable";
}

export function getCastState(): CastState { return state; }

export function subscribeCastState(cb: (s: CastState) => void): () => void {
    listeners.add(cb);
    cb(state);
    return () => { listeners.delete(cb); };
}

function context(): any {
    const ctx = window.cast?.framework?.CastContext?.getInstance();
    if (!ctx) throw new Error("Cast SDK not loaded");
    return ctx;
}

/** Open the Chrome device picker (or reuse the current session). */
export async function requestSession(): Promise<void> {
    const ctx = context();
    if (ctx.getCurrentSession()) return;
    const err = await ctx.requestSession();
    if (err) throw new Error(`Cast session failed: ${String(err)}`);
}

export function currentDeviceName(): string | null {
    try { return context().getCurrentSession()?.getCastDevice()?.friendlyName ?? null; } catch { return null; }
}

export async function loadMedia(req: CastLoadRequest): Promise<void> {
    const ctx = context();
    const session = ctx.getCurrentSession();
    if (!session) throw new Error("No Cast session");
    const cm = window.chrome.cast.media;
    const info = new cm.MediaInfo(req.url, req.mime);
    info.streamType = req.streamType === "LIVE" ? cm.StreamType.LIVE : cm.StreamType.BUFFERED;
    const isAudio = req.mime.startsWith("audio/");
    const meta = isAudio ? new cm.MusicTrackMediaMetadata() : new cm.MovieMediaMetadata();
    meta.title = req.title;
    if (req.subtitle) {
        if (isAudio) meta.artist = req.subtitle; else meta.subtitle = req.subtitle;
    }
    if (req.poster) meta.images = [new window.chrome.cast.Image(req.poster)];
    info.metadata = meta;
    if (req.tracks?.length) {
        info.tracks = req.tracks.map((t, i) => {
            const track = new cm.Track(i + 1, cm.TrackType.TEXT);
            track.trackContentId = t.src;
            track.trackContentType = "text/vtt";
            track.subtype = cm.TextTrackType.SUBTITLES;
            track.name = t.label;
            track.language = t.lang;
            return track;
        });
        const style = new cm.TextTrackStyle();
        style.backgroundColor = "#00000080";
        style.edgeType = cm.TextTrackEdgeType.OUTLINE;
        style.edgeColor = "#000000FF";
        info.textTrackStyle = style;
    }
    const load = new cm.LoadRequest(info);
    load.autoplay = true;
    if (req.startSec && req.startSec > 0) load.currentTime = req.startSec;
    if (req.tracks?.length && req.activeTrack != null && req.activeTrack >= 0) {
        load.activeTrackIds = [req.activeTrack + 1];
    }
    const err = await session.loadMedia(load);
    if (err) throw new Error(`Cast load failed: ${String(err)}`);
}

export function pause(): void { context().getCurrentSession()?.getMediaSession()?.pause(new window.chrome.cast.media.PauseRequest(), () => undefined, () => undefined); }
export function play(): void { context().getCurrentSession()?.getMediaSession()?.play(new window.chrome.cast.media.PlayRequest(), () => undefined, () => undefined); }

/** End the session and stop playback on the receiver. */
export function stop(): void {
    try { context().endCurrentSession(true); } catch { /* no session */ }
}
