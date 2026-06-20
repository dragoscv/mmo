import { describe, it, expect } from "vitest";
import { sourcesSummary } from "./track-availability";

describe("sourcesSummary", () => {
    it("returns null when no devices", () => {
        expect(sourcesSummary([], 0)).toBeNull();
        expect(sourcesSummary(null, 0)).toBeNull();
        expect(sourcesSummary(undefined, 2)).toBeNull();
    });

    it("returns the single device name for one source", () => {
        expect(sourcesSummary(["Studio PC"], 1)).toBe("Studio PC");
    });

    it("summarizes multiple devices", () => {
        expect(sourcesSummary(["Studio PC", "Laptop"], 2)).toBe("On 2 devices: Studio PC, Laptop");
    });

    it("caps the listed names and shows a +more suffix", () => {
        const names = ["A", "B", "C", "D", "E", "F"];
        expect(sourcesSummary(names, 6)).toBe("On 6 devices: A, B, C, D, +2 more");
    });

    it("ignores empty name strings", () => {
        expect(sourcesSummary(["", "Laptop"], 1)).toBe("Laptop");
    });
});
