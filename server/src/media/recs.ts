/**
 * Recommendation engine for Media Home.
 *
 * Pure, deterministic scoring (no I/O) + an orchestrator that pulls
 * candidates from TMDB (recommendations of the last 15 watched, trending,
 * discover on preferred providers) and assembles `HomeRow[]`.
 *
 * Scoring:
 *   profile  = multi-hot over genre / keyword / cast / director features,
 *              each watch weighted by completion (and rating when present)
 *              and decayed with a 60-day half-life.
 *   score    = cosine(profile, candidate features) * 0.6
 *            + normalised weightedRating * 0.3 + normalised popularity * 0.1
 *   RRF      = reciprocal-rank fusion (k = 60) over per-source ranked lists.
 *   diversify= ≤ N titles per collection, stable order otherwise.
 */

import crypto from "node:crypto";
import type { MediaDb } from "./db";
import { cacheGet, cacheSet } from "./db";
import type { TmdbClient } from "./tmdb";
import type { HistoryEntry, HomeRow, MediaKind, MediaLogger, TitleCard, TitleDetails } from "./types";

export const HALF_LIFE_MS = 60 * 24 * 3600_000;
export const RECS_TTL_MS = 24 * 3600_000;
export const RRF_K = 60;

export type FeatureVector = Map<string, number>;

export interface ProfileVector {
    features: FeatureVector;
    /** Total absolute weight (0 when history is empty → cold start). */
    mass: number;
}

export interface ScoredCandidate {
    card: TitleCard;
    score: number;
    /** Which seed (tmdbId) contributed it, when known. */
    seed?: number;
}

// ── pure functions ────────────────────────────────────────────────────────

export function decay(ageMs: number, halfLifeMs = HALF_LIFE_MS): number {
    if (ageMs <= 0) return 1;
    return Math.pow(0.5, ageMs / halfLifeMs);
}

/** Watch weight: completion drives it; explicit rating re-centres around 6/10. */
export function watchWeight(h: HistoryEntry): number {
    const completion = Math.max(0, Math.min(1, h.completion));
    let w = 0.2 + 0.8 * completion;
    if (typeof h.rating === "number") {
        const r = Math.max(0, Math.min(10, h.rating));
        w *= 0.4 + (r / 10) * 1.2; // 0.4 .. 1.6
    }
    if (h.dismissed) w = -Math.abs(w);
    return w;
}

export function featuresOf(t: TitleDetails | TitleCard): string[] {
    const out: string[] = [];
    for (const g of t.genreIds ?? []) out.push(`g:${g}`);
    const d = t as Partial<TitleDetails>;
    for (const k of d.keywords ?? []) out.push(`k:${k.id}`);
    for (const c of (d.cast ?? []).slice(0, 8)) out.push(`c:${c.id}`);
    for (const c of d.crew ?? []) out.push(`d:${c.id}`);
    return out;
}

/** Multi-hot profile. `lookup` returns the cached title details for a history entry. */
export function buildProfile(
    history: HistoryEntry[],
    lookup: (kind: MediaKind, tmdbId: number) => TitleDetails | TitleCard | null,
    now: number,
): ProfileVector {
    const features: FeatureVector = new Map();
    let mass = 0;
    for (const h of history) {
        const t = lookup(h.kind, h.tmdbId);
        if (!t) continue;
        const w = watchWeight(h) * decay(now - h.watchedAt);
        if (w === 0) continue;
        const feats = featuresOf(t);
        if (feats.length === 0) continue;
        // Normalise per title so a title with 40 keywords does not dominate.
        const per = w / Math.sqrt(feats.length);
        for (const f of feats) features.set(f, (features.get(f) ?? 0) + per);
        mass += Math.abs(w);
    }
    return { features, mass };
}

export function cosine(profile: FeatureVector, feats: string[]): number {
    if (profile.size === 0 || feats.length === 0) return 0;
    let dot = 0;
    for (const f of feats) dot += profile.get(f) ?? 0;
    let pn = 0;
    for (const v of profile.values()) pn += v * v;
    const norm = Math.sqrt(pn) * Math.sqrt(feats.length);
    return norm === 0 ? 0 : dot / norm;
}

