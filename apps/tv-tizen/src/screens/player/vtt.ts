/**
 * Minimal WebVTT parser + cue lookup for the custom subtitle renderer.
 *
 * Why not native `<track>` + `::cue`: (1) HLS sessions start at `?start=<sec>`, so the element clock is
 * relative while the server's WebVTT is absolute — native cues would be off by the offset; (2) Chromium 76
 * honours only a subset of `::cue` properties and none of them can be switched per profile without
 * rebuilding a stylesheet. Rendering the active cue into a plain div fixes both and costs one binary
 * search per `timeupdate` (~4 Hz).
 */

export interface Cue { start: number; end: number; text: string }

function ts(s: string): number | null {
    const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/.exec(s.trim());
    if (!m) return null;
    const h = m[1] ? Number(m[1]) : 0;
    return h * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]!.padEnd(3, "0")) / 1000;
}

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&nbsp;": " ", "&lrm;": "", "&rlm;": "" };

/** Strips VTT/HTML tags (`<i>`, `<c.x>`, `<00:01.000>`) and decodes the common entities. */
export function cueText(raw: string): string {
    return raw.replace(/<[^>]*>/g, "").replace(/&(amp|lt|gt|nbsp|lrm|rlm);/g, (e) => ENTITIES[e] ?? e).trim();
}

export function parseVtt(src: string): Cue[] {
    const out: Cue[] = [];
    const blocks = src.replace(/\r\n?/g, "\n").split(/\n{2,}/);
    for (const b of blocks) {
        const lines = b.split("\n");
        const i = lines.findIndex((l) => l.includes("-->"));
        if (i < 0) continue;
        const [a, rest = ""] = lines[i]!.split("-->");
        const start = ts(a ?? "");
        const end = ts(rest.trim().split(/\s+/)[0] ?? "");
        if (start === null || end === null || end <= start) continue;
        const text = cueText(lines.slice(i + 1).join("\n"));
        if (text) out.push({ start, end, text });
    }
    out.sort((x, y) => x.start - y.start);
    return out;
}

/** Texts of the cues active at `t` (overlapping cues stack, earliest first). */
export function activeCues(cues: Cue[], t: number): string[] {
    let lo = 0, hi = cues.length - 1, first = cues.length;
    // Last cue with start <= t.
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (cues[mid]!.start <= t) { first = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (first >= cues.length) return [];
    const res: string[] = [];
    // Walk back a few cues for overlaps (long cues that started earlier).
    for (let k = first; k >= 0 && k > first - 8; k--) {
        const c = cues[k]!;
        if (c.start <= t && t < c.end) res.unshift(c.text);
    }
    return res;
}
