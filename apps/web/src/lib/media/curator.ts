/**
 * Codai curator for Media Home (WP11-07). Env-gated: runs only when the
 * profile opted in (`prefs.curator`) AND codai has a key (`isCodaiAvailable`).
 * One `generateObject` call per (user, profile, region, rows hash) — titles
 * only, ≤ 60 items — returns a punchy bilingual title per row and a one-line
 * "why" for the first 3 items of `top_picks`. Strict JSON via zod; 6 s
 * budget; any failure (timeout, invalid JSON, no key) → rows unchanged.
 * Cached 24 h in `unstable_cache` by the same key.
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import type { LanguageModel } from "ai";
import type { HomeRow } from "./types";

export const CURATOR_TTL_SEC = 24 * 60 * 60;
export const CURATOR_TIMEOUT_MS = 6000;
export const CURATOR_MAX_ITEMS = 60;
export const CURATOR_WHY_COUNT = 3;
const TITLE_MAX = 40;

export const curatorOutputSchema = z.object({
    rows: z.array(z.object({
        id: z.string().min(1),
        title: z.object({ ro: z.string().min(1).max(TITLE_MAX), en: z.string().min(1).max(TITLE_MAX) }),
    })).max(30),
    why: z.array(z.object({
        tmdbId: z.number().int().positive(),
        ro: z.string().min(1).max(160),
        en: z.string().min(1).max(160),
    })).max(CURATOR_WHY_COUNT),
});
export type CuratorOutput = z.infer<typeof curatorOutputSchema>;

export interface CuratorNoteItem {
    tmdbId: number;
    kind: "movie" | "tv";
    title: string;
    why: { ro: string; en: string };
}

export interface CuratedHome {
    rows: HomeRow[];
    /** "Why" notes for the first picks; empty when the curator did not run. */
    notes: CuratorNoteItem[];
}

/** Compact prompt payload: row ids + titles only (no overviews, no artwork). */
export function curatorInput(rows: HomeRow[]): { rows: Array<{ id: string; title: string; items: string[] }>; topPicks: Array<{ tmdbId: number; title: string; year: number | null }> } {
    let budget = CURATOR_MAX_ITEMS;
    const out = rows.map((r) => {
        const items = r.items.slice(0, Math.max(0, Math.min(8, budget))).map((it) => it.title);
        budget -= items.length;
        return { id: r.id, title: r.title.en, items };
    });
    const top = rows.find((r) => r.id === "top_picks") ?? rows.find((r) => r.id !== "continue") ?? rows[0];
    const topPicks = (top?.items ?? []).slice(0, CURATOR_WHY_COUNT).map((it) => ({ tmdbId: it.tmdbId, title: it.title, year: it.year ?? null }));
    return { rows: out, topPicks };
}

/** Stable key for the cache: same rows in the same order → same hash. */
export function homeRevisionHash(rows: HomeRow[]): string {
    const h = createHash("sha1");
    for (const r of rows) {
        h.update(r.id).update("|");
        for (const it of r.items.slice(0, 8)) h.update(`${it.kind}:${it.tmdbId},`);
        h.update(";");
    }
    return h.digest("hex").slice(0, 16);
}

/** Apply a validated curator answer to the rows (pure). Unknown row ids are ignored. */
export function applyCuration(rows: HomeRow[], out: CuratorOutput): CuratedHome {
    const titles = new Map(out.rows.map((r) => [r.id, r.title]));
    const next = rows.map((r) => {
        const t = titles.get(r.id);
        return t ? { ...r, title: { ro: t.ro.trim(), en: t.en.trim() } } : r;
    });
    const top = rows.find((r) => r.id === "top_picks") ?? rows.find((r) => r.id !== "continue") ?? rows[0];
    const byId = new Map((top?.items ?? []).map((it) => [it.tmdbId, it]));
    const notes: CuratorNoteItem[] = [];
    for (const w of out.why) {
        const it = byId.get(w.tmdbId);
        if (!it || notes.length >= CURATOR_WHY_COUNT) continue;
        notes.push({ tmdbId: it.tmdbId, kind: it.kind, title: it.title, why: { ro: w.ro.trim(), en: w.en.trim() } });
    }
    return { rows: next, notes };
}

const SYSTEM = [
    "You curate a personal movie/TV home screen for one household.",
    "Input: rows (id, current English title, item titles) and topPicks (the first titles of the main row).",
    "Output strict JSON only. For every row give a punchy title in Romanian (ro) and English (en), each ≤ 40 characters, no emoji, no quotes.",
    "Keep the meaning of the original row (continue = resume, trending = popular now).",
    "For each of topPicks write one line (≤ 160 chars) in ro and en explaining why it fits tonight, based only on the titles given. Never invent facts about plot.",
].join(" ");

export interface CurateOptions {
    model: LanguageModel;
    timeoutMs?: number;
    /** Injectable for tests; defaults to `generateObject` from `ai`. */
    generate?: typeof import("ai").generateObject;
}

/**
 * Ask the model once. Resolves to `null` on ANY failure so callers keep the
 * original rows; never throws.
 */
export async function askCurator(rows: HomeRow[], opts: CurateOptions): Promise<CuratorOutput | null> {
    if (rows.length === 0) return null;
    const timeoutMs = opts.timeoutMs ?? CURATOR_TIMEOUT_MS;
    try {
        const generate = opts.generate ?? (await import("ai")).generateObject;
        const { object } = await generate({
            model: opts.model,
            schema: curatorOutputSchema,
            instructions: SYSTEM,
            prompt: JSON.stringify(curatorInput(rows)),
            abortSignal: AbortSignal.timeout(timeoutMs),
            maxRetries: 0,
        });
        const parsed = curatorOutputSchema.safeParse(object);
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

/** Convenience: ask + apply, falling back to the untouched rows. */
export async function curateRows(rows: HomeRow[], opts: CurateOptions): Promise<CuratedHome> {
    const out = await askCurator(rows, opts);
    return out ? applyCuration(rows, out) : { rows, notes: [] };
}
