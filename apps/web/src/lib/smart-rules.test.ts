import { describe, it, expect } from "vitest";
import {
    smartRulesSchema,
    compileSql,
    compileRules,
    applySmartRules,
    evaluateCondition,
    evaluateGroup,
    type FilterableTrack,
    type SmartRules,
} from "./smart-rules";

const tracks: FilterableTrack[] = [
    { id: 1, bpm: 128, energy: 0.8, genre: "techno", isFavorite: true, rating: 5, artist: "Surgeon", keyCamelot: "8A" },
    { id: 2, bpm: 122, energy: 0.5, genre: "tech-house", isFavorite: false, rating: 3, artist: "Solomun", keyCamelot: "8B" },
    { id: 3, bpm: 174, energy: 0.95, genre: "drum-and-bass", isFavorite: true, rating: 4, artist: "Noisia", keyCamelot: "10A" },
    { id: 4, bpm: 90, energy: 0.3, genre: "downtempo", isFavorite: false, rating: 2, artist: "Bonobo", keyCamelot: "5A" },
    { id: 5, bpm: 128, energy: 0.7, genre: "techno", isFavorite: false, rating: null, artist: "Jeff Mills" },
];

describe("smart-rules: zod validation", () => {
    it("accepts a valid builder rule", () => {
        const r: SmartRules = {
            kind: "builder",
            root: { type: "group", combinator: "and", children: [{ type: "condition", field: "bpm", operator: "between", value: [120, 130] }] },
        };
        expect(smartRulesSchema.parse(r)).toEqual(r);
    });

    it("rejects unknown field", () => {
        expect(() => smartRulesSchema.parse({
            kind: "builder",
            root: { type: "group", combinator: "and", children: [{ type: "condition", field: "nope", operator: "eq", value: 1 }] },
        })).toThrow();
    });

    it("rejects oversized IN list", () => {
        const huge = Array.from({ length: 100 }, (_, i) => `g${i}`);
        expect(() => smartRulesSchema.parse({
            kind: "builder",
            root: { type: "group", combinator: "and", children: [{ type: "condition", field: "genre", operator: "in", value: huge }] },
        })).toThrow();
    });
});

describe("smart-rules: condition evaluator", () => {
    const t = tracks[0];

    it("eq, neq", () => {
        expect(evaluateCondition(t, { type: "condition", field: "genre", operator: "eq", value: "techno" })).toBe(true);
        expect(evaluateCondition(t, { type: "condition", field: "genre", operator: "neq", value: "techno" })).toBe(false);
    });

    it("between", () => {
        expect(evaluateCondition(t, { type: "condition", field: "bpm", operator: "between", value: [120, 130] })).toBe(true);
        expect(evaluateCondition(t, { type: "condition", field: "bpm", operator: "between", value: [130, 140] })).toBe(false);
    });

    it("in / notIn", () => {
        expect(evaluateCondition(t, { type: "condition", field: "genre", operator: "in", value: ["techno", "house"] })).toBe(true);
        expect(evaluateCondition(t, { type: "condition", field: "genre", operator: "notIn", value: ["techno"] })).toBe(false);
    });

    it("contains case-insensitive", () => {
        expect(evaluateCondition(t, { type: "condition", field: "artist", operator: "contains", value: "SURG" })).toBe(true);
    });

    it("isSet / isNotSet", () => {
        expect(evaluateCondition(tracks[4], { type: "condition", field: "rating", operator: "isNotSet" })).toBe(true);
        expect(evaluateCondition(tracks[0], { type: "condition", field: "rating", operator: "isSet" })).toBe(true);
    });

    it("returns false on type-mismatched comparisons", () => {
        expect(evaluateCondition(t, { type: "condition", field: "bpm", operator: "lt", value: "abc" })).toBe(false);
    });
});

describe("smart-rules: group evaluator (AND/OR/nested)", () => {
    it("AND combines correctly", () => {
        const matched = tracks.filter((t) => evaluateGroup(t, {
            type: "group", combinator: "and", children: [
                { type: "condition", field: "genre", operator: "eq", value: "techno" },
                { type: "condition", field: "bpm", operator: "gte", value: 125 },
            ],
        }));
        expect(matched.map((t) => t.id)).toEqual([1, 5]);
    });

    it("OR combines correctly", () => {
        const matched = tracks.filter((t) => evaluateGroup(t, {
            type: "group", combinator: "or", children: [
                { type: "condition", field: "genre", operator: "eq", value: "downtempo" },
                { type: "condition", field: "bpm", operator: "gte", value: 170 },
            ],
        }));
        expect(matched.map((t) => t.id)).toEqual([3, 4]);
    });

    it("nested AND inside OR", () => {
        const matched = tracks.filter((t) => evaluateGroup(t, {
            type: "group", combinator: "or", children: [
                {
                    type: "group", combinator: "and", children: [
                        { type: "condition", field: "genre", operator: "eq", value: "techno" },
                        { type: "condition", field: "isFavorite", operator: "eq", value: true },
                    ],
                },
                { type: "condition", field: "bpm", operator: "lt", value: 100 },
            ],
        }));
        expect(matched.map((t) => t.id).sort()).toEqual([1, 4]);
    });
});

