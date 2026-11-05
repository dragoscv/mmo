/**
 * Pure player helpers (no DOM): scrubber sprite mapping, hold-to-seek acceleration, track picking from
 * profile prefs, "ends at" clock. Mirrors tv-android `player/PlayerData.kt`.
 */
import type { ProbedVideo } from "../../lib/api";
// `.ts` extension: node --experimental-strip-types runs this file in tests (model.test.mjs).
import { normLang, type PlayerPrefs } from "./prefs.ts";

// ─── scrubber sprite (server/src/library/video-routes.ts ensureSprite) ─────

export const SPRITE_GRID = 12;
export const TILE_W = 160;
export const TILE_H = 90;

/** Server mapping: interval = max(2, ceil(duration / 144)) s, cells = min(144, ceil(duration / interval)). */
export interface SpriteGrid { intervalSec: number; cells: number }

export function spriteGrid(durationSec: number): SpriteGrid | null {
    if (!(durationSec >= 30)) return null;
    const target = SPRITE_GRID * SPRITE_GRID;
    const intervalSec = Math.max(2, Math.ceil(durationSec / target));
    const cells = Math.max(1, Math.min(target, Math.ceil(durationSec / intervalSec)));
    return { intervalSec, cells };
}

/** Tile i covers [i·interval, (i+1)·interval). */
export function spriteTile(g: SpriteGrid, positionSec: number): number {
    return Math.max(0, Math.min(g.cells - 1, Math.floor(Math.max(0, positionSec) / g.intervalSec)));
}

/** CSS `background-position` (percent form, scales with any rendered tile size; size must be 1200% 1200%). */
export function tilePosition(tile: number): string {
    const col = tile % SPRITE_GRID;
    const row = Math.floor(tile / SPRITE_GRID);
    const pct = (n: number) => `${(n / (SPRITE_GRID - 1)) * 100}%`;
    return `${pct(col)} ${pct(row)}`;
}

// ─── hold-to-seek acceleration ──────────────────────────────────────────────

/** Repeats closer than this belong to the same hold. */
export const HOLD_GAP_MS = 450;

/** 10 s for the first presses, then 30 s, then 60 s while the key stays down. */
export function seekStep(holdCount: number): number {
    if (holdCount < 4) return 10;
    if (holdCount < 12) return 30;
    return 60;
}

// ─── tracks ─────────────────────────────────────────────────────────────────

/** Audio track (ordinal in `audioTracks`) for the preferred language; 0 = file default. */
export function pickAudio(v: ProbedVideo, prefs: PlayerPrefs): number {
    const want = normLang(prefs.audioLang);
    if (!want) return 0;
    const i = v.audioTracks.findIndex((a) => normLang(a.lang) === want);
    return i >= 0 ? i : 0;
}

/**
 * Subtitle track (index in `subtitleTracks`) or -1:
 *  - forced-only → a forced track (preferring the audio language), else off;
 *  - preferred language → first non-forced track in it (forced one as fallback);
 *  - no preference → a forced track when the file has one (signs / foreign dialogue), else off.
 */
export function pickSubtitle(v: ProbedVideo, prefs: PlayerPrefs, audioIdx: number): number {
    const subs = v.subtitleTracks;
    if (subs.length === 0) return -1;
    const audioLang = normLang(v.audioTracks[audioIdx]?.lang);
    const forcedIn = (lang: string) => subs.findIndex((s) => s.forced && (!lang || normLang(s.lang) === lang));
    if (prefs.subForcedOnly) {
        const a = forcedIn(audioLang);
        return a >= 0 ? a : forcedIn("");
    }
    const want = normLang(prefs.subLang);
    if (want) {
        const full = subs.findIndex((s) => !s.forced && normLang(s.lang) === want);
        if (full >= 0) return full;
        const forced = forcedIn(want);
        if (forced >= 0) return forced;
    }
    return forcedIn("");
}

/** Subtitle indices for the panel: forced tracks first, then the rest in file order. */
export function subtitleOrder(v: ProbedVideo): number[] {
    const idx = v.subtitleTracks.map((_, i) => i);
    return [...idx.filter((i) => v.subtitleTracks[i]!.forced), ...idx.filter((i) => !v.subtitleTracks[i]!.forced)];
}

// ─── clock / formatting ─────────────────────────────────────────────────────

/** Wall-clock end time "HH:MM" for the remaining media time at `rate`. */
export function endsAt(remainingSec: number, rate: number, now = Date.now()): string {
    const d = new Date(now + Math.max(0, remainingSec) / (rate > 0 ? rate : 1) * 1000);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function channelsLabel(ch: number): string {
    if (ch >= 8) return "7.1";
    if (ch >= 6) return "5.1";
    if (ch === 2) return "2.0";
    if (ch === 1) return "1.0";
    return `${ch}ch`;
}

export function resolutionLabel(w: number | null, h: number | null): string {
    if (!w || !h) return "";
    if (w >= 3800 || h >= 2100) return `2160p (${w}×${h})`;
    if (w >= 1900 || h >= 1060) return `1080p (${w}×${h})`;
    if (w >= 1260 || h >= 700) return `720p (${w}×${h})`;
    return `${h}p (${w}×${h})`;
}

/** Average bitrate from file size / duration, "12.3 Mb/s". */
export function bitrateLabel(sizeBytes: number, durationSec: number | null): string {
    if (!durationSec || durationSec <= 0 || !sizeBytes) return "";
    return `${((sizeBytes * 8) / durationSec / 1e6).toFixed(1)} Mb/s`;
}
