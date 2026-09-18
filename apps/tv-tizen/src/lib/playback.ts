import type { ProbedVideo } from "./api";

/** Codecs the Tizen TV decoder can take via MSE/HLS remux. Tizen ≥ 5 decodes
 *  HEVC in mp4/ts; AC3/E-AC3 passthrough works on most Samsung panels. */
export const TIZEN_CAPS = ["h264", "hevc", "aac", "ac3", "eac3", "mp3"];

/** Progressive mp4 is the cheapest path — no ffmpeg, no MSE cap. Tizen's
 *  native `<video>` plays h264/hevc in mp4 with aac/ac3. Everything else
 *  (mkv/ts/dts/truehd) goes through the server's HLS remux. */
export function canDirectPlayOnTizen(v: ProbedVideo): boolean {
    const c = (v.container ?? "").toLowerCase();
    const vc = (v.videoCodec ?? "").toLowerCase();
    const ac = (v.audioCodec ?? "").toLowerCase();
    const mp4 = c.includes("mp4") || c.includes("mov");
    const video = ["h264", "avc1", "hevc", "h265", "hvc1"].includes(vc);
    const audio = ["aac", "mp4a", "ac3", "eac3", "mp3"].includes(ac);
    return mp4 && video && audio;
}

export function isHlsNative(video: HTMLMediaElement): boolean {
    return !!video.canPlayType("application/vnd.apple.mpegurl");
}
