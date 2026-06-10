import { describe, it, expect } from "vitest";
import { extractJson } from "./ai-call";

describe("extractJson", () => {
    it("parses raw JSON object", () => {
        expect(extractJson(`{"a":1,"b":"x"}`)).toEqual({ a: 1, b: "x" });
    });

    it("parses JSON wrapped in ```json fences", () => {
        const text = "Sure! Here you go:\n```json\n{\"genre\":\"Tech House\"}\n```\nHope that helps.";
        expect(extractJson(text)).toEqual({ genre: "Tech House" });
    });

    it("parses JSON wrapped in plain ``` fences", () => {
        const text = "```\n{\"k\":2}\n```";
        expect(extractJson(text)).toEqual({ k: 2 });
    });

    it("falls back to brace-slicing when surrounded by prose", () => {
        const text = "Based on the metadata, my best guess is { \"mood\": \"dark\", \"energy\": 7 }. Confidence: medium.";
        expect(extractJson(text)).toEqual({ mood: "dark", energy: 7 });
    });

    it("returns null when there is no JSON object", () => {
        expect(extractJson("plain prose, no braces here")).toBeNull();
    });

    it("returns null when the JSON is malformed", () => {
        expect(extractJson("{not json}")).toBeNull();
    });

    it("handles nested objects via brace-slicing", () => {
        const text = "Here: { \"a\": { \"b\": 1, \"c\": [1,2,3] } } end.";
        expect(extractJson(text)).toEqual({ a: { b: 1, c: [1, 2, 3] } });
    });
});
