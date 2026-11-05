/**
 * Pure Live TV logic (WP16-41): EPG slot layout, now line, guide windows/days, list filtering,
 * virtual-row ranges, zap neighbours and the channel-number digit buffer. No React, no DOM —
 * unit-tested in `live-logic.test.ts`.
 */
import type { LiveTvChannel, LiveTvProgramme } from "@/lib/mmo/media-types";

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
export const SLOT_MIN = 30;

export interface TimeWindow { from: number; to: number }

// ─── time ────────────────────────────────────────────────────────────────

/** Local-time offset in ms for `ms` (east of UTC positive). `tzOffsetMin` = `Date#getTimezoneOffset()` override for tests. */
function localOffset(ms: number, tzOffsetMin?: number): number {
    return -(tzOffsetMin ?? new Date(ms).getTimezoneOffset()) * MIN;
}

/** Floors to the slot boundary in local time (30-min slots stay on :00/:30 even in +05:30 zones). */
export function floorToSlot(ms: number, slotMin = SLOT_MIN, tzOffsetMin?: number): number {
    const off = localOffset(ms, tzOffsetMin);
    const size = slotMin * MIN;
    return Math.floor((ms + off) / size) * size - off;
}

/** Local midnight of the day `offset` days from `now`. */
export function dayStart(now: number, offset = 0, tzOffsetMin?: number): number {
    const off = localOffset(now, tzOffsetMin);
    return Math.floor((now + off) / DAY) * DAY - off + offset * DAY;
}

/**
 * Guide window for a day picker entry: the whole local day (server caps 48 h), but "today" starts one slot
 * before now's slot so the first screen is useful without scrolling back from midnight.
 */
export function guideWindow(now: number, dayOffset: number, tzOffsetMin?: number): TimeWindow {
    const start = dayStart(now, dayOffset, tzOffsetMin);
    const end = start + DAY;
    if (dayOffset !== 0) return { from: start, to: end };
    return { from: Math.max(start, floorToSlot(now, SLOT_MIN, tzOffsetMin) - SLOT_MIN * MIN), to: end };
}

/** Day picker offsets: back as far as the longest catch-up archive (max 7), forward `forward` days. */
export function dayOffsets(maxArchiveDays: number, forward = 1): number[] {
    const back = Math.max(0, Math.min(7, Math.floor(maxArchiveDays)));
    const out: number[] = [];
    for (let d = -back; d <= forward; d++) out.push(d === 0 ? 0 : d);
    return out;
}

/** Slot start times inside the window (first tick = first boundary ≥ from). */
export function slotTicks(w: TimeWindow, slotMin = SLOT_MIN, tzOffsetMin?: number): number[] {
    const size = slotMin * MIN;
    let t = floorToSlot(w.from, slotMin, tzOffsetMin);
    if (t < w.from) t += size;
    const out: number[] = [];
    for (; t < w.to; t += size) out.push(t);
    return out;
}

export function xOf(t: number, w: TimeWindow, pxPerMin: number): number {
    return ((t - w.from) / MIN) * pxPerMin;
}

/** Now line x in px, or null when `now` is outside the window. */
export function nowLineX(now: number, w: TimeWindow, pxPerMin: number): number | null {
    if (now < w.from || now > w.to) return null;
    return xOf(now, w, pxPerMin);
}

export function gridWidth(w: TimeWindow, pxPerMin: number): number {
    return xOf(w.to, w, pxPerMin);
}

/** 0..1 progress of a programme at `now`. */
export function progressOf(p: Pick<LiveTvProgramme, "start" | "stop"> | null | undefined, now: number): number {
    if (!p || p.stop <= p.start) return 0;
    return Math.max(0, Math.min(1, (now - p.start) / (p.stop - p.start)));
}

export function isAiring(p: Pick<LiveTvProgramme, "start" | "stop">, now: number): boolean {
    return p.start <= now && now < p.stop;
}

// ─── EPG layout ──────────────────────────────────────────────────────────

export interface EpgCell {
    /** Null = gap without guide data (still focusable so arrows never get stuck). */
    prog: LiveTvProgramme | null;
    start: number;
    stop: number;
    left: number;
    width: number;
}

/**
 * Lays out one channel row: programmes clipped to the window, overlaps trimmed (later start wins),
 * gaps ≥ 1 min become empty cells, so the cells always tile [from, to) exactly.
 */
export function layoutRow(progs: readonly LiveTvProgramme[], w: TimeWindow, pxPerMin: number): EpgCell[] {
    const sorted = progs.filter((p) => p.stop > w.from && p.start < w.to && p.stop > p.start).slice().sort((a, b) => a.start - b.start);
    const cells: EpgCell[] = [];
    let cursor = w.from;
    const push = (prog: LiveTvProgramme | null, start: number, stop: number) => {
        if (stop - start < MIN && prog === null) return;
        if (stop <= start) return;
        cells.push({ prog, start, stop, left: xOf(start, w, pxPerMin), width: ((stop - start) / MIN) * pxPerMin });
    };
    for (const p of sorted) {
        const start = Math.max(p.start, cursor);
        const stop = Math.min(p.stop, w.to);
        if (stop <= cursor) continue;
        if (start > cursor) push(null, cursor, start);
        push(p, start, stop);
        cursor = stop;
    }
    if (cursor < w.to) push(null, cursor, w.to);
    return cells;
}

/** Index of the cell covering `t` (nearest when none covers it), -1 for an empty row. */
export function cellIndexAt(cells: readonly EpgCell[], t: number): number {
    if (!cells.length) return -1;
    for (let i = 0; i < cells.length; i++) if (cells[i]!.start <= t && t < cells[i]!.stop) return i;
    return t < cells[0]!.start ? 0 : cells.length - 1;
}

