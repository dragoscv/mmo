/**
 * Subtitle text search (WP16-50, D38 "search inside subtitles → jump").
 *
 * Cues from external `.srt`/`.vtt` sidecars and from embedded text tracks that were already
 * extracted to WebVTT (`subs-cache`) go into the FTS5 table `subtitle_fts` of media.sqlite.
 * Text is folded in JS before insert AND query (ș/ț/ă/â/î → s/t/a/a/i), so "inima" finds "inimă".
 * Embedded tracks are extracted only on an explicit `POST /media/subtitles/index` (one job in the
 * global ffmpeg analysis slot); search itself never spawns ffmpeg.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { MediaDb } from "./db";
import { foldText } from "../lib/fold";

export interface Cue { startSec: number; endSec: number; text: string }

export interface SubtitleHit {
    fileId: string;
    tmdbId: number | null;
    kind: string | null;
    season: number | null;
    episode: number | null;
    title: string;
    source: "external" | "embedded";
    trackIndex: number | null;
    trackKey: string;
    lang: string | null;
    startSec: number;
    endSec: number;
    text: string;
}

export interface SubtitleSource {
    fileId: string;
    trackKey: string;
    trackIndex: number | null;
    source: "external" | "embedded";
    lang: string | null;
    label: string | null;
    cues: number;
    indexedAt: number;
}

export const SEARCH_LIMIT = 50;
const SUB_EXT = new Set([".srt", ".vtt"]);

// ── parsing ───────────────────────────────────────────────────────────────

/** `01:02:03,456` / `01:02:03.456` / `02:03.456` → seconds. NaN when malformed. */
export function parseTimestamp(s: string): number {
    const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})$/.exec(s.trim());
    if (!m) return Number.NaN;
    const h = m[1] ? Number(m[1]) : 0;
    return h * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]!.padEnd(3, "0")) / 1000;
}

const TIMING_RE = /^\s*((?:\d+:)?\d{1,2}:\d{1,2}[,.]\d{1,3})\s*-->\s*((?:\d+:)?\d{1,2}:\d{1,2}[,.]\d{1,3})/;

/** Strip markup: `<i>`, `<c.x>`, `<00:01.000>`, `{\an8}`, ASS override blocks. */
export function cleanCueText(s: string): string {
    return s
        .replace(/<[^>]*>/g, "")
        .replace(/\{[^}]*\}/g, "")
        .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
        .replace(/\s+/g, " ")
        .trim();
}

/** Parses SRT and WebVTT alike (cue = timing line + following text lines until a blank line). */
export function parseSubtitles(raw: string): Cue[] {
    const text = raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
    const lines = text.split("\n");
    const cues: Cue[] = [];
    for (let i = 0; i < lines.length; i++) {
        const m = TIMING_RE.exec(lines[i]!);
        if (!m) continue;
        const startSec = parseTimestamp(m[1]!);
        const endSec = parseTimestamp(m[2]!);
        const body: string[] = [];
        let j = i + 1;
        for (; j < lines.length && lines[j]!.trim() !== ""; j++) {
            if (TIMING_RE.test(lines[j]!)) break;
            body.push(lines[j]!);
        }
        i = j - 1;
        const t = cleanCueText(body.join(" "));
        if (t && Number.isFinite(startSec) && Number.isFinite(endSec)) cues.push({ startSec, endSec: Math.max(endSec, startSec), text: t });
    }
    return cues;
}

/** UTF-8 when valid, else Windows-1250 (common for Romanian .srt), else latin1. */
export function decodeSubtitleBytes(buf: Buffer): string {
    try { return new TextDecoder("utf-8", { fatal: true }).decode(buf); } catch { /* not utf-8 */ }
    try { return new TextDecoder("windows-1250").decode(buf); } catch { /* ICU without 1250 */ }
    return buf.toString("latin1");
}

