import type { ProbedVideo } from "./api";

export interface Show {
    /** Display title (first episode's parsed title, trimmed). */
    title: string;
    /** Normalised grouping key (trim + lower-case). */
    key: string;
    /** Sorted by season, then episode. */
    episodes: ProbedVideo[];
}

export function isEpisode(v: ProbedVideo): boolean {
    return v.parsed.season != null;
}

export function episodeCode(v: ProbedVideo): string {
    return `S${String(v.parsed.season ?? 0).padStart(2, "0")}E${String(v.parsed.episode ?? 0).padStart(2, "0")}`;
}

/** Episode file name without extension — used when the parser only yields the show title. */
export function episodeName(v: ProbedVideo): string {
    const base = v.path.split(/[\\/]/).pop() ?? v.path;
    return base.replace(/\.[^.]+$/, "");
}

export function sortEpisodes(list: ProbedVideo[]): ProbedVideo[] {
    return [...list].sort((a, b) => (a.parsed.season ?? 0) - (b.parsed.season ?? 0) || (a.parsed.episode ?? 0) - (b.parsed.episode ?? 0) || a.path.localeCompare(b.path));
}

/** Group episodes by title (trim, case-insensitive); shows sorted alphabetically. */
export function groupShows(videos: ProbedVideo[]): Show[] {
    const map = new Map<string, Show>();
    for (const v of videos) {
        if (!isEpisode(v)) continue;
        const title = v.parsed.title.trim() || episodeName(v);
        const key = title.toLowerCase();
        const show = map.get(key);
        if (show) show.episodes.push(v);
        else map.set(key, { title, key, episodes: [v] });
    }
    return [...map.values()]
        .map((s) => ({ ...s, episodes: sortEpisodes(s.episodes) }))
        .sort((a, b) => a.title.localeCompare(b.title));
}
