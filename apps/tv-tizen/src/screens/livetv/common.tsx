/**
 * Live TV shared bits (WP16-34): time formatting, now/next cache, channel logo, cross-screen hand-offs
 * (zap group, catch-up request) and the virtual vertical list used by the channel list.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { LiveTvClient } from "../../lib/livetv";
import type { LiveTvChannel, LiveTvNowNext, LiveTvProgramme } from "../../lib/media-types";
import { remPx } from "../../lib/image";
import { Icon } from "../../ui";
import "./livetv.css";

export const MIN = 60_000;
export const HOUR = 60 * MIN;

export function hhmm(ms: number, lang: string): string {
    try {
        return new Date(ms).toLocaleTimeString(lang === "ro" ? "ro-RO" : "en-GB", { hour: "2-digit", minute: "2-digit" });
    } catch {
        const d = new Date(ms);
        return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    }
}

export function dayLabel(ms: number, lang: string): string {
    try {
        return new Date(ms).toLocaleDateString(lang === "ro" ? "ro-RO" : "en-GB", { weekday: "short", day: "numeric", month: "short" });
    } catch {
        return new Date(ms).toDateString();
    }
}

export function progressOf(p: LiveTvProgramme | null | undefined, now = Date.now()): number {
    if (!p || p.stop <= p.start) return 0;
    return Math.max(0, Math.min(1, (now - p.start) / (p.stop - p.start)));
}

// ─── now/next cache (shared by list, player banner, mini-guide) ─────────────

const nowCache = new Map<string, { at: number; v: LiveTvNowNext }>();
const NOW_TTL = 60_000;

/** Returns cached entries immediately; fetches the stale/missing ones (one request) and resolves them. */
export async function fetchNowNext(client: LiveTvClient, ids: string[]): Promise<Map<string, LiveTvNowNext>> {
    const t = Date.now();
    const need = ids.filter((id) => {
        const c = nowCache.get(id);
        return !c || t - c.at > NOW_TTL || (c.v.now && c.v.now.stop <= t);
    });
    if (need.length > 0) {
        for (let i = 0; i < need.length; i += 80) {
            const part = need.slice(i, i + 80);
            const r = await client.now(part).catch(() => null);
            const got = new Set<string>();
            for (const nn of r?.channels ?? []) { nowCache.set(nn.channelId, { at: t, v: nn }); got.add(nn.channelId); }
            for (const id of part) if (!got.has(id)) nowCache.set(id, { at: t, v: { channelId: id, now: null, next: null } });
        }
    }
    const out = new Map<string, LiveTvNowNext>();
    for (const id of ids) { const c = nowCache.get(id); if (c) out.set(id, c.v); }
    return out;
}

export function cachedNowNext(id: string): LiveTvNowNext | null { return nowCache.get(id)?.v ?? null; }

// ─── hand-offs between Live TV screens ──────────────────────────────────────

let zapGroup: string | null = null;
/** Group selected in the channel list; LivePlay zaps within it. */
export function setZapGroup(g: string | null): void { zapGroup = g; }
export function getZapGroup(): string | null { return zapGroup; }

export interface CatchupRequest { channelId: string; url: string; title: string; start: number; stop: number }
let pendingCatchup: CatchupRequest | null = null;
/** Guide → LivePlay: play this catch-up URL instead of live (consumed once, matched by channel id). */
export function requestCatchup(r: CatchupRequest): void { pendingCatchup = r; }
export function takeCatchup(channelId: string): CatchupRequest | null {
    const r = pendingCatchup;
    pendingCatchup = null;
    return r && r.channelId === channelId ? r : null;
}

// ─── visuals ────────────────────────────────────────────────────────────────

export function ChannelLogo({ client, channel, size = "2.6rem" }: { client: LiveTvClient; channel: LiveTvChannel; size?: string }) {
    const url = client.logoUrl(channel);
    const [bad, setBad] = useState(false);
    return (
        <span className="lt-logo" style={{ width: size, height: size }} aria-hidden="true">
            {url && !bad ? <img src={url} alt="" loading="lazy" decoding="async" onError={() => setBad(true)} />
                : <span className="lt-logo-ph">{(channel.name.trim()[0] ?? "?").toUpperCase()}</span>}
        </span>
    );
}

export function Progress({ value }: { value: number }) {
    return <span className="lt-prog"><span style={{ transform: `scaleX(${value})` }} /></span>;
}

export function LiveDot() {
    return <span className="lt-live-dot" aria-hidden="true"><Icon name="record" /></span>;
}

// ─── vertical virtual list (fixed row height, own scroll offset via transform) ─

export interface VListProps<T> {
    listId: string;
    items: T[];
    rowRem: number;
    itemKey: (item: T, i: number) => string;
    renderItem: (item: T, i: number) => ReactNode;
    /** Index that has focus (keeps it in view). */
    focusIndex: number;
    onRange?: (from: number, to: number) => void;
    className?: string;
}

export function VList<T>({ listId, items, rowRem, itemKey, renderItem, focusIndex, onRange, className }: VListProps<T>) {
    const box = useRef<HTMLDivElement>(null);
    const [h, setH] = useState(0);
    const [first, setFirst] = useState(0);
    useLayoutEffect(() => {
        const el = box.current;
        if (!el) return;
        const m = () => setH(el.clientHeight);
        m();
        window.addEventListener("resize", m);
        return () => window.removeEventListener("resize", m);
    }, []);
    const rowPx = Math.max(1, remPx(rowRem));
    const visible = Math.max(1, Math.floor((h || window.innerHeight * 0.7) / rowPx));
    // Keep the focused row inside [first+1, first+visible-2] so neighbours stay visible.
    useEffect(() => {
        if (focusIndex < 0) return;
        let f = first;
        if (focusIndex < f + 1) f = Math.max(0, focusIndex - 1);
        else if (focusIndex > f + visible - 2) f = Math.min(Math.max(0, items.length - visible), focusIndex - visible + 2);
        if (f !== first) setFirst(f);
    }, [focusIndex, visible, items.length, first]);
    useEffect(() => { if (first > Math.max(0, items.length - visible)) setFirst(Math.max(0, items.length - visible)); }, [items.length, visible, first]);
    const from = Math.max(0, first - 4);
    const to = Math.min(items.length, first + visible + 4);
    useEffect(() => { onRange?.(from, to); }, [from, to, onRange]);
    const rows: ReactNode[] = [];
    for (let i = from; i < to; i++) {
        const it = items[i]!;
        rows.push(
            <div key={itemKey(it, i)} className="lt-vrow" style={{ transform: `translateY(${i * rowRem}rem)`, height: `${rowRem}rem` }}>
                {renderItem(it, i)}
            </div>,
        );
    }
    return (
        <div ref={box} className={`lt-vlist${className ? ` ${className}` : ""}`} data-focus-noscroll="" data-testid={listId}>
            <div className="lt-vtrack" style={{ transform: `translateY(${-first * rowRem}rem)` }}>{rows}</div>
        </div>
    );
}
