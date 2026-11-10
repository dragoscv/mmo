/**
 * Age ratings (WP16-02). TMDB certifications per country → one minimum age
 * (0/12/14/15/16/18/19 where 19 = adult-only XXX). The RO CNC system is the
 * reference; other countries map onto the same scale.
 */

import type { MediaKind, TitleCard, TitleDetails } from "./types";

type Raw = Record<string, unknown>;

/** Map of `COUNTRY:CERT` (upper-case) → minimum age. */
const TABLE: Record<string, number> = {};
const add = (country: string, pairs: [string, number][]) => {
    for (const [c, age] of pairs) TABLE[`${country}:${c.toUpperCase()}`] = age;
};
add("RO", [["AG", 0], ["AP-12", 12], ["AP12", 12], ["I.C.-14", 14], ["IC-14", 14], ["N-15", 15], ["N15", 15], ["IM-18", 18], ["IM18", 18], ["IM-18-XXX", 19]]);
add("US", [["G", 0], ["PG", 10], ["PG-13", 13], ["R", 17], ["NC-17", 18], ["NR", -1],
    ["TV-Y", 0], ["TV-Y7", 7], ["TV-G", 0], ["TV-PG", 10], ["TV-14", 14], ["TV-MA", 18]]);
add("GB", [["U", 0], ["PG", 8], ["12A", 12], ["12", 12], ["15", 15], ["18", 18], ["R18", 19]]);
add("DE", [["0", 0], ["6", 6], ["12", 12], ["16", 16], ["18", 18]]);
add("FR", [["U", 0], ["TP", 0], ["10", 10], ["12", 12], ["16", 16], ["18", 18]]);

/** Order in which countries are consulted when the region has no rating. */
export const RATING_FALLBACK = ["US", "GB", "DE", "FR"];

/** Minimum age for one certification, `null` when unknown/unrated. */
export function ageForCert(cert: string | undefined | null, country: string): number | null {
    if (!cert) return null;
    const c = cert.trim().toUpperCase();
    const hit = TABLE[`${country.toUpperCase()}:${c}`];
    if (hit !== undefined) return hit < 0 ? null : hit;
    const n = Number(c.replace(/\D+/g, ""));
    if (/^\d{1,2}\+?$/.test(c) && Number.isFinite(n)) return n;
    return null;
}

/** country → certification from a raw TMDB title (release_dates / content_ratings). */
export function extractRatings(raw: Raw, kind: MediaKind): Record<string, string> {
    const out: Record<string, string> = {};
    if (kind === "movie") {
        const results = ((raw.release_dates as Raw | undefined)?.results ?? []) as Raw[];
        for (const r of results) {
            const iso = typeof r.iso_3166_1 === "string" ? r.iso_3166_1 : "";
            const dates = (r.release_dates ?? []) as Raw[];
            // Prefer theatrical (3), then digital/physical (4/5), then anything.
            const byType = (t: number) => dates.find((d) => d.type === t && typeof d.certification === "string" && d.certification);
            const pick = byType(3) ?? byType(4) ?? byType(5) ?? dates.find((d) => typeof d.certification === "string" && d.certification);
            if (iso && pick) out[iso] = String(pick.certification);
        }
    } else {
        const results = ((raw.content_ratings as Raw | undefined)?.results ?? []) as Raw[];
        for (const r of results) {
            if (typeof r.iso_3166_1 === "string" && typeof r.rating === "string" && r.rating) out[r.iso_3166_1] = r.rating;
        }
    }
    return out;
}

/** Minimum age for a title: region first, then fallbacks; `null` when nothing maps. */
export function ageForRatings(ratings: Record<string, string> | undefined, region: string): number | null {
    if (!ratings) return null;
    for (const c of [region.toUpperCase(), ...RATING_FALLBACK]) {
        const a = ageForCert(ratings[c], c);
        if (a !== null) return a;
    }
    return null;
}

/**
 * True when a title is allowed for a profile with `maxAge`.
 * `maxAge` null/undefined = no restriction. For a restricted profile:
 *  - `age` undefined = nobody looked the title up yet → blocked (TMDB list results carry no certification;
 *    callers resolve ages first, see `age-lookup.ts`);
 *  - `age` null = looked up, no certification anywhere → only the Family (10751) and Kids (10762) genres pass.
 *    Animation (16) alone is not enough: adult animation is often unrated.
 */
export function allowedForAge(age: number | null | undefined, maxAge: number | null | undefined, genreIds: number[] = []): boolean {
    if (maxAge === null || maxAge === undefined) return true;
    if (age === undefined) return false;
    if (age === null) return genreIds.some((g) => g === 10751 || g === 10762);
    return age <= maxAge;
}

/** Filter cards for a profile; `ageOf` resolves the cached age of a card (undefined = not looked up yet). */
export function filterCardsForAge<T extends TitleCard>(cards: T[], maxAge: number | null | undefined, ageOf: (c: T) => number | null | undefined): T[] {
    if (maxAge === null || maxAge === undefined) return cards;
    return cards.filter((c) => allowedForAge(c.age !== undefined ? c.age : ageOf(c), maxAge, c.genreIds));
}

export function ageOfDetails(t: TitleDetails | null | undefined): number | null | undefined {
    return t ? t.age ?? null : undefined;
}