/** IMDb-style Bayesian weighted rating: (v/(v+m))R + (m/(v+m))C. */
export function weightedRating(v: number, R: number, m: number, C: number): number {
    if (v + m <= 0) return C;
    return (v / (v + m)) * R + (m / (v + m)) * C;
}

export function scoreCandidates(
    profile: ProfileVector,
    candidates: TitleCard[],
    lookup?: (kind: MediaKind, tmdbId: number) => TitleDetails | null,
    opts: { m?: number; C?: number } = {},
): ScoredCandidate[] {
    const m = opts.m ?? 500;
    const C = opts.C ?? 6.5;
    const maxPop = Math.max(1, ...candidates.map((c) => c.popularity ?? 0));
    return candidates
        .map((card) => {
            const details = lookup?.(card.kind, card.tmdbId) ?? card;
            const sim = profile.mass > 0 ? cosine(profile.features, featuresOf(details)) : 0;
            const wr = weightedRating(card.voteCount ?? 0, card.voteAverage ?? C, m, C) / 10;
            const pop = Math.log1p(card.popularity ?? 0) / Math.log1p(maxPop);
            const score = profile.mass > 0 ? sim * 0.6 + wr * 0.3 + pop * 0.1 : wr * 0.6 + pop * 0.4;
            return { card, score };
        })
        .sort((a, b) => b.score - a.score || a.card.tmdbId - b.card.tmdbId);
}

const cardKey = (c: TitleCard) => `${c.kind}:${c.tmdbId}`;

/** Reciprocal-rank fusion over ranked lists; stable on ties by first appearance. */
export function rrfMerge(lists: TitleCard[][], k = RRF_K): TitleCard[] {
    const score = new Map<string, number>();
    const first = new Map<string, { card: TitleCard; order: number }>();
    let order = 0;
    for (const list of lists) {
        list.forEach((card, rank) => {
            const key = cardKey(card);
            score.set(key, (score.get(key) ?? 0) + 1 / (k + rank + 1));
            if (!first.has(key)) first.set(key, { card, order: order++ });
        });
    }
    return [...score.entries()]
        .sort((a, b) => b[1] - a[1] || first.get(a[0])!.order - first.get(b[0])!.order)
        .map(([key]) => first.get(key)!.card);
}

export function diversify(
    items: TitleCard[],
    maxPerCollection = 2,
    collectionOf?: (c: TitleCard) => number | null | undefined,
): TitleCard[] {
    const count = new Map<number, number>();
    const out: TitleCard[] = [];
    for (const it of items) {
        const col = collectionOf?.(it) ?? null;
        if (col !== null && col !== undefined) {
            const n = count.get(col) ?? 0;
            if (n >= maxPerCollection) continue;
            count.set(col, n + 1);
        }
        out.push(it);
    }
    return out;
}

export function excludeSeen(items: TitleCard[], history: HistoryEntry[], extraKeys: Iterable<string> = []): TitleCard[] {
    const seen = new Set<string>();
    for (const h of history) if (h.completion >= 0.9 || h.dismissed) seen.add(`${h.kind}:${h.tmdbId}`);
    for (const k of extraKeys) seen.add(k);
    return items.filter((c) => !seen.has(cardKey(c)));
}

export function dedupe(items: TitleCard[]): TitleCard[] {
    const seen = new Set<string>();
    return items.filter((c) => {
        const k = cardKey(c);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
    });
}

export function historyHash(history: HistoryEntry[], extra: string[] = []): string {
    const h = crypto.createHash("sha1");
    const sorted = [...history].sort((a, b) => a.tmdbId - b.tmdbId || a.kind.localeCompare(b.kind));
    for (const e of sorted) h.update(`${e.kind}:${e.tmdbId}:${Math.round(e.completion * 100)}:${e.rating ?? ""}:${e.dismissed ? 1 : 0};`);
    for (const x of extra) h.update(`|${x}`);
    return h.digest("hex").slice(0, 16);
}

