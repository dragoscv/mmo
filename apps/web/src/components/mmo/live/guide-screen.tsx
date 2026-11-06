"use client";

/**
 * `/media/live/guide` (WP16-41) — EPG grid. Channels down the left (sticky), time across (30-min slots, now
 * line, horizontal scroll), a day picker (catch-up days back, one forward) and a "Now" button. Rows are
 * windowed by scrollTop (fixed row height) and cells culled by scrollLeft, so 300+ channels stay smooth;
 * guide data is fetched lazily for the rows that come into view.
 *
 * Keyboard (role=grid, roving tabindex): ←/→ previous/next programme, ↑/↓ same time on the neighbouring
 * channel, PageUp/PageDown ±10 channels, Home/End first/last programme of the row, Enter opens the sheet
 * (Watch live / Watch from start (catch-up) / Record / Record series).
 */
import Link, { useRouter } from "@/components/host/host-context";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useTranslations } from "next-intl";
import { CalendarClock, Clock, Disc3, History, ListVideo, Play, Radio, Settings2 } from "lucide-react";
import { toast } from "sonner";
import { Button, EmptyState, ErrorState, Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, Skeleton } from "@mmo/ui";
import type { LiveTvChannel, LiveTvProgramme } from "@/lib/mmo/media-types";
import { useMmo } from "../mmo-provider";
import { ChannelLogo, LiveHeader, errorText, useLiveFormat, useNow } from "./common";
import {
    MIN, SLOT_MIN, canCatchup, canRecord, cellIndexAt, chunk, dayOffsets, durationMin, gridWidth, guideWindow, isAiring,
    layoutRow, nowLineX, scrollToRow, scrollToX, slotTicks, visibleRange, xOf, type EpgCell, type TimeWindow,
} from "./live-logic";

const ROW_H = 64;
const HEAD_H = 40;
const FETCH_CHUNK = 60;

interface Focus { row: number; time: number }
interface Selected { channel: LiveTvChannel; prog: LiveTvProgramme }