describe("smart-rules: SQL parser", () => {
    it("parses simple comparison", () => {
        const r = compileSql("bpm >= 120");
        expect(r.root.children).toEqual([{ type: "condition", field: "bpm", operator: "gte", value: 120 }]);
    });

    it("parses BETWEEN", () => {
        const r = compileSql("bpm BETWEEN 120 AND 130");
        expect(r.root.children[0]).toMatchObject({ type: "condition", operator: "between", value: [120, 130] });
    });

    it("parses IN with strings", () => {
        const r = compileSql("genre IN ('techno', 'tech-house')");
        expect(r.root.children[0]).toMatchObject({ type: "condition", operator: "in", value: ["techno", "tech-house"] });
    });

    it("parses AND / OR with proper precedence", () => {
        const r = compileSql("bpm > 120 AND genre = 'techno' OR rating = 5");
        // OR is lower precedence so root.combinator should be 'or'
        expect(r.root.combinator).toBe("or");
        expect(r.root.children).toHaveLength(2);
    });

    it("rejects unknown field", () => {
        expect(() => compileSql("foobar = 1")).toThrow(/unknown field/);
    });

    it("rejects unterminated string", () => {
        expect(() => compileSql("genre = 'techno")).toThrow();
    });

    it("evaluates a compiled SQL rule end-to-end", () => {
        const matched = applySmartRules(tracks, {
            kind: "sql",
            query: "bpm BETWEEN 120 AND 135 AND genre IN ('techno', 'tech-house')",
        });
        expect(matched.map((t) => t.id).sort()).toEqual([1, 2, 5]);
    });
});

describe("smart-rules: applySmartRules — sort + limit", () => {
    it("sorts ascending", () => {
        const out = applySmartRules(tracks, {
            kind: "builder",
            root: { type: "group", combinator: "and", children: [{ type: "condition", field: "id", operator: "isSet" }] },
            sort: { field: "bpm", direction: "asc" },
        });
        expect(out.map((t) => t.bpm)).toEqual([90, 122, 128, 128, 174]);
    });

    it("sorts descending and limits", () => {
        const out = applySmartRules(tracks, {
            kind: "builder",
            root: { type: "group", combinator: "and", children: [{ type: "condition", field: "id", operator: "isSet" }] },
            sort: { field: "energy", direction: "desc" },
            limit: 2,
        });
        expect(out.map((t) => t.id)).toEqual([3, 1]);
    });

    it("places nulls last when sorting", () => {
        const out = applySmartRules(tracks, {
            kind: "builder",
            root: { type: "group", combinator: "and", children: [{ type: "condition", field: "id", operator: "isSet" }] },
            sort: { field: "rating", direction: "desc" },
        });
        expect(out[out.length - 1].rating).toBeNull();
    });
});

describe("smart-rules: graph compiler", () => {
    it("collapses linear pipeline to builder + sort + limit", () => {
        const r = compileRules({
            kind: "graph",
            nodes: [
                { kind: "filter", id: "f1", condition: { type: "condition", field: "genre", operator: "eq", value: "techno" } },
                { kind: "sort", id: "s1", sort: { field: "bpm", direction: "asc" } },
                { kind: "limit", id: "l1", limit: 10 },
            ],
        });
        expect(r.kind).toBe("builder");
        expect(r.sort).toEqual({ field: "bpm", direction: "asc" });
        expect(r.limit).toBe(10);
    });
});

describe("smart-rules: AI mode passthrough", () => {
    it("returns match-all when compiled is missing", () => {
        const out = applySmartRules(tracks, { kind: "ai", prompt: "energetic techno" });
        expect(out).toHaveLength(tracks.length);
    });

    it("uses pre-compiled rules when present", () => {
        const out = applySmartRules(tracks, {
            kind: "ai",
            prompt: "high energy",
            compiled: {
                kind: "builder",
                root: { type: "group", combinator: "and", children: [{ type: "condition", field: "energy", operator: "gte", value: 0.7 }] },
            },
        });
        expect(out.map((t) => t.id).sort()).toEqual([1, 3, 5]);
    });
});
