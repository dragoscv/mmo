import { describe, expect, it } from "vitest";
import { DEFAULT_PREFS, MEDIA_PROVIDERS, MEDIA_REGIONS, mergeWatchPrefs } from "./watch-prefs";

describe("mergeWatchPrefs — WP11-06 fields", () => {
    it("defaults preferredProviders/curator/showListen for legacy blobs", () => {
        const out = mergeWatchPrefs({ regions: ["RO"], defaultRegion: "RO" });
        expect(out.preferredProviders).toEqual([]);
        expect(out.curator).toBe(false);
        expect(out.showListen).toBe(true);
    });

    it("keeps valid values and drops junk in preferredProviders", () => {
        const out = mergeWatchPrefs({ preferredProviders: [8, "9", -1, 1.5, 337], curator: true, showListen: false });
        expect(out.preferredProviders).toEqual([8, 337]);
        expect(out.curator).toBe(true);
        expect(out.showListen).toBe(false);
    });

    it("exposes the RO registry and region list used by Settings › Media", () => {
        expect(MEDIA_REGIONS[0]).toBe("RO");
        expect(DEFAULT_PREFS.defaultRegion).toBe("RO");
        expect(MEDIA_PROVIDERS.map((p) => p.id)).toEqual([8, 9, 337, 1899, 350, 1773, 192, 1002, 1932]);
    });
});
