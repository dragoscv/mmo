import { describe, expect, it } from "vitest";
import { bpmCloseness, harmonicOrder, keyScore, parseCamelot, toCamelot, transitionScore } from "./harmonic";

describe("harmonic", () => {
    it("scores Camelot moves like the DJ app", () => {
        const k = (s: string) => parseCamelot(s);
        expect(keyScore(k("8A"), k("8A"))).toBe(1);
        expect(keyScore(k("8A"), k("8B"))).toBe(0.92);
        expect(keyScore(k("8A"), k("9A"))).toBe(0.85);
        expect(keyScore(k("12A"), k("1A"))).toBe(0.85);
        expect(keyScore(k("8A"), k("9B"))).toBe(0.55);
        expect(keyScore(k("8A"), k("3A"))).toBe(0.6);
        expect(keyScore(k("8A"), k("10A"))).toBe(0.45);
        expect(keyScore(k("8A"), k("2B"))).toBe(0);
        expect(parseCamelot("13A")).toBeNull();
    });

    it("matches tempo within ±6 % including half/double", () => {
        expect(bpmCloseness(128, 128)).toBe(1);
        expect(bpmCloseness(128, 64)).toBe(1);
        expect(bpmCloseness(120, 123)).toBeCloseTo(1 - 0.025 / 0.06, 5);
        expect(bpmCloseness(120, 130)).toBe(0);
        expect(bpmCloseness(null, 120)).toBe(0);
    });

    it("weights key 70 % and falls back to BPM", () => {
        expect(transitionScore({ keyCamelot: "8A", bpm: 128 }, { keyCamelot: "8A", bpm: 128 })).toBe(1);
        expect(transitionScore({ keyCamelot: null, bpm: 128 }, { keyCamelot: "8A", bpm: 128 })).toBe(1);
        expect(transitionScore({}, {})).toBe(0);
    });

    it("orders greedily from the start item, unknowns last in original order", () => {
        const t = (id: string, keyCamelot: string | null, bpm: number | null) => ({ id, keyCamelot, bpm });
        const items = [t("a", "8A", 124), t("x", null, null), t("b", "3B", 90), t("c", "9A", 125), t("y", null, null), t("d", "8B", 124)];
        expect(harmonicOrder(items, 0).map((i) => i.id)).toEqual(["a", "d", "c", "b", "x", "y"]);
        expect(harmonicOrder(items, 99)[0]!.id).toBe("d");
        expect(harmonicOrder(items.slice(0, 2)).map((i) => i.id)).toEqual(["a", "x"]);
        expect(harmonicOrder(items.slice(0, 2), 1).map((i) => i.id)).toEqual(["x", "a"]);
        expect(harmonicOrder([])).toEqual([]);
    });

    it("converts tag keys to Camelot", () => {
        expect(toCamelot("8a")).toBe("8A");
        expect(toCamelot("Am")).toBe("8A");
        expect(toCamelot("A minor")).toBe("8A");
        expect(toCamelot("C")).toBe("8B");
        expect(toCamelot("C major")).toBe("8B");
        expect(toCamelot("F#m")).toBe("11A");
        expect(toCamelot("Gb")).toBe("2B");
        expect(toCamelot("Ebm")).toBe("2A");
        expect(toCamelot("B")).toBe("1B");
        expect(toCamelot("1d")).toBe("8B");
        expect(toCamelot("1m")).toBe("8A");
        expect(toCamelot("6m")).toBe("1A");
        expect(toCamelot("H")).toBeNull();
        expect(toCamelot("")).toBeNull();
    });
});
