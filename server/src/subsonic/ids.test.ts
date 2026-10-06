import { describe, it, expect } from "vitest";
import { albumId, artistId, decodeId, playlistId, trackId } from "./ids";

describe("subsonic ids", () => {
    it("round-trips numeric ids", () => {
        expect(trackId(42)).toBe("tr_42");
        expect(decodeId("tr_42")).toEqual({ kind: "track", num: 42 });
        expect(playlistId(7)).toBe("pl_7");
        expect(decodeId("pl_7")).toEqual({ kind: "playlist", num: 7 });
    });

    it("album/artist ids are stable, case-insensitive hashes", () => {
        const a = albumId("Discovery", "Daft Punk");
        expect(a).toMatch(/^al_[0-9a-f]{16}$/);
        expect(albumId("discovery ", "DAFT PUNK")).toBe(a);
        expect(albumId("Discovery", "Other")).not.toBe(a);
        expect(artistId("Daft Punk")).toBe(artistId(" daft punk"));
        expect(decodeId(a)).toEqual({ kind: "album", hash: a.slice(3) });
        expect(decodeId(artistId("x"))!.kind).toBe("artist");
    });

    it("rejects malformed ids", () => {
        expect(decodeId("tr_")).toBeNull();
        expect(decodeId("tr_abc")).toBeNull();
        expect(decodeId("tr_0")).toBeNull();
        expect(decodeId("al_short")).toBeNull();
        expect(decodeId("xx_1")).toBeNull();
        expect(decodeId(undefined)).toBeNull();
        expect(decodeId("42")).toBeNull();
    });
});
