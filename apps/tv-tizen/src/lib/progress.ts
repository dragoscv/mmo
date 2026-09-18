/**
 * Resume positions, per TV (localStorage — not synced to the server).
 * `mixai-tv:progress` = { [fileId]: { pos, dur, at } } (seconds, seconds, epoch ms).
 */
export interface Progress {
    pos: number;
    dur: number;
    at: number;
}

const KEY = "mixai-tv:progress";
/** Positions below this are "not started" and never stored. */
export const MIN_RESUME_SEC = 10;
/** Past this fraction the entry is deleted (finished). */
export const FINISHED_RATIO = 0.95;
/** Minimum gap between two writes for the same file (timeupdate throttle). */
export const WRITE_INTERVAL_MS = 5000;

const lastWrite = new Map<string, number>();

function readAll(): Record<string, Progress> {
    try {
        const raw = localStorage.getItem(KEY);
        const j = raw ? (JSON.parse(raw) as unknown) : null;
        return j && typeof j === "object" ? (j as Record<string, Progress>) : {};
    } catch {
        return {};
    }
}

function writeAll(all: Record<string, Progress>): void {
    try {
        if (Object.keys(all).length === 0) localStorage.removeItem(KEY);
        else localStorage.setItem(KEY, JSON.stringify(all));
    } catch { /* storage full/disabled */ }
}

export function getProgress(fileId: string): Progress | null {
    const p = readAll()[fileId];
    return p && Number.isFinite(p.pos) && p.pos >= MIN_RESUME_SEC ? p : null;
}

export function allProgress(): Array<{ fileId: string } & Progress> {
    return Object.entries(readAll())
        .filter(([, p]) => Number.isFinite(p.pos) && p.pos >= MIN_RESUME_SEC)
        .map(([fileId, p]) => ({ fileId, ...p }))
        .sort((a, b) => b.at - a.at);
}

/**
 * Persist a position. `force` bypasses the 5 s throttle (pause / exit).
 * Positions < 10 s are ignored; ≥ 95 % of the duration deletes the entry.
 */
export function setProgress(fileId: string, pos: number, dur: number, force = false): void {
    if (!Number.isFinite(pos) || pos < MIN_RESUME_SEC) return;
    const now = Date.now();
    if (!force) {
        const last = lastWrite.get(fileId) ?? 0;
        if (now - last < WRITE_INTERVAL_MS) return;
    }
    lastWrite.set(fileId, now);
    const all = readAll();
    if (Number.isFinite(dur) && dur > 0 && pos / dur > FINISHED_RATIO) {
        delete all[fileId];
    } else {
        all[fileId] = { pos: Math.floor(pos), dur: Number.isFinite(dur) ? Math.floor(dur) : 0, at: now };
    }
    writeAll(all);
}

export function clearProgress(): void {
    lastWrite.clear();
    try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}

/** 0..100 for a progress bar, or null when nothing is saved. */
export function progressPct(fileId: string, fallbackDur?: number | null): number | null {
    const p = getProgress(fileId);
    if (!p) return null;
    const dur = p.dur > 0 ? p.dur : (fallbackDur ?? 0);
    if (dur <= 0) return null;
    return Math.max(0, Math.min(100, (p.pos / dur) * 100));
}