export function GuideScreen() {
    const t = useTranslations("mx.live.guide");
    const tc = useTranslations("mx.live.common");
    const { clients } = useMmo();
    const livetv = clients?.livetv ?? null;
    const router = useRouter();
    const fmt = useLiveFormat();
    const now = useNow(30_000);
    const [channels, setChannels] = useState<LiveTvChannel[] | null>(null);
    const [hasSources, setHasSources] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [reloadKey, setReloadKey] = useState(0);
    const [day, setDay] = useState(0);
    // Window is fixed per day selection (recomputed on day change / "Now", not on every tick).
    const [win, setWin] = useState<TimeWindow>(() => guideWindow(Date.now(), 0));
    const [progs, setProgs] = useState<Map<string, LiveTvProgramme[]>>(new Map());
    const requested = useRef<Set<string>>(new Set());
    const [scroll, setScroll] = useState({ top: 0, left: 0, h: 600, w: 1200 });
    const [pxPerMin, setPxPerMin] = useState(6);
    const [stickyW, setStickyW] = useState(220);
    const [focus, setFocus] = useState<Focus>(() => ({ row: 0, time: Date.now() }));
    const [selected, setSelected] = useState<Selected | null>(null);
    const scroller = useRef<HTMLDivElement>(null);
    const wantFocus = useRef(false);
    const raf = useRef(0);

    useEffect(() => {
        if (!livetv) return;
        let alive = true;
        void Promise.all([livetv.channels(), livetv.sources()])
            .then(([chs, srcs]) => { if (alive) { setChannels(chs); setHasSources(srcs.length > 0); setError(null); } })
            .catch((e: unknown) => { if (alive) setError(errorText(e)); });
        return () => { alive = false; };
    }, [livetv, reloadKey]);

    // Responsive scale: 30 min = 120 px on phones, 180 px on desktop, 210 px on ultrawide.
    useEffect(() => {
        const sm = window.matchMedia("(max-width: 640px)");
        const xl = window.matchMedia("(min-width: 2400px)");
        const on = () => {
            setPxPerMin(sm.matches ? 4 : xl.matches ? 7 : 6);
            setStickyW(sm.matches ? 112 : xl.matches ? 280 : 220);
        };
        on();
        sm.addEventListener("change", on);
        xl.addEventListener("change", on);
        return () => { sm.removeEventListener("change", on); xl.removeEventListener("change", on); };
    }, []);

    const measure = useCallback(() => {
        const el = scroller.current;
        if (!el) return;
        setScroll({ top: el.scrollTop, left: el.scrollLeft, h: el.clientHeight, w: el.clientWidth });
    }, []);
    useEffect(() => {
        const el = scroller.current;
        if (!el) return;
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        return () => ro.disconnect();
    }, [measure, channels]);
    const onScroll = () => {
        cancelAnimationFrame(raf.current);
        raf.current = requestAnimationFrame(measure);
    };

    const count = channels?.length ?? 0;
    const range = visibleRange(scroll.top, scroll.h - HEAD_H, ROW_H, count, 6);
    const maxArchive = useMemo(() => (channels ?? []).reduce((m, c) => (c.catchup ? Math.max(m, c.archiveDays) : m), 0), [channels]);
    const days = useMemo(() => dayOffsets(maxArchive, 1), [maxArchive]);
    const winKey = `${win.from}-${win.to}`;

    // Lazy guide fetch for the rows in view.
    useEffect(() => {
        if (!livetv || !channels) return;
        const ids = channels.slice(range.start, range.end).map((c) => c.id).filter((id) => !requested.current.has(`${winKey}|${id}`));
        if (!ids.length) return;
        ids.forEach((id) => requested.current.add(`${winKey}|${id}`));
        for (const part of chunk(ids, FETCH_CHUNK)) {
            void livetv.guide({ from: win.from, to: win.to, channels: part })
                .then((r) => {
                    setProgs((cur) => {
                        const o = new Map(cur);
                        for (const id of part) o.set(`${winKey}|${id}`, []);
                        for (const p of r.programmes) o.get(`${winKey}|${p.channelId}`)?.push(p);
                        return o;
                    });
                })
                .catch(() => { part.forEach((id) => requested.current.delete(`${winKey}|${id}`)); });
        }
    }, [livetv, channels, range.start, range.end, win.from, win.to, winKey]);

    const rowCells = useCallback((i: number): EpgCell[] => {
        const ch = channels?.[i];
        if (!ch) return [];
        return layoutRow(progs.get(`${winKey}|${ch.id}`) ?? [], win, pxPerMin);
    }, [channels, progs, winKey, win, pxPerMin]);

    const width = gridWidth(win, pxPerMin);
    const ticks = useMemo(() => slotTicks(win, SLOT_MIN), [win]);
    const nowX = nowLineX(now, win, pxPerMin);

    const scrollToNow = useCallback((smooth = true) => {
        const el = scroller.current;
        if (!el) return;
        const x = nowLineX(Date.now(), win, pxPerMin);
        if (x === null) return;
        const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches || document.documentElement.dataset.motion === "reduced";
        el.scrollTo({ left: Math.max(0, x - SLOT_MIN * pxPerMin), behavior: smooth && !reduce ? "smooth" : "auto" });
    }, [win, pxPerMin]);

    const pickDay = (d: number, at: number = now) => {
        setDay(d);
        const w = guideWindow(at, d);
        setWin(w);
        setFocus((f) => ({ row: f.row, time: d === 0 ? at : w.from + 20 * 60 * MIN }));
        requestAnimationFrame(() => {
            const el = scroller.current;
            if (!el) return;
            if (d === 0) el.scrollTo({ left: 0 });
            else el.scrollTo({ left: Math.max(0, xOf(w.from + 20 * 60 * MIN, w, pxPerMin) - 2 * SLOT_MIN * pxPerMin) }); // evening
        });
    };

    const goNow = () => {
        if (day !== 0) { pickDay(0); return; }
        setFocus((f) => ({ row: f.row, time: Date.now() }));
        scrollToNow();
    };

    // Keep the focused cell in view and move DOM focus to it after keyboard moves.
    useLayoutEffect(() => {
        if (!wantFocus.current) return;
        const el = scroller.current;
        if (!el) return;
        const cells = rowCells(focus.row);
        const ci = cellIndexAt(cells, focus.time);
        const top = scrollToRow(focus.row, el.scrollTop, el.clientHeight - HEAD_H, ROW_H);
        const c = cells[ci];
        const left = c ? scrollToX(c.left, c.width, el.scrollLeft, el.clientWidth, stickyW) : el.scrollLeft;
        if (top !== el.scrollTop || left !== el.scrollLeft) { el.scrollTo({ top, left }); measure(); }
        const target = el.querySelector<HTMLElement>(`[data-cell="${focus.row}:${ci}"]`);
        if (target) { target.focus({ preventScroll: true }); wantFocus.current = false; }
    });

    const moveTo = (f: Focus) => { wantFocus.current = true; setFocus(f); };

    const onGridKey = (e: KeyboardEvent<HTMLDivElement>) => {
        if (!channels?.length) return;
        const cells = rowCells(focus.row);
        const ci = cellIndexAt(cells, focus.time);
        const cell = cells[ci];
        const timeFor = (c: EpgCell | undefined) => (c ? (c.start <= now && now < c.stop ? now : c.start) : focus.time);
        switch (e.key) {
            case "ArrowRight": { const n = cells[Math.min(cells.length - 1, ci + 1)]; moveTo({ row: focus.row, time: timeFor(n) }); break; }
            case "ArrowLeft": { const n = cells[Math.max(0, ci - 1)]; moveTo({ row: focus.row, time: timeFor(n) }); break; }
            case "ArrowDown": moveTo({ row: Math.min(count - 1, focus.row + 1), time: focus.time }); break;
            case "ArrowUp": moveTo({ row: Math.max(0, focus.row - 1), time: focus.time }); break;
            case "PageDown": moveTo({ row: Math.min(count - 1, focus.row + 10), time: focus.time }); break;
            case "PageUp": moveTo({ row: Math.max(0, focus.row - 10), time: focus.time }); break;
            case "Home": moveTo({ row: e.ctrlKey ? 0 : focus.row, time: timeFor(cells[0]) }); break;
            case "End": moveTo({ row: e.ctrlKey ? count - 1 : focus.row, time: timeFor(cells[cells.length - 1]) }); break;
            case "Enter": case " ": {
                const ch = channels[focus.row];
                if (ch && cell?.prog) setSelected({ channel: ch, prog: cell.prog });
                else if (ch) router.push(`/media/live/play/${encodeURIComponent(ch.id)}`);
                break;
            }
            default: return;
        }
        e.preventDefault();
    };

    if (!livetv) return null;
    const header = (
        <LiveHeader title={t("title")} actions={
            <div className="lv-guide-actions">
                <div className="lv-days" role="group" aria-label={t("days")}>
                    {days.map((d) => (
                        <button key={d} type="button" className="lv-chip" aria-pressed={d === day} onClick={() => pickDay(d)}>
                            {d === 0 ? t("today") : Math.abs(d) === 1 ? fmt.relDay(d) : fmt.day(guideWindow(now, d).from)}
                        </button>
                    ))}
                </div>
                <Button variant="outline" size="sm" onClick={goNow}><Clock aria-hidden />{t("now")}</Button>
            </div>
        } />
    );

    if (error) return <div className="lv-page">{header}<ErrorState detail={error} onRetry={() => { setError(null); setChannels(null); setReloadKey((k) => k + 1); }} /></div>;
    if (!channels) {
        return (
            <div className="lv-page">{header}
                <div className="lv-guide-skel" aria-busy="true" aria-label={tc("loading")}>
                    {Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="lv-guide-skel-row" />)}
                </div>
            </div>
        );
    }
    if (!hasSources || !channels.length) {
        return (
            <div className="lv-page">{header}
                <EmptyState icon={<Radio aria-hidden />} title={hasSources ? t("empty.noChannels") : t("empty.noSources")} description={t("empty.body")}
                    actions={<Button render={<Link href={hasSources ? "/media/live/sources" : "/media/live/sources?add=1"} />}><Settings2 aria-hidden />{t("empty.cta")}</Button>} />
            </div>
        );
    }

    // Horizontal culling window (focused cell always rendered).
    const cullFrom = scroll.left - stickyW - scroll.w;
    const cullTo = scroll.left + 2 * scroll.w;
    const rows: number[] = [];
    for (let i = range.start; i < range.end; i++) rows.push(i);
    const focusCellIdx = cellIndexAt(rowCells(focus.row), focus.time);
    // Roving tabindex target: the focused cell, or the first visible row's cell at the same time when the
    // focused row has been scrolled out of the rendered window.
    const tabRow = focus.row >= range.start && focus.row < range.end ? focus.row : range.start;
    const tabCellIdx = tabRow === focus.row ? focusCellIdx : cellIndexAt(rowCells(tabRow), focus.time);

    return (
        <div className="lv-page lv-guide-page">
            {header}
            <p className="sr-only" id="lv-guide-help">{t("help")}</p>
            <div ref={scroller} className="lv-guide" onScroll={onScroll}
                style={{ ["--lv-sticky" as string]: `${stickyW}px`, ["--lv-row" as string]: `${ROW_H}px`, ["--lv-head" as string]: `${HEAD_H}px` }}>
                <div role="grid" aria-label={t("gridLabel")} aria-describedby="lv-guide-help" aria-rowcount={count + 1} aria-colcount={-1}
                    className="lv-guide-inner" style={{ width: stickyW + width, height: HEAD_H + count * ROW_H }} onKeyDown={onGridKey}>
                    <div role="row" aria-rowindex={1} className="lv-guide-head" style={{ width: stickyW + width }}>
                        <div role="columnheader" className="lv-guide-corner">{fmt.day(win.from)}</div>
                        <div className="lv-guide-ticks" style={{ width }}>
                            {ticks.map((tk) => (
                                <div key={tk} role="columnheader" className="lv-tick" style={{ left: xOf(tk, win, pxPerMin), width: SLOT_MIN * pxPerMin }}>
                                    {fmt.time(tk)}
                                </div>
                            ))}
                            {nowX !== null ? <div className="lv-now-tag" style={{ left: nowX }} aria-hidden>{fmt.time(now)}</div> : null}
                        </div>
                    </div>
                    {nowX !== null ? <div className="lv-now-line" style={{ left: stickyW + nowX, top: HEAD_H, height: count * ROW_H }} aria-hidden /> : null}
                    {rows.map((i) => {
                        const ch = channels[i]!;
                        const cells = rowCells(i);
                        const loaded = progs.has(`${winKey}|${ch.id}`);
                        return (
                            <div key={ch.id} role="row" aria-rowindex={i + 2} className="lv-guide-row" style={{ top: HEAD_H + i * ROW_H, width: stickyW + width }}>
                                <div role="rowheader" className="lv-guide-ch">
                                    <Link href={`/media/live/play/${encodeURIComponent(ch.id)}`} tabIndex={-1} className="lv-guide-ch-link" aria-label={t("watchChannel", { name: ch.name })}>
                                        <span className="lv-num">{ch.number ?? ""}</span>
                                        <ChannelLogo channel={ch} livetv={livetv} size="sm" />
                                        <span className="lv-guide-ch-name">{ch.name}</span>
                                        {ch.catchup && ch.archiveDays > 0 ? <History aria-label={t("hasCatchup")} className="size-3.5 lv-dim" /> : null}
                                    </Link>
                                </div>
                                <div className="lv-guide-cells" style={{ width }}>
                                    {!loaded ? <div className="lv-cell lv-cell-loading" style={{ left: Math.max(0, scroll.left - stickyW), width: Math.min(width, scroll.w) }} aria-hidden /> : null}
                                    {loaded ? cells.map((c, ci) => {
                                        const isFocus = focus.row === i && focusCellIdx === ci;
                                        const isTab = tabRow === i && tabCellIdx === ci;
                                        if (!isFocus && !isTab && (c.left + c.width < cullFrom || c.left > cullTo)) return null;
                                        const airing = c.prog ? isAiring(c.prog, now) : false;
                                        const past = c.stop <= now;
                                        const label = c.prog
                                            ? `${ch.name}, ${c.prog.title}, ${fmt.range(c.prog.start, c.prog.stop)}${airing ? `, ${t("airing")}` : ""}`
                                            : `${ch.name}, ${t("noData")}, ${fmt.range(c.start, c.stop)}`;
                                        return (
                                            <div key={`${c.start}`} role="gridcell" aria-colindex={ci + 1} tabIndex={isTab ? 0 : -1} data-cell={`${i}:${ci}`}
                                                aria-label={label} aria-selected={isFocus}
                                                className="lv-cell" data-airing={airing ? "" : undefined} data-past={past ? "" : undefined} data-empty={c.prog ? undefined : ""}
                                                style={{ left: c.left, width: c.width }}
                                                onFocus={() => { if (focus.row !== i || focusCellIdx !== ci) setFocus({ row: i, time: c.start <= now && now < c.stop ? now : c.start }); }}
                                                onClick={() => {
                                                    setFocus({ row: i, time: c.start });
                                                    if (c.prog) setSelected({ channel: ch, prog: c.prog });
                                                    else router.push(`/media/live/play/${encodeURIComponent(ch.id)}`);
                                                }}>
                                                <span className="lv-cell-title">{c.prog?.title ?? t("noData")}</span>
                                                {c.width >= 90 ? <span className="lv-cell-time">{fmt.range(c.start, c.stop)}</span> : null}
                                                {airing && c.prog ? <span className="lv-cell-progress" style={{ width: `${Math.round(((now - c.prog.start) / (c.prog.stop - c.prog.start)) * 100)}%` }} aria-hidden /> : null}
                                            </div>
                                        );
                                    }) : null}
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>
            <ProgrammeSheet selected={selected} now={now} onClose={() => setSelected(null)} />
        </div>
    );
}

function ProgrammeSheet({ selected, now, onClose }: { selected: Selected | null; now: number; onClose: () => void }) {
    const t = useTranslations("mx.live.guide.sheet");
    const { clients } = useMmo();
    const livetv = clients?.livetv ?? null;
    const router = useRouter();
    const fmt = useLiveFormat();
    const [busy, setBusy] = useState<"rec" | "rule" | null>(null);
    const [side, setSide] = useState<"right" | "bottom">("right");
    useEffect(() => {
        const mq = window.matchMedia("(max-width: 640px)");
        const on = () => setSide(mq.matches ? "bottom" : "right");
        on();
        mq.addEventListener("change", on);
        return () => mq.removeEventListener("change", on);
    }, []);

    const ch = selected?.channel ?? null;
    const p = selected?.prog ?? null;
    const airing = p ? isAiring(p, now) : false;
    const catchupOk = ch && p ? canCatchup(ch, p, now) : false;
    const recordOk = p ? canRecord(p, now) : false;
    const playUrl = ch ? `/media/live/play/${encodeURIComponent(ch.id)}` : "";

    const record = async () => {
        if (!livetv || !ch || !p) return;
        setBusy("rec");
        try {
            const r = await livetv.record({ channelId: ch.id, programme: p.start });
            toast.success(r?.conflict ? t("recordConflict", { title: p.title }) : t("recordScheduled", { title: p.title }));
            onClose();
        } catch (e) { toast.error(t("recordFailed", { msg: errorText(e) })); }
        finally { setBusy(null); }
    };
    const recordSeries = async () => {
        if (!livetv || !ch || !p) return;
        setBusy("rule");
        try {
            await livetv.createRule({ titleMatch: p.title, channelId: ch.id });
            toast.success(t("seriesCreated", { title: p.title }));
            onClose();
        } catch (e) { toast.error(t("recordFailed", { msg: errorText(e) })); }
        finally { setBusy(null); }
    };

    return (
        <Sheet open={!!selected} onOpenChange={(o) => { if (!o) onClose(); }}>
            <SheetContent side={side} className="lv-sheet">
                {ch && p ? (
                    <>
                        <SheetHeader>
                            <p className="lv-sheet-ch">{ch.number ? `${ch.number} · ` : ""}{ch.name}</p>
                            <SheetTitle>{p.title}</SheetTitle>
                            <SheetDescription>
                                {fmt.day(p.start)} · {fmt.range(p.start, p.stop)} · {t("minutes", { count: durationMin(p) })}
                            </SheetDescription>
                        </SheetHeader>
                        {p.icon && /^https?:\/\//i.test(p.icon)
                            // eslint-disable-next-line @next/next/no-img-element -- XMLTV artwork from arbitrary hosts
                            ? <img className="lv-sheet-img" src={p.icon} alt="" loading="lazy" referrerPolicy="no-referrer" />
                            : null}
                        <div className="lv-sheet-meta">
                            {airing ? <span className="mx-chip">{t("airing")}</span> : null}
                            {p.category ? <span className="mx-chip">{p.category}</span> : null}
                            {p.episodeNum ? <span className="mx-chip">{p.episodeNum}</span> : null}
                        </div>
                        {p.subtitle ? <p className="lv-sheet-sub">{p.subtitle}</p> : null}
                        {p.description ? <p className="lv-sheet-desc">{p.description}</p> : <p className="lv-dim">{t("noDescription")}</p>}
                        <div className="lv-sheet-actions">
                            {airing ? <Button onClick={() => router.push(playUrl)}><Play aria-hidden />{t("watchLive")}</Button> : null}
                            {catchupOk ? (
                                <Button variant={airing ? "outline" : "default"} onClick={() => router.push(`${playUrl}?start=${p.start}&dur=${durationMin(p)}`)}>
                                    <History aria-hidden />{t("watchFromStart")}
                                </Button>
                            ) : null}
                            {recordOk ? <Button variant="outline" loading={busy === "rec"} onClick={() => void record()}><Disc3 aria-hidden />{t("record")}</Button> : null}
                            <Button variant="outline" loading={busy === "rule"} onClick={() => void recordSeries()}><ListVideo aria-hidden />{t("recordSeries")}</Button>
                            {!airing && !catchupOk && p.stop <= now ? <p className="lv-dim">{t("notAvailable")}</p> : null}
                            {!airing && p.start > now ? <p className="lv-dim"><CalendarClock aria-hidden className="inline size-4" /> {t("startsAt", { time: fmt.dateTime(p.start) })}</p> : null}
                        </div>
                    </>
                ) : null}
            </SheetContent>
        </Sheet>
    );
}
