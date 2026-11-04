/**
 * Tolerant M3U / M3U8 (IPTV) playlist parser.
 *
 * Handles BOM, CRLF/CR, unquoted or single-quoted attribute values, commas
 * inside quoted values, `#EXTGRP`, `#EXTVLCOPT` and blank lines. Single pass
 * over the string, no regex backtracking per line — 50k entries parse in
 * tens of milliseconds.
 */

import fs from "node:fs/promises";
import { defaultFetch, fetchText, isHttpUrl, type FetchLike } from "./util";

export interface M3uEntry {
    name: string;
    url: string;
    duration: number;
    tvgId: string | null;
    tvgName: string | null;
    tvgLogo: string | null;
    tvgChno: string | null;
    groupTitle: string | null;
    catchup: string | null;
    catchupDays: number;
    catchupSource: string | null;
    attrs: Record<string, string>;
}

export interface M3uPlaylist {
    /** XMLTV url from the `#EXTM3U x-tvg-url= / url-tvg=` header (first one if comma-separated). */
    xmltvUrl: string | null;
    headerAttrs: Record<string, string>;
    entries: M3uEntry[];
}

/** Parse `key="v" key2=v2 key3='v3'` into a map; keys are lowercased. */
export function parseAttrs(s: string): Record<string, string> {
    const out: Record<string, string> = {};
    const n = s.length;
    let i = 0;
    while (i < n) {
        while (i < n && (s.charCodeAt(i) <= 32)) i++;
        const ks = i;
        while (i < n && s[i] !== "=" && s.charCodeAt(i) > 32) i++;
        const key = s.slice(ks, i).toLowerCase();
        if (i >= n || s[i] !== "=") { i++; continue; }
        i++; // '='
        let value: string;
        const q = s[i];
        if (q === '"' || q === "'") {
            const end = s.indexOf(q, i + 1);
            if (end < 0) { value = s.slice(i + 1); i = n; } else { value = s.slice(i + 1, end); i = end + 1; }
        } else {
            const vs = i;
            while (i < n && s.charCodeAt(i) > 32) i++;
            value = s.slice(vs, i);
        }
        if (key) out[key] = value.trim();
    }
    return out;
}

/** Index of the comma that separates attributes from the display name (ignores commas inside quotes). */
function nameComma(s: string): number {
    let quote: string | null = null;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (quote) { if (c === quote) quote = null; continue; }
        if (c === '"') { quote = c; continue; }
        if (c === ",") return i;
    }
    return -1;
}

function parseExtinf(rest: string): { duration: number; attrs: Record<string, string>; name: string } {
    const comma = nameComma(rest);
    const head = comma >= 0 ? rest.slice(0, comma) : rest;
    const name = comma >= 0 ? rest.slice(comma + 1).trim() : "";
    const sp = head.search(/\s/);
    const durStr = sp >= 0 ? head.slice(0, sp) : head;
    const duration = Number.parseFloat(durStr);
    const attrs = sp >= 0 ? parseAttrs(head.slice(sp + 1)) : {};
    return { duration: Number.isFinite(duration) ? duration : -1, attrs, name };
}

const nz = (v: string | undefined): string | null => (v && v.length > 0 ? v : null);

export function parseM3u(text: string): M3uPlaylist {
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const headerAttrs: Record<string, string> = {};
    const entries: M3uEntry[] = [];
    let pending: { duration: number; attrs: Record<string, string>; name: string } | null = null;
    let pendingGroup: string | null = null;
    let pos = 0;
    const len = text.length;
    while (pos < len) {
        let end = pos;
        while (end < len) {
            const c = text.charCodeAt(end);
            if (c === 10 || c === 13) break;
            end++;
        }
        const line = text.slice(pos, end).trim();
        pos = end + 1;
        if (end < len && text.charCodeAt(end) === 13 && text.charCodeAt(end + 1) === 10) pos++;
        if (line.length === 0) continue;
        if (line.charCodeAt(0) === 35 /* # */) {
            const upper = line.slice(0, 8).toUpperCase();
            if (upper.startsWith("#EXTM3U")) {
                Object.assign(headerAttrs, parseAttrs(line.slice(7)));
            } else if (upper.startsWith("#EXTINF:")) {
                pending = parseExtinf(line.slice(8));
            } else if (upper.startsWith("#EXTGRP:")) {
                pendingGroup = line.slice(8).trim() || null;
            }
            continue;
        }
        // URL line
        if (!pending) continue; // bare URL without EXTINF — ignore
        const a = pending.attrs;
        const days = Number.parseInt(a["catchup-days"] ?? a["timeshift"] ?? "", 10);
        entries.push({
            name: pending.name || a["tvg-name"] || line,
            url: line,
            duration: pending.duration,
            tvgId: nz(a["tvg-id"]),
            tvgName: nz(a["tvg-name"]),
            tvgLogo: nz(a["tvg-logo"]),
            tvgChno: nz(a["tvg-chno"] ?? a["channel-number"]),
            groupTitle: nz(a["group-title"]) ?? pendingGroup,
            catchup: nz(a["catchup"] ?? a["catchup-type"]),
            catchupDays: Number.isFinite(days) && days > 0 ? days : 0,
            catchupSource: nz(a["catchup-source"]),
            attrs: a,
        });
        pending = null;
        pendingGroup = null;
    }
    const tvg = headerAttrs["x-tvg-url"] ?? headerAttrs["url-tvg"] ?? headerAttrs["tvg-url"];
    const xmltvUrl = tvg ? (tvg.split(",")[0]?.trim() || null) : null;
    return { xmltvUrl, headerAttrs, entries };
}

/** Fetch an http(s) URL or read a local file path, then parse. */
export async function loadM3u(location: string, opts: { fetch?: FetchLike; timeoutMs?: number } = {}): Promise<M3uPlaylist> {
    const text = isHttpUrl(location)
        ? await fetchText(opts.fetch ?? defaultFetch, location, opts.timeoutMs ?? 30_000)
        : await fs.readFile(location.replace(/^file:\/\//i, ""), "utf8");
    return parseM3u(text);
}