// ── orchestrator ──────────────────────────────────────────────────────────

export interface LibraryItem { kind: MediaKind; tmdbId: number; updatedAt: number }

export interface ContinueItem extends TitleCard { progress: number }

export interface BuildHomeInput {
    profileId: string;
    history: HistoryEntry[];
    /** Titles present on this server (from `library_index`). */
    library: LibraryItem[];
    /** Continue-watching cards (already resolved by progress.ts). */
    continueItems?: ContinueItem[];
    region: string;
    providersPreferred?: number[];
    now?: number;
    force?: boolean;
}

export interface RecsDeps {
    db: MediaDb;
    tmdb: TmdbClient;
    log?: MediaLogger;
}

const ROW_LIMIT = 24;

export async function buildHomeRows(deps: RecsDeps, input: BuildHomeInput): Promise<HomeRow[]> {
    const now = input.now ?? Date.now();
    const region = input.region.toUpperCase();
    const libKeys = new Set(input.library.map((l) => `${l.kind}:${l.tmdbId}`));
    const providers = [...(input.providersPreferred ?? [])].sort((a, b) => a - b);
    const cacheKey = `home:${input.profileId}:${region}:${historyHash(input.history, [providers.join("."), String(libKeys.size)])}`;

    const rows: HomeRow[] = [];
    const cont = (input.continueItems ?? []).slice(0, ROW_LIMIT);
    if (cont.length > 0) {
        rows.push({ id: "continue", title: { ro: "Continuă vizionarea", en: "Continue watching" }, kind: "mixed", items: cont });
    }

    const cached = input.force ? null : cacheGet<HomeRow[]>(deps.db, cacheKey, RECS_TTL_MS, now);
    if (cached) return [...rows, ...cached.map((r) => ({ ...r, items: markLibrary(r.items, libKeys) }))];

    const lookup = (kind: MediaKind, id: number) => deps.tmdb.getCachedTitle(kind, id);
    const profile = buildProfile(input.history, lookup, now);
    const recent = [...input.history]
        .filter((h) => !h.dismissed && h.completion >= 0.5)
        .sort((a, b) => b.watchedAt - a.watchedAt)
        .slice(0, 15);

    // Candidates — recommendations of the recent seeds (network only when not cached).
    const seedLists: { seed: HistoryEntry; title: TitleDetails; items: TitleCard[] }[] = [];
    for (const h of recent) {
        const t = deps.tmdb.getCachedTitle(h.kind, h.tmdbId) ?? (await deps.tmdb.getTitle(h.kind, h.tmdbId));
        if (!t) continue;
        const items = dedupe([...t.recommendations, ...t.similar]);
        if (items.length > 0) seedLists.push({ seed: h, title: t, items });
    }

    const [trendMovie, trendTv, upcoming, onAir] = await Promise.all([
        deps.tmdb.trending("movie", "week"),
        deps.tmdb.trending("tv", "week"),
        deps.tmdb.upcoming(region),
        deps.tmdb.onTheAir(),
    ]);
    const withProviders = providers.length > 0 ? providers.join("|") : undefined;
    const [discMovie, discTv] = withProviders
        ? await Promise.all([
            deps.tmdb.discover("movie", { with_watch_providers: withProviders, watch_region: region }),
            deps.tmdb.discover("tv", { with_watch_providers: withProviders, watch_region: region }),
        ])
        : [null, null];

    const exclude = (items: TitleCard[]) => excludeSeen(items, input.history);
    const collectionOf = (c: TitleCard) => deps.tmdb.getCachedTitle(c.kind, c.tmdbId)?.collectionId ?? null;

    const computed: HomeRow[] = [];

    // Top picks — RRF of every source, re-ranked by profile similarity.
    const fused = rrfMerge([
        ...seedLists.map((s) => s.items),
        trendMovie.results,
        trendTv.results,
        ...(discMovie ? [discMovie.results] : []),
        ...(discTv ? [discTv.results] : []),
    ]);
    const topScored = scoreCandidates(profile, exclude(fused), (k, id) => deps.tmdb.getCachedTitle(k, id)).map((s) => s.card);
    const top = diversify(topScored, 2, collectionOf).slice(0, ROW_LIMIT);
    if (top.length > 0) {
        computed.push({
            id: "top_picks",
            title: { ro: "Alese pentru tine", en: "Top picks for you" },
            kind: "mixed",
            items: top,
            reason: profile.mass > 0 ? "profile" : "cold_start",
        });
    }

    // Because you watched ×≤3 — most recent seeds with enough candidates.
    const usedInTop = new Set(top.map(cardKey));
    let byw = 0;
    for (const s of seedLists) {
        if (byw >= 3) break;
        const items = diversify(exclude(s.items).filter((c) => !usedInTop.has(cardKey(c))), 2, collectionOf).slice(0, ROW_LIMIT);
        if (items.length < 4) continue;
        computed.push({
            id: `because_you_watched:${s.seed.tmdbId}`,
            title: { ro: `Pentru că ai văzut ${s.title.title}`, en: `Because you watched ${s.title.title}` },
            kind: s.seed.kind,
            items,
            reason: `seed:${s.seed.kind}:${s.seed.tmdbId}`,
        });
        byw++;
    }

    // Trending on your providers (falls back to trending in region when none preferred).
    const trendItems = withProviders && (discMovie || discTv)
        ? rrfMerge([discMovie?.results ?? [], discTv?.results ?? []])
        : rrfMerge([trendMovie.results, trendTv.results]);
    const trend = diversify(exclude(trendItems), 2, collectionOf).slice(0, ROW_LIMIT);
    if (trend.length > 0) {
        computed.push({
            id: "trending_on_your_providers",
            title: withProviders
                ? { ro: "În trend pe serviciile tale", en: "Trending on your services" }
                : { ro: `În trend în ${region}`, en: `Trending in ${region}` },
            kind: "mixed",
            items: trend,
        });
    }

    const up = dedupe([...upcoming.results, ...onAir.results])
        .filter((c) => !c.releaseDate || c.releaseDate >= new Date(now - 7 * 86400_000).toISOString().slice(0, 10))
        .slice(0, ROW_LIMIT);
    if (up.length > 0) {
        computed.push({ id: "upcoming", title: { ro: "În curând", en: "Coming soon" }, kind: "mixed", items: up });
    }

    // New in library — newest indexed titles with a TMDB id.
    const newest = [...input.library].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, ROW_LIMIT);
    const libCards: TitleCard[] = [];
    for (const l of newest) {
        const t = deps.tmdb.getCachedTitle(l.kind, l.tmdbId) ?? (await deps.tmdb.getTitle(l.kind, l.tmdbId));
        if (t) libCards.push(stripToCard(t));
        else libCards.push({ kind: l.kind, tmdbId: l.tmdbId, title: `#${l.tmdbId}`, posterPath: null, backdropPath: null, genreIds: [] });
    }
    if (libCards.length > 0) {
        computed.push({ id: "new_in_library", title: { ro: "Nou în bibliotecă", en: "New in your library" }, kind: "mixed", items: libCards });
    }

    const marked = computed.map((r) => ({ ...r, items: markLibrary(r.items, libKeys) }));
    cacheSet(deps.db, cacheKey, marked, now);
    return [...rows, ...marked];
}

export function markLibrary(items: TitleCard[], libKeys: Set<string>): TitleCard[] {
    return items.map((c) => (libKeys.has(cardKey(c)) ? { ...c, inLibrary: true } : c));
}

export function stripToCard(t: TitleDetails): TitleCard {
    return {
        kind: t.kind, tmdbId: t.tmdbId, title: t.title, originalTitle: t.originalTitle, overview: t.overview,
        posterPath: t.posterPath, backdropPath: t.backdropPath, releaseDate: t.releaseDate,
        voteAverage: t.voteAverage, voteCount: t.voteCount, popularity: t.popularity, genreIds: t.genreIds,
    };
}
