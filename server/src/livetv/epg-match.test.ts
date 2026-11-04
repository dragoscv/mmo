import { describe, it, expect } from "vitest";
import { matchChannels, normaliseChannelName } from "./epg-match";

describe("normaliseChannelName", () => {
    it("strips quality, country, brackets, punctuation and diacritics", () => {
        expect(normaliseChannelName("Pro TV HD")).toBe("pro");
        expect(normaliseChannelName("RO: PRO TV FHD")).toBe("pro");
        expect(normaliseChannelName("Antena 3 [RO] (backup)")).toBe("antena3");
        expect(normaliseChannelName("Știri.TV")).toBe("stiri");
        expect(normaliseChannelName("Digi Sport 1 RO 1080p")).toBe("digisport1");
        expect(normaliseChannelName("TV HD")).not.toBe("");
    });
});

describe("matchChannels", () => {
    const channels = [
        { id: "a", tvgId: "ProTV.ro", name: "Pro TV HD" },
        { id: "b", tvgId: null, name: "RO | Antena 3" },
        { id: "c", tvgId: "unknown-id", name: "Digi 24 FHD" },
        { id: "d", tvgId: "protv.ro", name: "Pro TV backup" },
    ];
    it("prefers tvg-id (case-insensitive), then display names, then the xmltv id", () => {
        const m = matchChannels(channels, [
            { id: "ProTV.ro", displayNames: ["Something else"] },
            { id: "a3", displayNames: ["Antena 3 HD"] },
            { id: "Digi24.ro", displayNames: [] },
            { id: "nothing", displayNames: ["No Such Channel"] },
        ]);
        expect(m.get("ProTV.ro")).toEqual(["a", "d"]);
        expect(m.get("a3")).toEqual(["b"]);
        expect(m.get("Digi24.ro")).toEqual(["c"]);
        expect(m.get("nothing")).toEqual([]);
    });
});
