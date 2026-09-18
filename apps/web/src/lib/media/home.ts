/**
 * Pure helpers for Media Home (WP11-03): server-chip filtering, hero
 * selection and the `?servers=` URL parser shared by the client chips and
 * the RSC. No I/O.
 */

import type { HomeRow, MediaServer, MergedTitle } from "./types";

/** URL key for the server filter (`?servers=a,b`); the nuqs parser lives in `server-chips.tsx`
 *  because `nuqs` parsers are client-only and this module is imported by the RSC. */
export const SERVERS_PARAM = "servers";

export interface ServerChip extends MediaServer {
    /** Distinct titles this server contributes to the merged rows. */
    count: number;
}

/** One chip per paired server with the number of titles it sources. */
export function buildServerChips(servers: MediaServer[], rows: HomeRow[]): ServerChip[] {
    const counts = new Map<string, Set<string>>();
    for (const row of rows) {
        for (const it of row.items) {
            for (const s of it.sources ?? []) {
                const set = counts.get(s.serverId) ?? new Set<string>();
                set.add(`${it.kind}:${it.tmdbId}`);
                counts.set(s.serverId, set);
            }
        }
    }
    return servers.map((s) => ({ ...s, count: counts.get(s.id)?.size ?? 0 }));
}

/**
 * Keep only titles sourced by one of `selected` servers. External
 * (non-library) recommendations have no sources and are kept when nothing is
 * selected; with an active filter they are dropped so the page answers
 * "what can I play on <server>". Rows left empty are removed.
 */
export function filterRowsByServers(rows: HomeRow[], selected: string[]): HomeRow[] {
    if (selected.length === 0) return rows;
    const set = new Set(selected);
    return rows
        .map((r) => ({ ...r, items: r.items.filter((it) => (it.sources ?? []).some((s) => set.has(s.serverId))) }))
        .filter((r) => r.items.length > 0);
}

/** Top-N hero candidates: prefer backdrop + logo, then rating; continue-row items first. */
export function pickHeroCandidates(rows: HomeRow[], n = 5): MergedTitle[] {
    const seen = new Set<string>();
    const out: MergedTitle[] = [];
    const ordered = [...rows].sort((a, b) => (a.id === "continue" ? -1 : b.id === "continue" ? 1 : 0));
    for (const row of ordered) {
        for (const it of row.items) {
            const key = `${it.kind}:${it.tmdbId}`;
            if (seen.has(key) || !it.backdrop) continue;
            seen.add(key);
            out.push({ ...it, sources: it.sources ?? [], inLibrary: it.inLibrary });
        }
    }
    out.sort((a, b) => Number(!!b.logo) - Number(!!a.logo) || (b.rating ?? 0) - (a.rating ?? 0));
    return out.slice(0, n);
}

/** Localised row title (server rows carry both languages). */
export function rowTitle(row: Pick<HomeRow, "title">, locale: string): string {
    return locale.startsWith("ro") ? row.title.ro : row.title.en;
}

/** Relative "x min/h/d ago" without a date library; `null` → unknown. */
export function relativeSince(then: Date | null, now: number, locale: string): string {
    if (!then) return locale.startsWith("ro") ? "necunoscut" : "unknown";
    const rtf = new Intl.RelativeTimeFormat(locale.startsWith("ro") ? "ro" : "en", { numeric: "auto" });
    const diffSec = Math.round((then.getTime() - now) / 1000);
    const abs = Math.abs(diffSec);
    if (abs < 3600) return rtf.format(Math.round(diffSec / 60), "minute");
    if (abs < 86400) return rtf.format(Math.round(diffSec / 3600), "hour");
    return rtf.format(Math.round(diffSec / 86400), "day");
}
