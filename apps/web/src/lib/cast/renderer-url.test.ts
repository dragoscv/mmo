import { describe, it, expect } from "vitest";
import { pickVideoSource, castCanDirectPlay, buildTrackRendererUrl, mimeForPath, containerMime } from "./renderer-url-pure";

describe("castCanDirectPlay", () => {
    it("accepts H.264/AAC MP4", () => {
        expect(castCanDirectPlay({ container: "mov,mp4,m4a,3gp,3g2,mj2", videoCodec: "h264", audioCodec: "aac" })).toBe(true);
    });
    it("rejects MKV even with H.264", () => {
        expect(castCanDirectPlay({ container: "matroska,webm", videoCodec: "h264", audioCodec: "ac3" })).toBe(false);
    });
    it("rejects AC3 audio in MP4", () => {
        expect(castCanDirectPlay({ container: "mp4", videoCodec: "h264", audioCodec: "ac3" })).toBe(false);
    });
});

describe("pickVideoSource", () => {
    it("DLNA always gets the progressive file, with the container mime", () => {
        const r = pickVideoSource({ container: "matroska,webm", videoCodec: "hevc", audioCodec: "ac3" }, "dlna");
        expect(r).toEqual({ hls: false, mime: "video/x-matroska" });
    });
    it("Cast gets direct MP4 when compatible", () => {
        const r = pickVideoSource({ container: "mp4", videoCodec: "h264", audioCodec: "aac" }, "google-cast");
        expect(r).toEqual({ hls: false, mime: "video/mp4" });
    });
    it("Cast falls back to HLS for MKV", () => {
        const r = pickVideoSource({ container: "matroska,webm", videoCodec: "h264", audioCodec: "ac3" }, "home-assistant");
        expect(r).toEqual({ hls: true, mime: "application/x-mpegURL" });
    });
});

describe("buildTrackRendererUrl", () => {
    it("uses the LAN base, encodes the path once and carries ?t&u", () => {
        const url = buildTrackRendererUrl("http://192.168.100.20:17899/", "D:\\Music\\A & B\\song #1.flac", "tok", "user");
        const u = new URL(url);
        expect(u.origin).toBe("http://192.168.100.20:17899");
        expect(u.pathname).toBe("/audio/" + encodeURIComponent("D:\\Music\\A & B\\song #1.flac"));
        expect(u.searchParams.get("t")).toBe("tok");
        expect(u.searchParams.get("u")).toBe("user");
        expect(decodeURIComponent(u.pathname.slice("/audio/".length))).toBe("D:\\Music\\A & B\\song #1.flac");
    });
});

describe("mime helpers", () => {
    it("maps audio extensions", () => {
        expect(mimeForPath("/x/a.FLAC")).toBe("audio/flac");
        expect(mimeForPath("/x/a.mp3")).toBe("audio/mpeg");
        expect(mimeForPath("/x/a.unknown")).toBe("audio/mpeg");
    });
    it("maps containers", () => {
        expect(containerMime("webm")).toBe("video/webm");
        expect(containerMime("mov,mp4,m4a")).toBe("video/mp4");
    });
});
