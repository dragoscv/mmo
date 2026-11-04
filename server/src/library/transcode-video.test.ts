import { describe, expect, it, vi } from "vitest";
import { pickTranscodeMode, audioTranscodeArgs } from "./transcode-video";

vi.mock("../store", () => ({ getSettings: () => ({ allowVideoTranscode: false }) }));
vi.mock("./pre-remux", () => ({ sidecarIfExists: () => null }));

const TV = ["h264", "hevc", "aac", "ac3", "eac3", "mp3"];

describe("pickTranscodeMode", () => {
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
