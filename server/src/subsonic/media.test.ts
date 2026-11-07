import { describe, it, expect, vi } from "vitest";

// browse.ts (imported by media.ts for mimeOf) pulls ../store, which pins
// userData + reads config.json at import.
vi.mock("../store", () => ({
    store: { get: () => undefined },
    getSettings: () => ({ scanFolders: [] }),
}));
vi.mock("../sync", () => ({ enqueueSyncChange: vi.fn() }));

import { pickStreamFormat, transcodeArgs } from "./media";

describe("pickStreamFormat", () => {
    it("plays the file directly when format is absent or raw", () => {
        expect(pickStreamFormat(undefined, "flac")).toBe("raw");
        expect(pickStreamFormat(null, "flac")).toBe("raw");
        expect(pickStreamFormat("", "flac")).toBe("raw");
        expect(pickStreamFormat("raw", "mp3")).toBe("raw");
        expect(pickStreamFormat("RAW", "mp3")).toBe("raw");
    });

    it("transcodes to each supported format, case-insensitively", () => {
        expect(pickStreamFormat("mp3", "flac")).toBe("mp3");
        expect(pickStreamFormat("OPUS", "flac")).toBe("opus");
        expect(pickStreamFormat("Aac", "mp3")).toBe("aac");
        expect(pickStreamFormat(" flac ", "wav")).toBe("flac");
    });

    it("plays the file directly when the format equals the file suffix", () => {
        expect(pickStreamFormat("mp3", "mp3")).toBe("raw");
        expect(pickStreamFormat("FLAC", "flac")).toBe("raw");
        expect(pickStreamFormat("aac", "AAC")).toBe("raw");
    });

    it("ignores unknown formats", () => {
        expect(pickStreamFormat("wma", "flac")).toBe("raw");
        expect(pickStreamFormat("ogg", "flac")).toBe("raw");
    });
});

describe("transcodeArgs", () => {
    it("builds per-format codec args and seeks only when offset > 0", () => {
        const mp3 = transcodeArgs("/a.flac", 0, "mp3");
        expect(mp3).not.toContain("-ss");
        expect(mp3).toEqual(expect.arrayContaining(["libmp3lame", "256k", "mp3", "pipe:1"]));
        expect(transcodeArgs("/a.flac", 12.5, "opus")).toEqual(expect.arrayContaining(["-ss", "12.5", "libopus", "160k", "ogg"]));
        expect(transcodeArgs("/a.flac", 0, "aac")).toEqual(expect.arrayContaining(["aac", "256k", "adts"]));
        const flac = transcodeArgs("/a.wav", 0, "flac");
        expect(flac).toEqual(expect.arrayContaining(["-c:a", "flac", "-f", "flac"]));
        expect(flac).not.toContain("-b:a");
        expect(flac[flac.length - 1]).toBe("pipe:1");
    });
});
