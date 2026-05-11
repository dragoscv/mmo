import { describe, it, expect } from "vitest";
import path from "node:path";
import { validateCopyRequest, resolveTrackTarget } from "./usb-copy";

const ABS = process.platform === "win32" ? "E:\\USB" : "/mnt/usb";

describe("validateCopyRequest", () => {
    it("rejects missing destination", () => {
        const out = validateCopyRequest({ destination: undefined });
        expect(out.ok).toBe(false);
    });

    it("rejects empty destination", () => {
        const out = validateCopyRequest({ destination: "   " });
        expect(out.ok).toBe(false);
    });

    it("rejects relative destination", () => {
        const out = validateCopyRequest({ destination: "./music" });
        expect(out.ok).toBe(false);
    });

    it("accepts an absolute destination with default subdir", () => {
        const out = validateCopyRequest({ destination: ABS });
        expect(out.ok).toBe(true);
        if (out.ok) {
            expect(out.musicSubdir).toBe("Music");
            expect(out.targetDir).toBe(path.join(ABS, "Music"));
        }
    });

    it("accepts an empty subdir as default", () => {
        const out = validateCopyRequest({ destination: ABS, musicSubdir: "  " });
        expect(out.ok).toBe(true);
        if (out.ok) expect(out.musicSubdir).toBe("Music");
    });

    it("rejects non-string subdir", () => {
        const out = validateCopyRequest({ destination: ABS, musicSubdir: 42 });
        expect(out.ok).toBe(false);
    });

    it("rejects subdir that contains `..` segments", () => {
        const out = validateCopyRequest({ destination: ABS, musicSubdir: "a/../../b" });
        expect(out.ok).toBe(false);
    });

    it("rejects subdir that starts with `..`", () => {
        const out = validateCopyRequest({ destination: ABS, musicSubdir: "../escape" });
        expect(out.ok).toBe(false);
    });

    it("rejects absolute musicSubdir", () => {
        const abs = process.platform === "win32" ? "C:\\evil" : "/etc";
        const out = validateCopyRequest({ destination: ABS, musicSubdir: abs });
        expect(out.ok).toBe(false);
    });

    it("rejects absurdly long subdir", () => {
        const out = validateCopyRequest({
            destination: ABS,
            musicSubdir: "x".repeat(500),
        });
        expect(out.ok).toBe(false);
    });

    it("accepts nested subdir like Music/Sub", () => {
        const out = validateCopyRequest({ destination: ABS, musicSubdir: "Music/2025" });
        expect(out.ok).toBe(true);
        if (out.ok) expect(out.targetDir).toBe(path.join(ABS, "Music", "2025"));
    });
});

describe("resolveTrackTarget", () => {
    it("uses basename only — ignores leading directories in source", () => {
        const out = resolveTrackTarget(
            path.join(ABS, "Music"),
            path.join("foo", "bar", "song.mp3"),
        );
        expect(out).toBe(path.join(ABS, "Music", "song.mp3"));
    });

    it("ignores absolute source paths and only takes the basename", () => {
        const src = process.platform === "win32"
            ? "C:\\Users\\dj\\song.flac"
            : "/home/dj/song.flac";
        const out = resolveTrackTarget(path.join(ABS, "Music"), src);
        expect(path.basename(out)).toBe("song.flac");
        expect(out.startsWith(path.join(ABS, "Music"))).toBe(true);
    });

    it("throws on `.` or `..` filenames", () => {
        expect(() => resolveTrackTarget(ABS, "..")).toThrow();
        expect(() => resolveTrackTarget(ABS, ".")).toThrow();
    });

    it("preserves the original filename verbatim", () => {
        const out = resolveTrackTarget(ABS, "Pătrănjelul - Bun măi (mix).mp3");
        expect(path.basename(out)).toBe("Pătrănjelul - Bun măi (mix).mp3");
    });
});
