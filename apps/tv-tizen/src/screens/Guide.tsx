/**
 * Guide / EPG (WP16-34): sticky channel column + time ruler, red now-line, programme widths by duration.
 * Rows are virtualised (visible ± 3) and each row renders only programmes intersecting the visible window
 * ± 1 h. Data is fetched in 6 h windows, lazily, for the visible channels only. D-pad moves cell to cell by
 * TIME (↑/↓ keep the focused time, ←/→ go to the previous/next programme and scroll the window). −/+ day
 * (CH−/CH+ or the buttons), Now. OK → details panel: Watch live / Catch-up / Record / Record series.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { t } from "../i18n/messages";
import type { LiveTvChannel, LiveTvProgramme, LiveTvRecording } from "../lib/media-types";
import { remPx } from "../lib/image";
import { keyFromEvent } from "../lib/tv-keys";
import { focusByKey } from "../lib/focus";
import { useScreenActive } from "../nav/Nav";
import type { ScreenProps } from "../nav/ctx";
import { Empty, ErrorState, LoadingBlock, ScreenHeader, SecondaryButton, SidePanel, useBackdrop } from "../ui";
import { ChannelLogo, HOUR, MIN, dayLabel, getZapGroup, hhmm, requestCatchup } from "./livetv/common";

const ROW_REM = 3.6;
const CHAN_REM = 15;
/** rem per minute on the time axis (30 min = 9rem). */
const REM_PER_MIN = 0.3;
const WINDOW_H = 6;
/** Minimum visible span; the real span fills the grid width (2580 px Odyssey → ~6 h). */
const MIN_SPAN_MIN = 150;

interface Win { from: number; to: number }

const floorTo = (ms: number, step: number) => Math.floor(ms / step) * step;

