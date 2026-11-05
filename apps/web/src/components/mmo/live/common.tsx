"use client";

/**
 * Shared Live TV bits (WP16-41): locale time formatters (24 h in RO), the section sub-nav, channel logo,
 * progress bar, the `now` ticker, now/next fetching and error-message extraction.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import { CalendarClock, Disc3, LayoutList, Settings2 } from "lucide-react";
import type { LiveTvChannel, LiveTvNowNext } from "@/lib/mmo/media-types";
import type { LiveTvClient } from "@/lib/mmo/livetv";
import { chunk } from "./live-logic";

export function useLiveFormat() {
    const locale = useLocale();
    return useMemo(() => {
        const h23 = locale.startsWith("ro") ? ({ hourCycle: "h23" } as const) : {};
        const time = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", ...h23 });
        const day = new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short" });
        const dateTime = new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", ...h23 });
        const rel = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
        return {
            locale,
            time: (ms: number) => time.format(ms),
            range: (a: number, b: number) => `${time.format(a)}–${time.format(b)}`,
            day: (ms: number) => day.format(ms),
            dateTime: (ms: number) => dateTime.format(ms),
            relDay: (offset: number) => rel.format(offset, "day"),
        };
    }, [locale]);
}

/** Re-renders every `everyMs` with the current time (progress bars, now line). */
export function useNow(everyMs = 30_000): number {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const id = setInterval(() => setNow(Date.now()), everyMs);
        return () => clearInterval(id);
    }, [everyMs]);
    return now;
}

const SUBNAV = [
    { key: "channels", href: "/media/live", icon: LayoutList, exact: true },
    { key: "guide", href: "/media/live/guide", icon: CalendarClock },
    { key: "recordings", href: "/media/live/recordings", icon: Disc3 },
    { key: "sources", href: "/media/live/sources", icon: Settings2 },
] as const;

export function LiveSubnav() {
    const t = useTranslations("mx.live.nav");
    const pathname = usePathname() ?? "";
    return (
        <nav aria-label={t("label")} className="lv-subnav">
            {SUBNAV.map((n) => {
                const active = "exact" in n && n.exact ? pathname === n.href : pathname === n.href || pathname.startsWith(n.href + "/");
                const Icon = n.icon;
                return (
                    <Link key={n.key} href={n.href} aria-current={active ? "page" : undefined} className="lv-subnav-link">
                        <Icon aria-hidden className="size-4" />
                        <span>{t(n.key)}</span>
                    </Link>
                );
            })}
        </nav>
    );
}

export function LiveHeader({ title, actions }: { title: string; actions?: ReactNode }) {
    return (
        <div className="mx-page-head lv-head">
            <div className="lv-head-row">
                <h1 className="mx-page-title">{title}</h1>
                {actions ? <div className="lv-head-actions">{actions}</div> : null}
            </div>
            <LiveSubnav />
        </div>
    );
}

export function ChannelLogo({ channel, livetv, size = "md" }: { channel: Pick<LiveTvChannel, "logo" | "name" | "number">; livetv: LiveTvClient; size?: "sm" | "md" | "lg" }) {
    const [failed, setFailed] = useState(false);
    const src = livetv.logoUrl(channel);
    const initials = channel.name.replace(/[^\p{L}\p{N} ]/gu, "").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
    return (
        <span className={`lv-logo lv-logo-${size}`} aria-hidden>
            {src && !failed
                // eslint-disable-next-line @next/next/no-img-element -- upstream IPTV logos (arbitrary hosts, not in images.remotePatterns)
                ? <img src={src} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
                : <span>{initials || channel.number || "TV"}</span>}
        </span>
    );
}

export function Progress({ value, label }: { value: number; label?: string }) {
    const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
    return (
        <span className="lv-progress" role={label ? "progressbar" : undefined} aria-label={label} aria-valuenow={label ? pct : undefined} aria-valuemin={label ? 0 : undefined} aria-valuemax={label ? 100 : undefined}>
            <span style={{ transform: `scaleX(${pct / 100})` }} />
        </span>
    );
}

export function LiveDot({ label }: { label: string }) {
    return <span className="lv-live-dot"><span aria-hidden />{label}</span>;
}

/** `/livetv/now` for many channels (chunks of 150 ids), merged into one map. */
export async function fetchNowNext(livetv: LiveTvClient, ids: readonly string[]): Promise<Map<string, LiveTvNowNext>> {
    const out = new Map<string, LiveTvNowNext>();
    if (!ids.length) return out;
    const parts = await Promise.all(chunk(ids, 150).map((c) => livetv.now(c).catch(() => ({ now: Date.now(), channels: [] as LiveTvNowNext[] }))));
    for (const p of parts) for (const n of p.channels) out.set(n.channelId, n);
    return out;
}

/** Now/next for `ids`, refreshed every minute and when a programme ends. */
export function useNowNext(livetv: LiveTvClient | null, ids: readonly string[]): Map<string, LiveTvNowNext> {
    const [map, setMap] = useState<Map<string, LiveTvNowNext>>(new Map());
    const key = ids.join(",");
    useEffect(() => {
        if (!livetv || !key) return;
        let alive = true;
        const list = key.split(",");
        const load = () => void fetchNowNext(livetv, list).then((m) => {
            if (!alive) return;
            setMap((cur) => { const o = new Map(cur); m.forEach((v, k) => o.set(k, v)); return o; });
        });
        load();
        const id = setInterval(load, 60_000);
        return () => { alive = false; clearInterval(id); };
    }, [livetv, key]);
    return map;
}

export function errorText(e: unknown): string {
    if (e instanceof Error && e.message) return e.message;
    return String(e);
}

/** Recording / VOD file URL on the MMO Server (`/video/stream/:fileId` HLS remux, `?t=&u=` auth). */
export function videoStreamUrl(cfg: { baseUrl: string; token: string; userId: string }, fileId: string): string {
    const q = new URLSearchParams({ t: cfg.token });
    if (cfg.userId) q.set("u", cfg.userId);
    return `${cfg.baseUrl}/video/stream/${encodeURIComponent(fileId)}?${q.toString()}`;
}
