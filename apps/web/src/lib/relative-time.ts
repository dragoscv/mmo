/** Locale-aware "3 minutes ago" via Intl.RelativeTimeFormat (no date-fns dependency). */
export function formatRelativeTime(iso: string | Date | null | undefined, locale: string, now: number = Date.now()): string | null {
    if (!iso) return null;
    const ts = typeof iso === "string" ? Date.parse(iso) : iso.getTime();
    if (Number.isNaN(ts)) return null;
    const diffSec = Math.round((ts - now) / 1000);
    const abs = Math.abs(diffSec);
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
    if (abs < 60) return rtf.format(diffSec, "second");
    if (abs < 3600) return rtf.format(Math.round(diffSec / 60), "minute");
    if (abs < 86_400) return rtf.format(Math.round(diffSec / 3600), "hour");
    if (abs < 86_400 * 30) return rtf.format(Math.round(diffSec / 86_400), "day");
    if (abs < 86_400 * 365) return rtf.format(Math.round(diffSec / (86_400 * 30)), "month");
    return rtf.format(Math.round(diffSec / (86_400 * 365)), "year");
}
