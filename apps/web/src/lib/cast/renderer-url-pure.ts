/**
 * Pure helpers for renderer URL / codec decisions — no DB, no `server-only`,
 * so they can be unit-tested. Consumed by `renderer-url.ts`.
 */

export type RendererKind = "google-cast" | "dlna" | "home-assistant";

export interface CodecInfo {
    container: string | null | undefined;
    videoCodec: string | null | undefined;
    audioCodec: string | null | undefined;
}

export interface VideoSourceChoice {
    /** true → use the companion HLS playlist, false → progressive `/video/direct`. */
    hls: boolean;
    mime: string;
}

/** Google Cast Default Media Receiver: H.264/VP8/VP9 (+HEVC on newer devices)
 *  in MP4/WebM, AAC/MP3/Opus/Vorbis audio. MKV is NOT supported. */
export function castCanDirectPlay(c: CodecInfo): boolean {
    const cont = (c.container ?? "").toLowerCase();
    const v = (c.videoCodec ?? "").toLowerCase();
    const a = (c.audioCodec ?? "").toLowerCase();
    const okContainer = cont.includes("mp4") || cont.includes("m4v") || cont.includes("mov") || cont.includes("webm");
    const okVideo = ["h264", "avc", "avc1", "vp8", "vp9", "hevc", "h265"].includes(v);
    const okAudio = a === "" || ["aac", "mp4a", "mp3", "opus", "vorbis"].includes(a);
    return okContainer && okVideo && okAudio;
}

/** Generic DLNA renderer (Samsung Tizen, LG, Kodi): progressive only — most
 *  TVs play MKV/H.264/AC3 fine, so we always hand over the direct file and
 *  never HLS (few DMRs implement HLS). */
export function pickVideoSource(c: CodecInfo, kind: RendererKind): VideoSourceChoice {
    const cont = (c.container ?? "").toLowerCase();
    if (kind === "dlna") {
        return { hls: false, mime: containerMime(cont) };
    }
    // Cast (direct or via HA): direct MP4 when compatible, else HLS remux
    // from the companion (fmp4 segments, H.264/AAC).
    if (castCanDirectPlay(c)) return { hls: false, mime: containerMime(cont) };
    return { hls: true, mime: "application/x-mpegURL" };
}

export function containerMime(container: string): string {
    const c = container.toLowerCase();
    // ffprobe reports MKV as "matroska,webm" — matroska must win over webm.
    if (c.includes("matroska") || c.includes("mkv")) return "video/x-matroska";
    if (c.includes("webm")) return "video/webm";
    if (c.includes("avi")) return "video/x-msvideo";
    if (c.includes("mpegts") || c === "ts") return "video/mp2t";
    return "video/mp4";
}

const AUDIO_MIME: Record<string, string> = {
    ".mp3": "audio/mpeg",
    ".flac": "audio/flac",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".ogg": "audio/ogg",
    ".opus": "audio/ogg",
    ".aif": "audio/aiff",
    ".aiff": "audio/aiff",
    ".wma": "audio/x-ms-wma",
};

export function mimeForPath(p: string): string {
    const m = /\.[a-z0-9]+$/i.exec(p);
    return (m && AUDIO_MIME[m[0].toLowerCase()]) || "audio/mpeg";
}

/** `${lanBase}/audio/${encodeURIComponent(path)}?t=&u=` — the companion's
 *  `/audio/*` catch-all accepts query auth for renderers. */
export function buildTrackRendererUrl(lanBase: string, filepath: string, token: string, userId: string): string {
    const u = new URL(`${lanBase.replace(/\/+$/, "")}/audio/${encodeURIComponent(filepath)}`);
    u.searchParams.set("t", token);
    u.searchParams.set("u", userId);
    return u.toString();
}
