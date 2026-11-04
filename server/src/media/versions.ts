/** Version labels for multiple files of the same title (WP16-06), parsed from the file name. */

export interface VersionInfo {
    resolution: "2160p" | "1080p" | "720p" | "480p" | null;
    hdr: "DV" | "HDR10+" | "HDR" | null;
    edition: string | null;
    remux: boolean;
    /** Short human label, e.g. "4K · DV · Director's Cut". */
    label: string;
    /** Higher = better (used to pick the default version). */
    rank: number;
}

const EDITIONS: [RegExp, string][] = [
    [/director'?s[ ._-]?cut/i, "Director's Cut"],
    [/extended/i, "Extended"],
    [/theatrical/i, "Theatrical"],
    [/unrated/i, "Unrated"],
    [/imax/i, "IMAX"],
    [/remastered/i, "Remastered"],
    [/final[ ._-]?cut/i, "Final Cut"],
];

export function parseVersion(path: string): VersionInfo {
    const name = path.split(/[\\/]/).pop() ?? path;
    const resolution = /2160p|4k|uhd/i.test(name) ? "2160p" : /1080p/i.test(name) ? "1080p" : /720p/i.test(name) ? "720p" : /480p|dvdrip/i.test(name) ? "480p" : null;
    const hdr = /\b(dv|dovi|dolby[ ._-]?vision)\b/i.test(name) ? "DV" : /hdr10\+|hdr10plus/i.test(name) ? "HDR10+" : /\bhdr(10)?\b/i.test(name) ? "HDR" : null;
    const edition = EDITIONS.find(([re]) => re.test(name))?.[1] ?? null;
    const remux = /remux/i.test(name);
    const parts = [resolution === "2160p" ? "4K" : resolution, hdr, edition, remux ? "Remux" : null].filter(Boolean);
    const RES_RANK: Record<string, number> = { "2160p": 400, "1080p": 300, "720p": 200, "480p": 100 };
    const rank = (RES_RANK[resolution ?? ""] ?? 150)
        + (hdr === "DV" ? 30 : hdr ? 20 : 0) + (remux ? 10 : 0);
    return { resolution, hdr, edition, remux, label: parts.join(" · ") || name.replace(/\.[^.]+$/, ""), rank };
}