/** Sidecars next to a video: `Movie.srt`, `Movie.ro.srt`, `Movie.eng.forced.vtt` … */
export function findSidecars(absVideo: string): { path: string; lang: string | null; label: string }[] {
    const dir = path.dirname(absVideo);
    const base = path.basename(absVideo, path.extname(absVideo)).toLowerCase();
    let names: string[] = [];
    try { names = fs.readdirSync(dir); } catch { return []; }
    const out: { path: string; lang: string | null; label: string }[] = [];
    for (const n of names) {
        const ext = path.extname(n).toLowerCase();
        if (!SUB_EXT.has(ext)) continue;
        const stem = n.slice(0, -ext.length);
        if (stem.toLowerCase() !== base && !stem.toLowerCase().startsWith(`${base}.`)) continue;
        const tags = stem.slice(base.length).split(".").filter(Boolean);
        const lang = tags.find((t) => /^[a-z]{2,3}(?:-[a-z]{2})?$/i.test(t))?.toLowerCase() ?? null;
        out.push({ path: path.join(dir, n), lang, label: n });
    }
    return out.sort((a, b) => a.label.localeCompare(b.label));
}

const fileSig = (p: string): string => {
    try { const st = fs.statSync(p); return `${st.size}:${Math.floor(st.mtimeMs)}`; } catch { return ""; }
};

/** Folded query → FTS5 MATCH expression (`"w1"* "w2"*`, implicit AND). Null when no searchable word. */
export function toMatchQuery(q: string): string | null {
    const words = foldText(q).match(/[\p{L}\p{N}]+/gu) ?? [];
    const uniq = [...new Set(words)].slice(0, 12);
    return uniq.length ? uniq.map((w) => `"${w}"*`).join(" ") : null;
}

// ── index ─────────────────────────────────────────────────────────────────

export interface TitleInfo { kind: string | null; tmdbId: number | null; season: number | null; episode: number | null; title: string }

export class SubtitleIndex {
    constructor(private readonly db: MediaDb, private readonly now: () => number = Date.now) {}

    /** Replace one track's cues. */
    indexTrack(fileId: string, track: { key: string; index: number | null; source: "external" | "embedded"; lang: string | null; label: string | null; sig: string }, cues: Cue[]): number {
        this.db.transaction(() => {
            this.db.prepare("DELETE FROM subtitle_fts WHERE file_id = ? AND track_key = ?").run(fileId, track.key);
            const ins = this.db.prepare("INSERT INTO subtitle_fts (folded, text, file_id, track_key, start_sec, end_sec) VALUES (?, ?, ?, ?, ?, ?)");
            for (const c of cues) ins.run(foldText(c.text), c.text, fileId, track.key, c.startSec, c.endSec);
            this.db.prepare(
                `INSERT INTO subtitle_sources (file_id, track_key, track_index, source, lang, label, sig, cues, indexed_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(file_id, track_key) DO UPDATE SET track_index = excluded.track_index, source = excluded.source, lang = excluded.lang,
                   label = excluded.label, sig = excluded.sig, cues = excluded.cues, indexed_at = excluded.indexed_at`,
            ).run(fileId, track.key, track.index, track.source, track.lang, track.label, track.sig, cues.length, this.now());
        })();
        return cues.length;
    }

    sigOf(fileId: string, trackKey: string): string | null {
        const r = this.db.prepare("SELECT sig FROM subtitle_sources WHERE file_id = ? AND track_key = ?").get(fileId, trackKey) as { sig: string } | undefined;
        return r?.sig ?? null;
    }

    sources(fileId: string): SubtitleSource[] {
        const rows = this.db.prepare("SELECT * FROM subtitle_sources WHERE file_id = ? ORDER BY track_key").all(fileId) as {
            file_id: string; track_key: string; track_index: number | null; source: string; lang: string | null; label: string | null; cues: number; indexed_at: number;
        }[];
        return rows.map((r) => ({
            fileId: r.file_id, trackKey: r.track_key, trackIndex: r.track_index, source: r.source === "embedded" ? "embedded" : "external",
            lang: r.lang, label: r.label, cues: r.cues, indexedAt: r.indexed_at,
        }));
    }

