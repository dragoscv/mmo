/**
 * Pure merge of `/media/title/:kind/:tmdbId` responses from N servers
 * (WP11-04). Details come from the first server; local files are the union
 * across servers; availability is taken from the first server whose
 * resolver returned something (`source !== "none"`).
 */

import type { ServerError, ServerResult } from "./aggregate";
import {
    filesToSources,
    normalizeAvailability,
    normalizeTitle,
    progressFraction,
    type WireTitleResponse,
} from "./normalize";
import type { MergedTitleDetails, TitleSource } from "./types";

const maxNullable = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : Math.max(a, b));

export function mergeTitleResponses(
    results: ServerResult<WireTitleResponse>[],
    errors: ServerError[] = [],
): MergedTitleDetails | null {
    if (results.length === 0) return null;
    const first = results[0]!;
    const title = normalizeTitle(first.data.title);
    const sources: TitleSource[] = [];
    const seen = new Set<string>();
    let availability = normalizeAvailability(null);
    let progress: number | null = null;
    for (const r of results) {
        for (const s of filesToSources(r.data.files, r.serverId, r.name)) {
            const key = `${s.serverId}:${s.fileId}`;
            if (seen.has(key)) continue;
            seen.add(key);
            sources.push(s);
        }
        const a = normalizeAvailability(r.data.availability);
        if (availability.source === "none" && a.source !== "none") availability = a;
        progress = maxNullable(progress, progressFraction(r.data.progress));
        // Fill missing artwork from later servers (a server without TMDB key may return sparse data).
        title.poster ??= r.data.title.posterPath ?? null;
        title.backdrop ??= r.data.title.backdropPath ?? null;
        title.logo ??= r.data.title.logoPath ?? null;
    }
    sources.sort((a, b) => (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0));
    return { title, sources, availability, progress, errors };
}

/** Resolve the URL a provider button opens: exact deep link → provider web page → search. */
export function offerHref(offer: { link?: string | null; launch: { web: string; search: string } }): string {
    return offer.link || offer.launch.web || offer.launch.search;
}

/** Group sources by server so the title page renders one "Play on <server>" block per machine. */
export function groupSourcesByServer(sources: TitleSource[]): Array<{ serverId: string; serverName: string; files: TitleSource[] }> {
    const map = new Map<string, { serverId: string; serverName: string; files: TitleSource[] }>();
    for (const s of sources) {
        const g = map.get(s.serverId) ?? { serverId: s.serverId, serverName: s.serverName, files: [] };
        g.files.push(s);
        map.set(s.serverId, g);
    }
    return [...map.values()];
}
