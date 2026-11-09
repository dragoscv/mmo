import { describe, expect, it } from "vitest";
import en from "./en.json";
import ro from "./ro.json";

type Tree = { [k: string]: string | Tree };
const flat = (o: Tree, p = ""): Record<string, string> =>
    Object.entries(o).reduce<Record<string, string>>((acc, [k, v]) => {
        const key = p ? `${p}.${k}` : k;
        return typeof v === "string" ? { ...acc, [key]: v } : { ...acc, ...flat(v, key) };
    }, {});

describe("i18n parity", () => {
    const e = flat(en as Tree);
    const r = flat(ro as Tree);
    it("has identical keys in en and ro", () => {
        expect(Object.keys(r).sort()).toEqual(Object.keys(e).sort());
    });
    it("keeps the same placeholders", () => {
        const vars = (s: string) => [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();
        for (const k of Object.keys(e)) expect(vars(r[k] ?? ""), k).toEqual(vars(e[k] ?? ""));
    });
    it("uses Romanian diacritics with comma below (ș, ț), not cedilla", () => {
        expect(JSON.stringify(ro)).not.toMatch(/[şţŞŢ]/);
    });
});
