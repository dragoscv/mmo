import { describe, expect, it, vi } from "vitest";
import type { LanguageModel } from "ai";
import { applyCuration, askCurator, curateRows, curatorInput, homeRevisionHash } from "./curator";
import type { HomeRow } from "./types";

const card = (tmdbId: number, title: string): HomeRow["items"][number] => ({ kind: "movie", tmdbId, title, inLibrary: false, sources: [] });
const rows: HomeRow[] = [
    { id: "continue", title: { ro: "Continuă", en: "Continue" }, kind: "mixed", items: [card(1, "Alien")] },
    { id: "top_picks", title: { ro: "Top", en: "Top picks" }, kind: "mixed", items: [card(550, "Fight Club"), card(680, "Pulp Fiction"), card(13, "Forrest Gump"), card(14, "Extra")] },
];
const model = {} as LanguageModel;

describe("curatorInput / homeRevisionHash", () => {
    it("sends titles only and picks the first 3 top picks", () => {
        const input = curatorInput(rows);
        expect(input.rows[1]!.items).toEqual(["Fight Club", "Pulp Fiction", "Forrest Gump", "Extra"]);
        expect(input.topPicks.map((t) => t.tmdbId)).toEqual([550, 680, 13]);
        expect(JSON.stringify(input)).not.toContain("overview");
    });
    it("hash is stable for equal rows and changes with items", () => {
        expect(homeRevisionHash(rows)).toBe(homeRevisionHash(structuredClone(rows)));
        const other = structuredClone(rows);
        other[1]!.items.push(card(99, "New"));
        expect(homeRevisionHash(other)).not.toBe(homeRevisionHash(rows));
    });
});

describe("applyCuration", () => {
    it("renames known rows and attaches why-notes to the top picks", () => {
        const out = applyCuration(rows, {
            rows: [{ id: "top_picks", title: { ro: "Seara asta", en: "Tonight" } }, { id: "nope", title: { ro: "x", en: "x" } }],
            why: [{ tmdbId: 550, ro: "Pentru că…", en: "Because…" }, { tmdbId: 4242, ro: "n/a", en: "n/a" }],
        });
        expect(out.rows[1]!.title).toEqual({ ro: "Seara asta", en: "Tonight" });
        expect(out.rows[0]!.title.en).toBe("Continue");
        expect(out.notes).toEqual([{ tmdbId: 550, kind: "movie", title: "Fight Club", why: { ro: "Pentru că…", en: "Because…" } }]);
    });
});

describe("askCurator", () => {
    it("returns the parsed object on success", async () => {
        const generate = vi.fn().mockResolvedValue({ object: { rows: [{ id: "top_picks", title: { ro: "A", en: "B" } }], why: [] } });
        const out = await askCurator(rows, { model, generate: generate as never });
        expect(out?.rows[0]!.title.en).toBe("B");
        expect(generate).toHaveBeenCalledTimes(1);
        const args = generate.mock.calls[0]![0] as { abortSignal: AbortSignal; maxRetries: number };
        expect(args.maxRetries).toBe(0);
        expect(args.abortSignal).toBeInstanceOf(AbortSignal);
    });
    it("returns null on timeout / throw", async () => {
        const generate = vi.fn().mockRejectedValue(Object.assign(new Error("aborted"), { name: "TimeoutError" }));
        expect(await askCurator(rows, { model, generate: generate as never })).toBeNull();
    });
    it("returns null on invalid JSON shape (title too long)", async () => {
        const generate = vi.fn().mockResolvedValue({ object: { rows: [{ id: "top_picks", title: { ro: "x".repeat(80), en: "ok" } }], why: [] } });
        expect(await askCurator(rows, { model, generate: generate as never })).toBeNull();
    });
    it("curateRows leaves rows unchanged on failure", async () => {
        const generate = vi.fn().mockResolvedValue({ object: "garbage" });
        const out = await curateRows(rows, { model, generate: generate as never });
        expect(out.rows).toBe(rows);
        expect(out.notes).toEqual([]);
    });
});
