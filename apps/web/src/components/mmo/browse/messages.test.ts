import { describe, expect, it } from "vitest";
import en from "../../../../messages/wp16/browse.en.json";
import ro from "../../../../messages/wp16/browse.ro.json";

const flat = (o: Record<string, unknown>, pre = ""): string[] =>
    Object.entries(o).flatMap(([k, v]) => (v && typeof v === "object" ? flat(v as Record<string, unknown>, `${pre}${k}.`) : [`${pre}${k}`]));

describe("mx.browse messages", () => {
    it("have identical key sets in EN and RO", () => {
        expect(flat(ro).sort()).toEqual(flat(en).sort());
    });
    it("use one/few/other in every Romanian plural", () => {
        const ro2 = ro as Record<string, Record<string, unknown>>;
        const plurals = flat(ro).map((k) => k.split(".").reduce<unknown>((o, p) => (o as Record<string, unknown>)[p], ro2)).filter((v): v is string => typeof v === "string" && v.includes("plural,"));
        expect(plurals.length).toBeGreaterThan(5);
        for (const p of plurals) expect(p).toMatch(/one \{.*few \{.*other \{/);
    });
});
