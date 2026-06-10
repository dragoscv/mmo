/**
 * Browser media capability probe.
 *
 * Runs `MediaSource.isTypeSupported` + `<video>.canPlayType` for the
 * codecs the companion's transcoder needs to decide between Direct
 * Play, Remux, Audio-Transcode, and Full-Transcode. Result is cached
 * per-page-load (capabilities don't change at runtime) and serialised
 * as a comma list the companion appends to its mode-decision logic.
 *
 * Notable: on Edge for Windows, EAC3 (`ec-3`) and AC3 (`ac-3`) are
 * supported when the Microsoft HEVC/AC3 codec extensions are installed
 * (free for OEM Windows). HEVC (`hvc1`) requires hardware decode +
 * extension. Chrome on the same machine returns `false` for ec-3 and
 * usually for hvc1 outside Edge.
 */

const CODEC_TESTS = {
    h264: { kind: "video", mime: 'video/mp4; codecs="avc1.42E01E"' },
    hevc: { kind: "video", mime: 'video/mp4; codecs="hvc1.1.6.L120.B0"' },
    vp9: { kind: "video", mime: 'video/mp4; codecs="vp09.00.10.08"' },
    av1: { kind: "video", mime: 'video/mp4; codecs="av01.0.05M.08"' },
    aac: { kind: "audio", mime: 'audio/mp4; codecs="mp4a.40.2"' },
    ac3: { kind: "audio", mime: 'audio/mp4; codecs="ac-3"' },
    eac3: { kind: "audio", mime: 'audio/mp4; codecs="ec-3"' },
    opus: { kind: "audio", mime: 'audio/mp4; codecs="opus"' },
    mp3: { kind: "audio", mime: 'audio/mp4; codecs="mp4a.40.34"' },
} as const;

let cached: string | null = null;

export function getMediaCapabilities(): string {
    if (cached != null) return cached;
    if (typeof window === "undefined" || typeof document === "undefined") return "";
    const v = document.createElement("video");
    const a = document.createElement("audio");
    const supported: string[] = [];
    const mse = typeof MediaSource !== "undefined" ? MediaSource : null;
    for (const [name, test] of Object.entries(CODEC_TESTS)) {
        const el = test.kind === "video" ? v : a;
        const direct = el.canPlayType(test.mime);
        const mseOk = mse?.isTypeSupported(test.mime) ?? false;
        if (direct === "probably" || mseOk) supported.push(name);
    }
    cached = supported.join(",");
    return cached;
}

/** Append `&caps=...` to a companion stream URL. Safe to call with any URL. */
export function withCaps(url: string): string {
    const caps = getMediaCapabilities();
    if (!caps) return url;
    return `${url}${url.includes("?") ? "&" : "?"}caps=${caps}`;
}
