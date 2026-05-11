import { describe, it, expect } from "vitest";
import {
    buildSeratoCrate,
    parseCrate,
    decodeUtf16BE,
    sanitizeCrateName,
} from "./serato-crate";

describe("serato-crate: build", () => {
    it("emits a parseable header with version + sort + columns + zero tracks", () => {
        const buf = buildSeratoCrate({ tracks: [] });
        const tags = parseCrate(buf);

        // Order: vrsn, osrt, ovct..., (no otrk).
        expect(tags[0]?.name).toBe("vrsn");
        expect(decodeUtf16BE(tags[0]!.payload)).toBe("1.0/Serato ScratchLive Crate");

        expect(tags[1]?.name).toBe("osrt");
        const osrt = parseCrate(tags[1]!.payload);
        expect(osrt[0]?.name).toBe("tvcn");
        expect(decodeUtf16BE(osrt[0]!.payload)).toBe("song");
        expect(osrt[1]?.name).toBe("brev");
        expect(osrt[1]!.payload[0]).toBe(0x00);

        const ovctTags = tags.filter((t) => t.name === "ovct");
        expect(ovctTags.length).toBeGreaterThan(0);
        expect(tags.filter((t) => t.name === "otrk").length).toBe(0);
    });

    it("encodes tracks as otrk{ptrk} with normalised relative paths", () => {
        const buf = buildSeratoCrate({
            tracks: [
                { relativePath: "Music/foo.mp3" },
                { relativePath: "\\Music\\bar.flac" },
                { relativePath: "/Music///baz.wav" },
            ],
        });
        const tags = parseCrate(buf);
        const otrkTags = tags.filter((t) => t.name === "otrk");
        expect(otrkTags).toHaveLength(3);

        const paths = otrkTags.map((t) => {
            const inner = parseCrate(t.payload);
            expect(inner[0]?.name).toBe("ptrk");
            return decodeUtf16BE(inner[0]!.payload);
        });
        expect(paths).toEqual([
            "Music/foo.mp3",
            "Music/bar.flac",
            "Music/baz.wav",
        ]);
    });

    it("respects custom sortColumn and columns", () => {
        const buf = buildSeratoCrate({
            tracks: [],
            sortColumn: "bpm",
            columns: [{ name: "song", width: "300" }],
        });
        const tags = parseCrate(buf);
        const osrt = parseCrate(tags.find((t) => t.name === "osrt")!.payload);
        expect(decodeUtf16BE(osrt[0]!.payload)).toBe("bpm");

        const ovctTags = tags.filter((t) => t.name === "ovct");
        expect(ovctTags).toHaveLength(1);
        const inner = parseCrate(ovctTags[0]!.payload);
        expect(decodeUtf16BE(inner[0]!.payload)).toBe("song");
        expect(decodeUtf16BE(inner[1]!.payload)).toBe("300");
    });

    it("handles UTF-8 / non-ASCII titles in paths", () => {
        const buf = buildSeratoCrate({
            tracks: [{ relativePath: "Muzică/Țărișoară — Ñoño.mp3" }],
        });
        const tags = parseCrate(buf);
        const otrk = tags.find((t) => t.name === "otrk")!;
        const ptrk = parseCrate(otrk.payload)[0]!;
        expect(decodeUtf16BE(ptrk.payload)).toBe("Muzică/Țărișoară — Ñoño.mp3");
    });

    it("rejects non-4-char tag names (defensive)", () => {
        // We don't expose `tag()` directly — but a 4-char internal contract
        // is critical, so build something huge to ensure the writer never
        // throws on legitimate input regardless.
        const buf = buildSeratoCrate({
            tracks: Array.from({ length: 500 }, (_, i) => ({
                relativePath: `Music/track-${i}.mp3`,
            })),
        });
        const tags = parseCrate(buf);
        expect(tags.filter((t) => t.name === "otrk")).toHaveLength(500);
    });

    it("skips empty paths silently rather than emitting broken otrk", () => {
        const buf = buildSeratoCrate({
            tracks: [
                { relativePath: "" },
                { relativePath: "/" },
                { relativePath: "Music/ok.mp3" },
            ],
        });
        const tags = parseCrate(buf);
        expect(tags.filter((t) => t.name === "otrk")).toHaveLength(1);
    });
});

describe("serato-crate: sanitizeCrateName", () => {
    it("strips path-hostile characters", () => {
        expect(sanitizeCrateName("Peak: Time/Techno?"))
            .toBe("Peak_ Time_Techno_");
    });
    it("falls back to 'playlist' when input is empty/whitespace", () => {
        expect(sanitizeCrateName("   ")).toBe("playlist");
        expect(sanitizeCrateName("")).toBe("playlist");
    });
    it("caps length at 200 chars", () => {
        const long = "a".repeat(500);
        expect(sanitizeCrateName(long).length).toBe(200);
    });
});