/** Which programme a catch-up / record action can target. */
export function canCatchup(ch: Pick<LiveTvChannel, "catchup" | "archiveDays">, p: Pick<LiveTvProgramme, "start">, now: number): boolean {
    return ch.catchup && ch.archiveDays > 0 && p.start < now && p.start >= now - ch.archiveDays * DAY;
}

export function canRecord(p: Pick<LiveTvProgramme, "stop">, now: number): boolean {
    return p.stop > now;
}

export function durationMin(p: Pick<LiveTvProgramme, "start" | "stop">): number {
    return Math.max(1, Math.ceil((p.stop - p.start) / MIN));
}

// ─── virtual rows ────────────────────────────────────────────────────────

export interface RowRange { start: number; end: number }

/** Visible [start, end) rows for a fixed row height, with overscan on both sides. */
export function visibleRange(scrollTop: number, viewportH: number, rowH: number, count: number, overscan = 6): RowRange {
    if (count <= 0 || rowH <= 0) return { start: 0, end: 0 };
    const first = Math.floor(Math.max(0, scrollTop) / rowH);
    const last = Math.ceil((Math.max(0, scrollTop) + Math.max(0, viewportH)) / rowH);
    return { start: Math.max(0, first - overscan), end: Math.min(count, last + overscan) };
}

/** scrollTop needed so row `i` is fully visible (unchanged when it already is). */
export function scrollToRow(i: number, scrollTop: number, viewportH: number, rowH: number, headerH = 0): number {
    const top = i * rowH;
    const bottom = top + rowH;
    const visTop = scrollTop;
    const visBottom = scrollTop + viewportH - headerH;
    if (top < visTop) return top;
    if (bottom > visBottom) return bottom - (viewportH - headerH);
    return scrollTop;
}

/** scrollLeft so [left, left+width) is visible past a sticky column of `stickyW`. */
export function scrollToX(left: number, width: number, scrollLeft: number, viewportW: number, stickyW = 0): number {
    const avail = viewportW - stickyW;
    if (left < scrollLeft) return left;
    if (left + Math.min(width, avail) > scrollLeft + avail) return left + Math.min(width, avail) - avail;
    return scrollLeft;
}

// ─── channel list ────────────────────────────────────────────────────────

export interface ChannelFilterState {
    query: string;
    /** "" = all, FAV_GROUP = favourites only, else group name. */
    group: string;
    favouritesFirst: boolean;
}

export const FAV_GROUP = "\u0000fav";

/** Accent/case-insensitive fold for search (Ș/ş → s). */
export function fold(s: string): string {
    return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

export function filterChannels(channels: readonly LiveTvChannel[], f: ChannelFilterState): LiveTvChannel[] {
    const q = fold(f.query.trim());
    let out = channels.filter((c) => {
        if (f.group === FAV_GROUP ? !c.favourite : f.group && (c.group ?? "") !== f.group) return false;
        if (!q) return true;
        return fold(c.name).includes(q) || (c.number ?? "").startsWith(q) || fold(c.group ?? "").includes(q);
    });
    if (f.favouritesFirst) {
        // Stable partition: favourites keep their order, then the rest.
        out = [...out.filter((c) => c.favourite), ...out.filter((c) => !c.favourite)];
    }
    return out;
}

// ─── zapping ─────────────────────────────────────────────────────────────

/** Wrapped neighbour index (d = +1 next, −1 previous); -1 when the list has < 2 items or i is unknown. */
export function neighbourIndex(len: number, i: number, d: number): number {
    if (len < 2 || i < 0 || i >= len) return -1;
    return (((i + d) % len) + len) % len;
}

export const DIGIT_MAX = 4;
export const DIGIT_COMMIT_MS = 1500;

/** Appends a digit to the number-entry buffer; returns the buffer and whether it should commit now. */
export function pushDigit(buf: string, digit: string, maxLen = DIGIT_MAX): { buf: string; commit: boolean } {
    if (!/^\d$/.test(digit)) return { buf, commit: false };
    const next = (buf + digit).slice(-maxLen);
    return { buf: next, commit: next.length >= maxLen };
}

/** Channel for a typed number: exact `number`, then numeric equality ("07" = "7"), then 1-based position. */
export function channelByNumber<T extends Pick<LiveTvChannel, "number">>(channels: readonly T[], value: string): T | null {
    if (!value) return null;
    const exact = channels.find((c) => (c.number ?? "") === value);
    if (exact) return exact;
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    const numeric = channels.find((c) => c.number != null && c.number !== "" && Number(c.number) === n);
    if (numeric) return numeric;
    return channels[n - 1] ?? null;
}

/** Ids of the channels at offsets around `i` (wrapped, unique) — for now/next prefetch and the mini strip. */
export function aroundIds<T extends { id: string }>(list: readonly T[], i: number, radius = 2): string[] {
    if (i < 0 || !list.length) return [];
    const ids: string[] = [];
    for (let d = -radius; d <= radius; d++) {
        const c = list[(((i + d) % list.length) + list.length) % list.length];
        if (c && !ids.includes(c.id)) ids.push(c.id);
    }
    return ids;
}

/** Splits ids into chunks for `/livetv/now` and `/livetv/guide` (keeps URLs short). */
export function chunk<T>(xs: readonly T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
    return out;
}

/** Parses `?start=<ms>&dur=<min>` for catch-up playback (null when absent/invalid). */
export function parseCatchup(start: string | null, dur: string | null): { start: number; dur: number } | null {
    const s = Number(start);
    const d = Number(dur);
    if (!start || !dur || !Number.isFinite(s) || !Number.isFinite(d) || s <= 0 || d <= 0 || d > 1440) return null;
    return { start: Math.floor(s), dur: Math.ceil(d) };
}
