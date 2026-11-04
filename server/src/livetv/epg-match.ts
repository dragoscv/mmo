/**
 * Match XMLTV channels to playlist channels: exact tvg-id (case-insensitive)
 * first, else a normalised display name (lowercase, no diacritics, no
 * bracketed tags, no quality/country suffixes, no punctuation).
 */

const NOISE = new Set(["hd", "fhd", "uhd", "sd", "4k", "8k", "hq", "lq", "ro", "rou", "hevc", "h264", "h265", "1080p", "1080i", "720p", "576p", "50fps", "60fps", "backup", "tv"]);

export function normaliseChannelName(name: string): string {
    const base = name
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/\[[^\]]*\]|\([^)]*\)|\{[^}]*\}/g, " ")
        .replace(/^\s*[a-z]{2,3}\s*[:|]\s*/, " ") // "RO: Pro TV", "RO | Digi 24"
        .replace(/[^a-z0-9+]+/g, " ");
    const words = base.split(" ").filter((w) => w && !NOISE.has(w));
    // Keep "tv" if it was the only word left (e.g. "TV HD"), else drop the noise.
    const joined = words.join("");
    return joined || base.replace(/\s+/g, "");
}

export interface MatchableChannel { id: string; tvgId: string | null; name: string }

export interface EpgMatcher {
    /** Our channel ids for an XMLTV channel id (+ its display names, if known). */
    match(xmltvId: string, displayNames?: readonly string[]): string[];
}

export function createEpgMatcher(channels: readonly MatchableChannel[]): EpgMatcher {
    const byTvg = new Map<string, string[]>();
    const byName = new Map<string, string[]>();
    const push = (m: Map<string, string[]>, k: string, id: string) => {
        if (!k) return;
        const arr = m.get(k);
        if (arr) { if (!arr.includes(id)) arr.push(id); } else m.set(k, [id]);
    };
    for (const c of channels) {
        if (c.tvgId) push(byTvg, c.tvgId.trim().toLowerCase(), c.id);
        push(byName, normaliseChannelName(c.name), c.id);
        // A tvg-id that does not match any XMLTV id still often equals a display name ("ProTV.ro").
        if (c.tvgId) push(byName, normaliseChannelName(c.tvgId.replace(/\.[a-z]{2,3}$/i, "")), c.id);
    }
    const cache = new Map<string, string[]>();
    return {
        match(xmltvId, displayNames = []) {
            const cached = cache.get(xmltvId);
            if (cached) return cached;
            let ids = byTvg.get(xmltvId.trim().toLowerCase()) ?? [];
            if (ids.length === 0) {
                const found = new Set<string>();
                for (const n of displayNames) for (const id of byName.get(normaliseChannelName(n)) ?? []) found.add(id);
                if (found.size === 0) for (const id of byName.get(normaliseChannelName(xmltvId.replace(/\.[a-z]{2,3}$/i, ""))) ?? []) found.add(id);
                ids = [...found];
            }
            cache.set(xmltvId, ids);
            return ids;
        },
    };
}

/** Pure helper: map every XMLTV channel to matching channel ids (tests, diagnostics). */
export function matchChannels(
    channels: readonly MatchableChannel[],
    xmltvChannels: ReadonlyArray<{ id: string; displayNames: readonly string[] }>,
): Map<string, string[]> {
    const m = createEpgMatcher(channels);
    const out = new Map<string, string[]>();
    for (const x of xmltvChannels) out.set(x.id, m.match(x.id, x.displayNames));
    return out;
}
