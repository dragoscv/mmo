/**
 * Daily watch/listen minutes per profile (WP16-50: family stats + kids screen-time caps).
 *
 * `progress` keeps only the last position per title, so minutes cannot be derived from it after the
 * fact. Every progress write instead adds the *advance* since the previous write of the same row to
 * `usage_daily` (local calendar day of the server): forward movement no larger than the wall time that
 * passed (×1.5 + 30 s slack for clock skew / 2× speed), capped at 30 min per write. Seeks and resumes
 * on another device therefore never count as watching. Music plays add their `durationSec`.
 */

import type { MediaDb } from "./db";

export const MAX_ADVANCE_SEC = 30 * 60;
export const FIRST_WRITE_MAX_SEC = 5 * 60;
export const KID_CAP_ERROR = "daily_cap";

/** `YYYY-MM-DD` of `t` in the server's local time zone. */
export function localDay(t: number): string {
    const d = new Date(t);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Seconds of real watching between two progress writes of one row (0 for seeks/resumes). */
export function watchAdvance(prev: { positionSec: number; updatedAt: number } | null, next: { positionSec: number; updatedAt: number }): number {
    if (!prev) return Math.max(0, Math.min(FIRST_WRITE_MAX_SEC, next.positionSec));
    const delta = next.positionSec - prev.positionSec;
    const wallSec = (next.updatedAt - prev.updatedAt) / 1000;
    if (delta <= 0 || wallSec <= 0) return 0;
    if (delta > wallSec * 1.5 + 30) return 0;
    return Math.min(MAX_ADVANCE_SEC, delta);
}

export function addUsage(db: MediaDb, profileId: string, at: number, watchSec: number, listenSec: number): void {
    if (!(watchSec > 0) && !(listenSec > 0)) return;
    db.prepare(
        `INSERT INTO usage_daily (profile_id, day, watch_sec, listen_sec) VALUES (?, ?, ?, ?)
         ON CONFLICT(profile_id, day) DO UPDATE SET watch_sec = watch_sec + excluded.watch_sec, listen_sec = listen_sec + excluded.listen_sec`,
    ).run(profileId, localDay(at), Math.max(0, watchSec || 0), Math.max(0, listenSec || 0));
}

export function usageOn(db: MediaDb, profileId: string, day: string): { watchSec: number; listenSec: number } {
    const r = db.prepare("SELECT watch_sec, listen_sec FROM usage_daily WHERE profile_id = ? AND day = ?").get(profileId, day) as
        { watch_sec: number; listen_sec: number } | undefined;
    return { watchSec: r?.watch_sec ?? 0, listenSec: r?.listen_sec ?? 0 };
}

/** Last `days` local days ending today, oldest first. */
export function lastDays(now: number, days: number): string[] {
    const out: string[] = [];
    const d = new Date(now);
    for (let i = days - 1; i >= 0; i--) {
        const x = new Date(d.getFullYear(), d.getMonth(), d.getDate() - i, 12);
        out.push(localDay(x.getTime()));
    }
    return out;
}

export interface WeeklyUsage { profileId: string; days: string[]; watchMin: number[]; listenMin: number[]; totalWatchMin: number; totalListenMin: number }

export function weeklyUsage(db: MediaDb, profileId: string, now: number): WeeklyUsage {
    const days = lastDays(now, 7);
    const rows = db.prepare(`SELECT day, watch_sec, listen_sec FROM usage_daily WHERE profile_id = ? AND day >= ? AND day <= ?`)
        .all(profileId, days[0], days[days.length - 1]) as { day: string; watch_sec: number; listen_sec: number }[];
    const byDay = new Map(rows.map((r) => [r.day, r]));
    const watchMin = days.map((d) => Math.round((byDay.get(d)?.watch_sec ?? 0) / 60));
    const listenMin = days.map((d) => Math.round((byDay.get(d)?.listen_sec ?? 0) / 60));
    return {
        profileId, days, watchMin, listenMin,
        totalWatchMin: watchMin.reduce((a, b) => a + b, 0), totalListenMin: listenMin.reduce((a, b) => a + b, 0),
    };
}

/** `prefs.dailyCapMin` as a positive integer, else null (no cap). */
export function dailyCapOf(prefs: Record<string, unknown> | undefined): number | null {
    const v = prefs?.dailyCapMin;
    const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : Number.NaN;
    return Number.isFinite(n) && n > 0 ? Math.min(24 * 60, Math.round(n)) : null;
}

export interface CapStatus {
    profileId: string;
    day: string;
    watchMin: number;
    listenMin: number;
    dailyCapMin: number | null;
    remainingMin: number | null;
    overCap: boolean;
    /** Caps apply to kid profiles only. */
    enforced: boolean;
}

export function capStatus(db: MediaDb, profile: { id: string; kind: string; prefs: Record<string, unknown> } | null, profileId: string, now: number): CapStatus {
    const day = localDay(now);
    const u = usageOn(db, profileId, day);
    const cap = profile ? dailyCapOf(profile.prefs) : null;
    const enforced = Boolean(profile && profile.kind === "kid" && cap !== null);
    const watchMin = Math.floor(u.watchSec / 60);
    return {
        profileId, day, watchMin, listenMin: Math.floor(u.listenSec / 60), dailyCapMin: cap,
        remainingMin: cap === null ? null : Math.max(0, cap - watchMin),
        overCap: enforced && cap !== null && watchMin >= cap,
        enforced,
    };
}
