export function fmtDuration(sec: number | null | undefined): string | null {
    if (sec == null || !Number.isFinite(sec)) return null;
    const s = Math.max(0, Math.floor(sec));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
}

export function fmtClock(sec: number): string {
    return fmtDuration(sec) ?? "0:00";
}
