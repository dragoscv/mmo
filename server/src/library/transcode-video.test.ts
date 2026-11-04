import { describe, expect, it, vi } from "vitest";
import { pickTranscodeMode, audioTranscodeArgs, audioOf, sessionKeyFor, SESSION_KEY_RE } from "./transcode-video";

vi.mock("../store", () => ({ getSettings: () => ({ allowVideoTranscode: false }) }));
vi.mock("./pre-remux", () => ({ sidecarIfExists: () => null }));

const TV = ["h264", "hevc", "aac", "ac3", "eac3", "mp3"];

describe("pickTranscodeMode", () => {
    it("audio track selection: key suffix, regex round-trip, per-track codec", () => {
        expect(sessionKeyFor("f1", "original", "remux")).toBe("f1:original:remux");
        expect(sessionKeyFor("f1", "original", "audio-transcode", 2)).toBe("f1:original:audio-transcode:a2");
        expect(SESSION_KEY_RE.exec("f1:original:audio-transcode:a2")?.[3]).toBe("2");
        expect(SESSION_KEY_RE.exec("f1:original:remux")?.[3]).toBeUndefined();
        expect(SESSION_KEY_RE.test("f1:original:remux:x")).toBe(false);
        const c = { video: "hevc", audio: "truehd", audioChannels: 8, audioStreams: [{ codec: "truehd", channels: 8 }, { codec: "aac", channels: 2 }] };
        expect(audioOf(c, 1)).toEqual({ audio: "aac", audioChannels: 2 });
        expect(audioOf(c, 5)).toEqual({ audio: "truehd", audioChannels: 8 });
        // TrueHD default track needs conversion; the AAC commentary track can be copied.
        expect(pickTranscodeMode("original", "hevc", audioOf(c, 0).audio, TV, false)).toBe("audio-transcode");
        expect(pickTranscodeMode("original", "hevc", audioOf(c, 1).audio, TV, false)).toBe("remux");
    });

    it("remuxes HEVC + E-AC3 for a TV that decodes both", () => {
        expect(pickTranscodeMode("original", "hevc", "eac3", TV)).toBe("remux");
    });

    it("converts only the audio when the TV cannot decode DTS/TrueHD", () => {
        expect(pickTranscodeMode("original", "hevc", "dts", TV)).toBe("audio-transcode");
        expect(pickTranscodeMode("original", "hevc", "truehd", TV)).toBe("audio-transcode");
    });

    it("never re-encodes video while allowVideoTranscode is off, even for 720p requests", () => {
        expect(pickTranscodeMode("720p", "hevc", "eac3", TV)).toBe("remux");
        expect(pickTranscodeMode("original", "hevc", "eac3", ["h264", "aac"])).toBe("audio-transcode");
        expect(pickTranscodeMode("original", "mpeg2video", "ac3", TV)).toBe("remux");
    });

    it("re-encodes video only when the owner allows it", () => {
        expect(pickTranscodeMode("720p", "hevc", "eac3", TV, true)).toBe("full-transcode");
        expect(pickTranscodeMode("original", "hevc", "aac", ["h264", "aac"], true)).toBe("full-transcode");
    });

    it("copies the video but converts non-AAC audio when the client reports no caps", () => {
        expect(pickTranscodeMode("original", "hevc", "aac", [])).toBe("remux");
        expect(pickTranscodeMode("original", "hevc", "eac3", [])).toBe("audio-transcode");
        expect(pickTranscodeMode("original", "hevc", "dts", [])).toBe("audio-transcode");
    });
});

describe("audioTranscodeArgs", () => {
    it("prefers E-AC3 5.1 at 640k for TVs", () => {
        expect(audioTranscodeArgs(TV, 8)).toEqual(["-c:a", "eac3", "-ac", "6", "-ar", "48000", "-b:a", "640k"]);
    });

    it("keeps stereo sources stereo", () => {
        expect(audioTranscodeArgs(TV, 2)).toEqual(["-c:a", "eac3", "-ac", "2", "-ar", "48000", "-b:a", "256k"]);
    });

    it("falls back to AC3, then AAC stereo", () => {
        expect(audioTranscodeArgs(["hevc", "ac3"], 6)[1]).toBe("ac3");
        expect(audioTranscodeArgs(["h264", "aac"], 6)).toContain("aac");
        expect(audioTranscodeArgs([], 6)).toContain("aac");
    });
});