export function Guide({ ctx }: ScreenProps<"guide">) {
    const { livetv, nav, lang } = ctx;
    const active = useScreenActive();
    const backdrop = useBackdrop();
    const [channels, setChannels] = useState<LiveTvChannel[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    /** Left edge of the visible time window (epoch ms). */
    const [viewStart, setViewStart] = useState(() => floorTo(Date.now() - 30 * MIN, 30 * MIN));
    const [firstRow, setFirstRow] = useState(0);
    const [focus, setFocus] = useState<{ row: number; time: number }>({ row: 0, time: Date.now() });
    const [progs, setProgs] = useState<Map<string, LiveTvProgramme[]>>(new Map());
    const loaded = useRef(new Set<string>());
    const [details, setDetails] = useState<{ ch: LiveTvChannel; p: LiveTvProgramme } | null>(null);
    const [recs, setRecs] = useState<LiveTvRecording[]>([]);
    const [toast, setToast] = useState<string | null>(null);
    const [now, setNow] = useState(Date.now());
    const gridRef = useRef<HTMLDivElement>(null);
    const [gridH, setGridH] = useState(0);
    const [gridW, setGridW] = useState(0);

    useEffect(() => { if (active) backdrop.show(null); }, [active, backdrop]);
    useEffect(() => {
        if (!active) return;
        const h = setInterval(() => setNow(Date.now()), 30_000);
        return () => clearInterval(h);
    }, [active]);

    const loadChannels = useCallback(() => {
        setError(null);
        const g = getZapGroup();
        livetv.channels(g ? { group: g } : {}).then(setChannels).catch((e: Error) => setError(e.message));
        livetv.recordings().then(setRecs).catch(() => undefined);
    }, [livetv]);
    useEffect(loadChannels, [loadChannels]);

    useEffect(() => {
        const el = gridRef.current;
        if (!el) return;
        const m = () => { setGridH(el.clientHeight); setGridW(el.clientWidth); };
        m();
        window.addEventListener("resize", m);
        return () => window.removeEventListener("resize", m);
    }, [channels]);

    const rowPx = remPx(ROW_REM);
    const VIEW_SPAN_MIN = Math.max(MIN_SPAN_MIN, Math.floor(((gridW || window.innerWidth * 0.8) / remPx(1) - CHAN_REM - 0.6) / REM_PER_MIN / 30) * 30);
    const visibleRows = Math.max(1, Math.floor(((gridH || window.innerHeight * 0.6) - remPx(1.8)) / rowPx));
    const list = channels ?? [];

    // Keep focus row on screen.
    useEffect(() => {
        let f = firstRow;
        if (focus.row < f) f = focus.row;
        else if (focus.row > f + visibleRows - 1) f = focus.row - visibleRows + 1;
        if (f !== firstRow) setFirstRow(Math.max(0, f));
    }, [focus.row, visibleRows, firstRow]);

    const rowFrom = Math.max(0, firstRow - 3);
    const rowTo = Math.min(list.length, firstRow + visibleRows + 3);
    const viewEnd = viewStart + VIEW_SPAN_MIN * MIN;

    // Lazy 6 h windows for the visible rows (window ± 1 h covered).
    useEffect(() => {
        if (list.length === 0) return;
        const ids = list.slice(rowFrom, rowTo).map((c) => c.id);
        const wins: Win[] = [];
        const step = WINDOW_H * HOUR;
        for (let w = floorTo(viewStart - HOUR, step); w < viewEnd + HOUR; w += step) wins.push({ from: w, to: w + step });
        for (const w of wins) {
            const need = ids.filter((id) => !loaded.current.has(`${id}@${w.from}`));
            if (need.length === 0) continue;
            for (const id of need) loaded.current.add(`${id}@${w.from}`);
            void livetv.guide({ from: w.from, to: w.to, channels: need }).then((r) => {
                setProgs((cur) => {
                    const out = new Map(cur);
                    const byCh = new Map<string, LiveTvProgramme[]>();
                    for (const p of r.programmes) { const a = byCh.get(p.channelId) ?? []; a.push(p); byCh.set(p.channelId, a); }
                    byCh.forEach((arr, id) => {
                        const merged = [...(out.get(id) ?? []), ...arr];
                        const seen = new Set<number>();
                        out.set(id, merged.filter((p) => (seen.has(p.start) ? false : (seen.add(p.start), true))).sort((a, b) => a.start - b.start));
                    });
                    return out;
                });
            }).catch(() => { for (const id of need) loaded.current.delete(`${id}@${w.from}`); });
        }
    }, [list, rowFrom, rowTo, viewStart, viewEnd, livetv]);

    const progAt = useCallback((chId: string, time: number): LiveTvProgramme | null => {
        const arr = progs.get(chId);
        return arr?.find((p) => p.start <= time && p.stop > time) ?? null;
    }, [progs]);

    const keyOf = (chId: string, p: LiveTvProgramme | null, time: number) => (p ? `gd:${chId}:${p.start}` : `gd:${chId}:empty:${floorTo(time, 30 * MIN)}`);

    // Re-focus the logical cell after moves/data changes.
    useEffect(() => {
        if (!active || details) return;
        const ch = list[focus.row];
        if (!ch) return;
        const p = progAt(ch.id, focus.time);
        requestAnimationFrame(() => focusByKey(keyOf(ch.id, p, focus.time)));
    }, [focus, progs, list, active, details, progAt]);

    const spanRef = useRef(VIEW_SPAN_MIN);
    spanRef.current = VIEW_SPAN_MIN;
    const ensureVisible = useCallback((time: number) => {
        setViewStart((vs) => {
            const span = spanRef.current;
            const end = vs + span * MIN;
            if (time < vs) return floorTo(time, 30 * MIN);
            if (time >= end - 15 * MIN) return floorTo(time - (span - 60) * MIN, 30 * MIN);
            return vs;
        });
    }, []);

    const jump = useCallback((time: number) => {
        setViewStart(floorTo(time - 30 * MIN, 30 * MIN));
        setFocus((f) => ({ ...f, time }));
    }, []);

    // ─── keys (cell-to-cell by time) ─────────────────────────────────────
    useEffect(() => {
        if (!active || details) return;
        const onKey = (e: KeyboardEvent) => {
            const el = document.activeElement as HTMLElement | null;
            if (!el?.closest(".gd-grid")) {
                if (keyFromEvent(e) === "down" && el?.closest(".gd-top")) { e.preventDefault(); e.stopImmediatePropagation(); setFocus((f) => ({ ...f })); }
                return;
            }
            const k = keyFromEvent(e);
            const ch = list[focus.row];
            if (!ch) return;
            const cur = progAt(ch.id, focus.time);
            const stop = () => { e.preventDefault(); e.stopImmediatePropagation(); };
            switch (k) {
                case "up":
                    stop();
                    if (focus.row === 0) { focusByKey("gd:now"); return; }
                    setFocus((f) => ({ ...f, row: f.row - 1 }));
                    return;
                case "down": stop(); setFocus((f) => ({ ...f, row: Math.min(list.length - 1, f.row + 1) })); return;
                case "right": {
                    stop();
                    const t2 = cur ? cur.stop + 1 : floorTo(focus.time, 30 * MIN) + 30 * MIN;
                    ensureVisible(t2);
                    setFocus((f) => ({ ...f, time: t2 }));
                    return;
                }
                case "left": {
                    stop();
                    const t2 = cur ? cur.start - 1 : floorTo(focus.time, 30 * MIN) - 1;
                    if (t2 < viewStart - 6 * HOUR && t2 < now - 7 * 24 * HOUR) return;
                    ensureVisible(t2);
                    setFocus((f) => ({ ...f, time: t2 }));
                    return;
                }
                case "chup": stop(); jump(focus.time + 24 * HOUR); return;
                case "chdown": stop(); jump(focus.time - 24 * HOUR); return;
                case "playpause": case "play": stop(); nav.push({ name: "livePlay", channelId: ch.id }); return;
                default: return;
            }
        };
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
    }, [active, details, list, focus, progAt, ensureVisible, jump, viewStart, now, nav]);

    const flash = (m: string) => { setToast(m); setTimeout(() => setToast(null), 3000); };
    const recorded = useMemo(() => new Set(recs.filter((r) => r.status === "scheduled" || r.status === "recording").map((r) => `${r.channelId}:${r.start}`)), [recs]);
    const isRecorded = (chId: string, p: LiveTvProgramme) => recs.some((r) => r.channelId === chId && (r.status === "scheduled" || r.status === "recording") && r.start <= p.start + 60_000 && r.stop >= p.stop - 60_000) || recorded.has(`${chId}:${p.start}`);

    const onDetail = async (id: string) => {
        const d = details;
        setDetails(null);
        if (!d) return;
        const { ch, p } = d;
        try {
            if (id === "live") nav.push({ name: "livePlay", channelId: ch.id });
            if (id === "catchup") {
                // Server takes duration in MINUTES (LiveTvClient names the arg durationSec).
                const minutes = Math.max(1, Math.round((p.stop - p.start) / MIN));
                requestCatchup({ channelId: ch.id, url: livetv.catchupUrl(ch.id, p.start, minutes), title: p.title, start: p.start, stop: p.stop });
                nav.push({ name: "livePlay", channelId: ch.id });
            }
            if (id === "record") {
                const r = await livetv.record({ channelId: ch.id, programme: p.start });
                if (r) setRecs((x) => [...x, r]);
                flash(t("lt.recordScheduled", { title: p.title }));
            }
            if (id === "series") {
                await livetv.createRule({ titleMatch: p.title, channelId: ch.id });
                const r = await livetv.record({ channelId: ch.id, programme: p.start }).catch(() => null);
                if (r) setRecs((x) => [...x, r]);
                flash(t("lt.seriesScheduled", { title: p.title }));
            }
        } catch (e) {
            flash(t("lt.recordFailed", { msg: (e as Error).message }));
        }
    };

    if (error) return <div className="tv-screen" data-scroll="screen"><ErrorState message={error} onRetry={loadChannels} /></div>;
    if (!channels) return <div className="tv-screen" data-scroll="screen"><LoadingBlock lines={6} /></div>;
    if (channels.length === 0) {
        return (
            <div className="tv-screen" data-scroll="screen">
                <ScreenHeader title={t("screen.guide")} />
                <Empty icon="guide" title={t("lt.noChannels")} message={t("lt.emptyMsg")} action={{ label: t("screen.livetv"), onClick: () => nav.resetTo({ name: "livetv" }) }} />
            </div>
        );
    }

    const x = (ms: number) => ((ms - viewStart) / MIN) * REM_PER_MIN; // rem
    const ticks: number[] = [];
    for (let tm = viewStart; tm < viewEnd + 30 * MIN; tm += 30 * MIN) ticks.push(tm);
    const nowX = x(now);
    const fch = list[focus.row];
    const fp = fch ? progAt(fch.id, focus.time) : null;

    return (
        <div className="gd" data-testid="screen-guide">
            <div className="gd-top">
                <ScreenHeader title={t("screen.guide")} sub={dayLabel(focus.time, lang)} />
                <div className="gd-controls" data-focus-row="gd-controls">
                    <SecondaryButton icon="chevronLeft" label={t("lt.prevDay")} onClick={() => jump(focus.time - 24 * HOUR)} focusKey="gd:prevday" />
                    <SecondaryButton icon="livetv" label={t("lt.now")} onClick={() => jump(Date.now())} focusKey="gd:now" />
                    <SecondaryButton icon="chevronRight" label={t("lt.nextDay")} onClick={() => jump(focus.time + 24 * HOUR)} focusKey="gd:nextday" />
                </div>
            </div>
            <div ref={gridRef} className="gd-grid">
                <div className="gd-ruler" style={{ left: `${CHAN_REM + 0.4}rem` }}>
                    {ticks.map((tm) => <span key={tm} className="gd-tick" style={{ transform: `translateX(${x(tm)}rem)` }}>{hhmm(tm, lang)}</span>)}
                </div>
                <div className="gd-rows">
                    <div className="gd-track" style={{ transform: `translateY(${-firstRow * ROW_REM}rem)` }}>
                        {list.slice(rowFrom, rowTo).map((ch, k) => {
                            const row = rowFrom + k;
                            const all = progs.get(ch.id) ?? [];
                            const lo = viewStart - HOUR, hi = viewEnd + HOUR;
                            const vis = all.filter((p) => p.stop > lo && p.start < hi);
                            // Gaps (no EPG) become 30-min placeholder cells so every row stays navigable.
                            const cells: Array<{ p: LiveTvProgramme | null; start: number; stop: number }> = [];
                            let cursor = floorTo(lo, 30 * MIN);
                            for (const p of vis) {
                                while (cursor + 30 * MIN <= p.start) { cells.push({ p: null, start: cursor, stop: cursor + 30 * MIN }); cursor += 30 * MIN; }
                                cells.push({ p, start: p.start, stop: p.stop });
                                cursor = Math.max(cursor, p.stop);
                            }
                            while (cursor < hi) { const nx = floorTo(cursor, 30 * MIN) + 30 * MIN; cells.push({ p: null, start: cursor, stop: nx }); cursor = nx; }
                            return (
                                <div key={ch.id} className="gd-row" style={{ transform: `translateY(${row * ROW_REM}rem)`, height: `${ROW_REM}rem` }}>
                                    <div className="gd-chan" style={{ width: `${CHAN_REM}rem` }}>
                                        <span className="gd-chan-num">{ch.number ?? row + 1}</span>
                                        <ChannelLogo client={livetv} channel={ch} size="2rem" />
                                        <span className="gd-chan-name">{ch.name}</span>
                                    </div>
                                    <div className="gd-cells" style={{ left: `${CHAN_REM + 0.4}rem` }} data-focus-noscroll="">
                                        {cells.map((c) => {
                                            const left = Math.max(0, x(c.start));
                                            const right = x(c.stop);
                                            if (right <= 0 || left > VIEW_SPAN_MIN * REM_PER_MIN + 6) return null;
                                            const w = Math.max(0.6, right - left - 0.2);
                                            const isNow = c.start <= now && c.stop > now;
                                            const past = c.stop <= now;
                                            const fk = keyOf(ch.id, c.p, c.start);
                                            return (
                                                <button key={fk} type="button" className={`gd-cell${isNow ? " is-now" : ""}${past ? " is-past" : ""}`}
                                                    data-focusable="" data-focus-key={fk} style={{ transform: `translateX(${left}rem)`, width: `${w}rem` }}
                                                    onFocus={() => { if (focus.row !== row || !(c.start <= focus.time && c.stop > focus.time)) setFocus({ row, time: Math.max(c.start, Math.min(c.stop - 1, focus.time)) }); }}
                                                    onClick={() => { if (c.p) setDetails({ ch, p: c.p }); else nav.push({ name: "livePlay", channelId: ch.id }); }}
                                                    aria-label={c.p ? `${ch.name}: ${c.p.title}, ${hhmm(c.start, lang)}` : `${ch.name}: ${t("lt.noGuide")}`}>
                                                    <span className="gd-cell-title">{c.p?.title ?? t("lt.noGuide")}</span>
                                                    {c.p && <span className="gd-cell-time">{hhmm(c.start, lang)}–{hhmm(c.stop, lang)}</span>}
                                                    {c.p && isRecorded(ch.id, c.p) && <span className="gd-cell-rec">REC</span>}
                                                </button>
                                            );
                                        })}
                                        {nowX >= 0 && nowX <= VIEW_SPAN_MIN * REM_PER_MIN && <span className="gd-nowline" style={{ transform: `translateX(${nowX}rem)` }} />}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            </div>
            <div className="gd-details" aria-live="polite">
                {fch && fp ? (
                    <>
                        <div className="gd-details-title">{fp.title}</div>
                        <div className="gd-details-sub">{[fch.name, `${dayLabel(fp.start, lang)} ${hhmm(fp.start, lang)}–${hhmm(fp.stop, lang)}`, fp.category, fp.episodeNum].filter(Boolean).join(" · ")}</div>
                        {fp.description && <div className="gd-details-desc">{fp.description}</div>}
                    </>
                ) : <div className="gd-details-sub">{t("lt.guideHint")}</div>}
            </div>
            {toast && <div className="lp-toast" role="status">{toast}</div>}
            <SidePanel open={!!details} title={details?.p.title ?? ""} onClose={() => setDetails(null)} testId="gd-details"
                items={details ? [
                    ...(details.p.start <= Date.now() && details.p.stop > Date.now() ? [{ id: "live", label: t("lt.watchLive"), icon: "livetv" as const }] : []),
                    ...(details.p.stop <= Date.now() || (details.p.start < Date.now() && details.p.stop > Date.now())
                        ? [{ id: "catchup", label: t("lt.watchCatchup"), icon: "back10" as const, disabled: !details.ch.catchup || details.ch.archiveDays <= 0, sub: !details.ch.catchup || details.ch.archiveDays <= 0 ? t("lt.noArchive") : undefined }] : []),
                    ...(details.p.stop > Date.now() ? [
                        { id: "record", label: isRecorded(details.ch.id, details.p) ? t("lt.recordedAlready") : t("lt.record"), icon: "record" as const, disabled: isRecorded(details.ch.id, details.p) },
                        { id: "series", label: t("lt.recordSeries"), icon: "repeat" as const },
                    ] : []),
                ] : []}
                onSelect={(id) => { void onDetail(id); }}
                footer={details ? <div className="lt-note" style={{ marginTop: "1rem" }}>{[details.ch.name, `${hhmm(details.p.start, lang)}–${hhmm(details.p.stop, lang)}`].join(" · ")}{details.p.description ? ` — ${details.p.description}` : ""}</div> : undefined} />
        </div>
    );
}