    removeFile(fileId: string): void {
        this.db.prepare("DELETE FROM subtitle_fts WHERE file_id = ?").run(fileId);
        this.db.prepare("DELETE FROM subtitle_sources WHERE file_id = ?").run(fileId);
    }

    /** Index sidecars of a video (pure fs, cheap). Unchanged files (same size+mtime) are skipped. */
    indexSidecars(fileId: string, absVideo: string): number {
        let n = 0;
        for (const s of findSidecars(absVideo)) {
            const key = `ext:${path.basename(s.path)}`;
            const sig = fileSig(s.path);
            if (!sig || this.sigOf(fileId, key) === sig) continue;
            let raw: Buffer;
            try { raw = fs.readFileSync(s.path); } catch { continue; }
            if (raw.length > 8 * 1024 * 1024) continue;
            n += this.indexTrack(fileId, { key, index: null, source: "external", lang: s.lang, label: s.label, sig }, parseSubtitles(decodeSubtitleBytes(raw)));
        }
        return n;
    }

    /** Index already-extracted WebVTT files of embedded tracks. */
    indexEmbeddedVtts(fileId: string, tracks: { index: number; path: string; lang: string | null; label: string | null; sig: string }[]): number {
        let n = 0;
        for (const t of tracks) {
            const key = `emb:${t.index}`;
            if (this.sigOf(fileId, key) === t.sig) continue;
            let raw: string;
            try { raw = fs.readFileSync(t.path, "utf8"); } catch { continue; }
            n += this.indexTrack(fileId, { key, index: t.index, source: "embedded", lang: t.lang, label: t.label, sig: t.sig }, parseSubtitles(raw));
        }
        return n;
    }

    search(q: string, opts: { fileId?: string; limit?: number; titleOf: (fileId: string) => TitleInfo }): SubtitleHit[] {
        const match = toMatchQuery(q);
        if (!match) return [];
        const limit = Math.max(1, Math.min(SEARCH_LIMIT, opts.limit ?? SEARCH_LIMIT));
        const rows = (opts.fileId
            ? this.db.prepare(
                `SELECT f.text, f.file_id, f.track_key, f.start_sec, f.end_sec, s.track_index, s.source, s.lang
                 FROM subtitle_fts f LEFT JOIN subtitle_sources s ON s.file_id = f.file_id AND s.track_key = f.track_key
                 WHERE subtitle_fts MATCH ? AND f.file_id = ? ORDER BY CAST(f.start_sec AS REAL) LIMIT ?`,
            ).all(match, opts.fileId, limit)
            : this.db.prepare(
                `SELECT f.text, f.file_id, f.track_key, f.start_sec, f.end_sec, s.track_index, s.source, s.lang
                 FROM subtitle_fts f LEFT JOIN subtitle_sources s ON s.file_id = f.file_id AND s.track_key = f.track_key
                 WHERE subtitle_fts MATCH ? ORDER BY rank LIMIT ?`,
            ).all(match, limit)) as {
                text: string; file_id: string; track_key: string; start_sec: number; end_sec: number;
                track_index: number | null; source: string | null; lang: string | null;
            }[];
        const titles = new Map<string, TitleInfo>();
        return rows.map((r) => {
            let t = titles.get(r.file_id);
            if (!t) { t = opts.titleOf(r.file_id); titles.set(r.file_id, t); }
            return {
                fileId: r.file_id, tmdbId: t.tmdbId, kind: t.kind, season: t.season, episode: t.episode, title: t.title,
                source: r.source === "embedded" ? "embedded" : "external", trackIndex: r.track_index ?? null, trackKey: r.track_key,
                lang: r.lang ?? null, startSec: Number(r.start_sec), endSec: Number(r.end_sec), text: r.text,
            };
        });
    }
}

/** Stable short id for jobs. */
export const jobId = (prefix: string): string => `${prefix}_${crypto.randomBytes(6).toString("base64url")}`;
