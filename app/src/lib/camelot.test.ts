import { describe, it, expect } from "vitest";
import { toCamelot, keyName } from "./camelot";

describe("toCamelot", () => {
    it("maps C major (0,1) to 8B", () => {
        expect(toCamelot(0, 1)).toBe("8B");
    });

    it("maps A minor (9,0) to 8A (relative of C major)", () => {
        expect(toCamelot(9, 0)).toBe("8A");
    });

    it("wraps negative key indices", () => {
        expect(toCamelot(-12, 1)).toBe("8B");
        expect(toCamelot(-1, 1)).toBe(toCamelot(11, 1));
    });

    it("wraps key indices >= 12", () => {
        expect(toCamelot(12, 1)).toBe("8B");
        expect(toCamelot(13, 0)).toBe(toCamelot(1, 0));
    });

    it("returns a Camelot label like /^\\d{1,2}[AB]$/ for every (key,scale) pair", () => {
        for (let k = 0; k < 12; k++) {
            for (const s of [0, 1]) {
                expect(toCamelot(k, s)).toMatch(/^\d{1,2}[AB]$/);
            }
        }
    });
});

describe("keyName", () => {
    it("formats C major", () => {
        expect(keyName(0, 1)).toBe("C Major");
    });
    it("formats A minor", () => {
        expect(keyName(9, 0)).toBe("A Minor");
    });
    it("uses sharp notation for black keys", () => {
        expect(keyName(1, 1)).toBe("C# Major");
        expect(keyName(6, 0)).toBe("F# Minor");
    });
});
