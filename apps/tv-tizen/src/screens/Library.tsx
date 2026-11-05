/**
 * Library (WP16-34, `{kind}`): the server's own files (`/media/library`) grouped per title, in a virtualised `Grid`
 * (only visible rows are in the DOM — smooth with 1000+ titles). Card details come lazily: pages of 30 around the
 * focus, ≤ 4 concurrent `/media/title` calls, cached for the session; until then the card shows the name guessed
 * from the file/folder. Sort (Recently added / A–Z / Year / Rating) + filters (genre, decade, resolution, unwatched)
 * via SidePanels; A–Z jump strip when sorted by name.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { focusByKey } from "../lib/focus";
import { remPx } from "../lib/image";
import type { MediaKind, ProgressEntry } from "../lib/media-types";
import { t } from "../i18n/messages";
import type { ScreenProps } from "../nav/ctx";
import { useScreenActive } from "../nav/Nav";
import { CARD_REM, Empty, ErrorState, Grid, LoadingRows, PosterCard, ScreenHeader, SecondaryButton, SidePanel, useBackdrop, type SidePanelItem } from "../ui";
import { fold } from "./home/media-ui";
import {
    DetailResolver, detailsOf, groupLibrary, libEntryToShow, PAGE, rankRes, watchedKeys, type LibDetails, type LibEntry,
} from "./home/library-data";
import { rememberFlipSource } from "./home/widgets";
import "./home/home.css";

type Sort = "recent" | "az" | "year" | "rating";
type Panel = null | "sort" | "genre" | "decade" | "res";
type Load = { s: "loading" } | { s: "ok"; entries: LibEntry[] } | { s: "error"; message: string } | { s: "unsupported" };

const ALL = "__all";
const LETTERS = ["#", ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("")];

/** Per-kind UI state survives remounts (rail → Movies again). */
const memory = new Map<MediaKind, { sort: Sort; genre: string; decade: string; res: string; unwatched: boolean }>();

/** Perf proof hook: localStorage `mixai-tv:debug-lib-repeat` = N repeats the library N× (distinct keys). */
function debugRepeat(list: LibEntry[]): LibEntry[] {
    let n = 1;
    try { n = Math.min(50, Math.max(1, Number(localStorage.getItem("mixai-tv:debug-lib-repeat")) || 1)); } catch { /* ignore */ }
    if (n <= 1) return list;
    const out: LibEntry[] = [];
    for (let i = 0; i < n; i++) for (const e of list) out.push(i === 0 ? e : { ...e, key: `${e.key}#${i}` });
    return out;
}

export function Library({ ctx, params }: ScreenProps<"library">) {
    const kind = params.kind;
    const mem = memory.get(kind);
    const [load, setLoad] = useState<Load>({ s: "loading" });
    const [progress, setProgress] = useState<ProgressEntry[]>([]);
    const [rev, setRev] = useState(0);
    const [tick, setTick] = useState(0);
    const [sort, setSort] = useState<Sort>(mem?.sort ?? "recent");
    const [genre, setGenre] = useState(mem?.genre ?? ALL);
    const [decade, setDecade] = useState(mem?.decade ?? ALL);
    const [res, setRes] = useState(mem?.res ?? ALL);
    const [unwatched, setUnwatched] = useState(mem?.unwatched ?? false);
    const [panel, setPanel] = useState<Panel>(null);
    const resolver = useRef<DetailResolver | null>(null);
    const backdrop = useBackdrop();
    const active = useScreenActive();
    const gridId = `lib-${kind}`;

    useEffect(() => { memory.set(kind, { sort, genre, decade, res, unwatched }); }, [kind, sort, genre, decade, res, unwatched]);

    useEffect(() => {
        const r = new DetailResolver(ctx.media, () => setTick((n) => n + 1));
        resolver.current = r;
        return () => { r.dispose(); resolver.current = null; };
    }, [ctx.media]);

    useEffect(() => {
        let alive = true;
        setLoad({ s: "loading" });
        ctx.media.mediaLibrary()
            .then((idx) => {
                if (!alive) return;
                if (!idx) { setLoad({ s: "unsupported" }); return; }
                const entries = debugRepeat(groupLibrary(idx.items, kind));
                setLoad({ s: "ok", entries });
                resolver.current?.want(entries.slice().sort((a, b) => b.addedAt - a.addedAt).slice(0, PAGE * 2), true);
            })
            .catch((e: Error) => { if (alive) setLoad({ s: "error", message: e.message }); });
        ctx.media.getProgress().then((p) => { if (alive && p) setProgress(p.entries); }).catch(() => undefined);
        return () => { alive = false; };
    }, [ctx.media, kind, rev]);

    const entries = load.s === "ok" ? load.entries : [];
    const det = useCallback((e: LibEntry): LibDetails | null => {
        const d = detailsOf(ctx.media, e);
        return d && typeof d === "object" ? d : null;
    }, [ctx.media]);

    // Filters/sorts that need details resolve the whole library in the background (non-urgent).
    const needsAll = sort === "year" || sort === "rating" || sort === "az" || genre !== ALL || decade !== ALL;
    useEffect(() => { if (needsAll && entries.length > 0) resolver.current?.want(entries); }, [needsAll, entries]);

    const watched = useMemo(() => watchedKeys(entries, progress), [entries, progress]);

    const view = useMemo(() => {
        void tick;
        const nameOf = (e: LibEntry) => det(e)?.title ?? e.guess;
        let list = entries.filter((e) => {
            const d = det(e);
            if (detailsOf(ctx.media, e) === "restricted") return false;
            if (unwatched && watched.has(e.key)) return false;
            if (res !== ALL && (d?.res ?? e.res) !== res) return false;
            if (genre !== ALL && !(d?.genres.includes(genre))) return false;
            if (decade !== ALL && !(d?.year && d.year.slice(0, 3) === decade.slice(0, 3))) return false;
            return true;
        });
        const byName = (a: LibEntry, b: LibEntry) => fold(nameOf(a)).localeCompare(fold(nameOf(b)));
        list = list.slice();
        if (sort === "recent") list.sort((a, b) => b.addedAt - a.addedAt || byName(a, b));
        else if (sort === "az") list.sort(byName);
        else if (sort === "year") list.sort((a, b) => Number(det(b)?.year ?? 0) - Number(det(a)?.year ?? 0) || byName(a, b));
        else list.sort((a, b) => (det(b)?.rating ?? -1) - (det(a)?.rating ?? -1) || byName(a, b));
        return list;
    }, [entries, tick, det, ctx.media, unwatched, watched, res, genre, decade, sort]);

    const genres = useMemo(() => {
        void tick;
        const s = new Set<string>();
        for (const e of entries) for (const g of det(e)?.genres ?? []) s.add(g);
        return Array.from(s).sort((a, b) => a.localeCompare(b));
    }, [entries, tick, det]);
    const decades = useMemo(() => {
        void tick;
        const s = new Set<string>();
        for (const e of entries) { const y = det(e)?.year; if (y) s.add(`${y.slice(0, 3)}0`); }
        return Array.from(s).sort().reverse();
    }, [entries, tick, det]);

    const onItemFocus = useCallback((e: LibEntry, i: number) => {
        const page = Math.floor(i / PAGE);
        resolver.current?.want(view.slice(page * PAGE, (page + 2) * PAGE), true);
        const d = det(e);
        if (d?.backdropPath) backdrop.show(ctx.media.image(d.backdropPath, "w1280"));
    }, [view, det, backdrop, ctx.media]);

    useEffect(() => { if (active) backdrop.show(null); }, [active, backdrop]);

    const open = useCallback(async (e: LibEntry, focusKey: string) => {
        const d = det(e);
        if (e.tmdbId != null) {
            rememberFlipSource(focusKey, d?.posterPath ? ctx.media.imageFor(d.posterPath, remPx(CARD_REM.poster)) : null);
            ctx.nav.push({ name: "title", kind: e.kind, tmdbId: e.tmdbId });
            return;
        }
        if (e.kind === "tv") {
            // Unmatched show → the local show page (episode list), never straight into the player.
            ctx.nav.push({ name: "show", show: libEntryToShow(e) });
            return;
        }
        const f = e.files.slice().sort((a, b) => (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0))[0];
        if (!f) return;
        try {
            const video = await ctx.client.resolveVideo(f.serverFileId, f.path);
            ctx.nav.push({ name: "player", item: { kind: "video", video } });
        } catch { /* stays; Player-level errors are shown there */ }
    }, [det, ctx]);

    const letterOf = useCallback((e: LibEntry) => {
        const c = fold(det(e)?.title ?? e.guess).replace(/[^a-z0-9]/g, "").charAt(0);
        return c >= "a" && c <= "z" ? c.toUpperCase() : "#";
    }, [det]);
    const letters = useMemo(() => (sort === "az" ? new Set(view.map(letterOf)) : new Set<string>()), [sort, view, letterOf]);

    const jump = (letter: string) => {
        const i = view.findIndex((e) => letterOf(e) === letter);
        if (i < 0) return;
        const scroller = document.querySelector<HTMLElement>(`[data-nav-active="true"] [data-scroll="${gridId}"]`);
        const body = scroller?.querySelector<HTMLElement>(".vgrid-body");
        if (!scroller || !body) return;
        const step = remPx(CARD_REM.poster + CARD_REM.gap);
        const cols = Math.max(1, Math.floor((body.clientWidth + remPx(CARD_REM.gap)) / step));
        const rowPx = remPx(CARD_REM.poster * 1.5 + 3.6);
        scroller.scrollTop = body.offsetTop + Math.floor(i / cols) * rowPx - remPx(1);
        const key = `${gridId}:${view[i]!.key}`;
        let tries = 0;
        const go = () => { if (!focusByKey(key) && ++tries < 6) requestAnimationFrame(go); };
        requestAnimationFrame(go);
    };

    const sortLabel: Record<Sort, string> = { recent: t("wh.sortRecent"), az: t("wh.sortAz"), year: t("wh.sortYear"), rating: t("wh.sortRating") };
    const panelItems: Record<Exclude<Panel, null>, SidePanelItem[]> = {
        sort: (Object.keys(sortLabel) as Sort[]).map((id) => ({ id, label: sortLabel[id] })),
        genre: [{ id: ALL, label: t("wh.all") }, ...genres.map((g) => ({ id: g, label: g }))],
        decade: [{ id: ALL, label: t("wh.all") }, ...decades.map((d) => ({ id: d, label: t("wh.decade", { d }) }))],
        res: [{ id: ALL, label: t("wh.all") }, ...["4K", "1080p", "720p", "SD"].map((r) => ({ id: r, label: r }))],
    };
    const panelValue = panel === "sort" ? sort : panel === "genre" ? genre : panel === "decade" ? decade : res;
    const panelTitle = panel === "sort" ? t("wh.sort") : panel === "genre" ? t("wh.genre") : panel === "decade" ? t("wh.decadeTitle") : t("wh.resolution");
    const pick = (id: string) => {
        if (panel === "sort") setSort(id as Sort);
        else if (panel === "genre") setGenre(id);
        else if (panel === "decade") setDecade(id);
        else if (panel === "res") setRes(id);
        setPanel(null);
    };

    const title = t(kind === "tv" ? "screen.library.tv" : "screen.library.movie");
    const pend = resolver.current?.pending ?? 0;
    const header = (
        <div>
            <ScreenHeader title={title}
                sub={load.s === "ok" ? `${t("wh.titlesCount", { n: view.length, total: entries.length })}${pend > 0 ? ` · ${t("wh.resolving", { n: pend })}` : ""}` : undefined} />
            <div className="wl-tools" data-focus-row="lib:tools">
                <SecondaryButton icon="queue" label={t("wh.sort")} sub={sortLabel[sort]} focusKey="lib:sort" testId="lib-sort" onClick={() => setPanel("sort")} />
                <SecondaryButton icon="star" label={t("wh.genre")} sub={genre === ALL ? t("wh.all") : genre} active={genre !== ALL} focusKey="lib:genre" onClick={() => setPanel("genre")} />
                <SecondaryButton icon="guide" label={t("wh.decadeTitle")} sub={decade === ALL ? t("wh.all") : t("wh.decade", { d: decade })} active={decade !== ALL} focusKey="lib:decade" onClick={() => setPanel("decade")} />
                <SecondaryButton icon="aspect" label={t("wh.resolution")} sub={res === ALL ? t("wh.all") : res} active={res !== ALL} focusKey="lib:res" onClick={() => setPanel("res")} />
                <SecondaryButton icon={unwatched ? "check" : "info"} label={t("wh.unwatched")} active={unwatched} focusKey="lib:unwatched" onClick={() => setUnwatched((v) => !v)} />
            </div>
            <div style={{ height: "1rem" }} />
            {load.s === "loading" && <LoadingRows rows={2} />}
            {load.s === "error" && <ErrorState message={load.message} onRetry={() => setRev((r) => r + 1)} />}
            {load.s === "unsupported" && <Empty icon={kind === "tv" ? "tv" : "movie"} message={t("home.mediaUnavailable")} />}
            {load.s === "ok" && view.length === 0 && (
                <Empty icon={kind === "tv" ? "tv" : "movie"} title={entries.length === 0 ? t("wh.libraryEmpty") : t("wh.noMatches")}
                    message={entries.length === 0 ? t("home.moviesEmpty") : undefined}
                    action={entries.length > 0 ? { label: t("wh.clearFilters"), icon: "close", onClick: () => { setGenre(ALL); setDecade(ALL); setRes(ALL); setUnwatched(false); } } : undefined} />
            )}
        </div>
    );

    const px = remPx(CARD_REM.poster);
    return (
        <div className="wl-root" data-testid={`screen-library-${kind}`} data-lib-total={entries.length} data-lib-shown={view.length}>
            <Grid<LibEntry> gridId={gridId} className="wl-grid" header={header} items={view} itemKey={(e) => e.key} kind="poster"
                onItemFocus={onItemFocus}
                renderItem={(e) => {
                    const d = det(e);
                    const r = d?.res ?? e.res;
                    const fk = `${gridId}:${e.key}`;
                    const badges = [
                        ...(rankRes(r) >= 3 ? [{ label: "4K", tone: "neutral" as const }] : []),
                        ...(watched.has(e.key) ? [{ label: t("wh.watched"), icon: "check" as const, tone: "success" as const }] : []),
                    ];
                    return (
                        <PosterCard focusKey={fk} title={d?.title ?? e.guess} alwaysShowTitle testId="lib-card"
                            subtitle={[d?.year, kind === "tv" ? t("title.episodesCount", { n: e.files.length }) : null].filter(Boolean).join(" · ") || undefined}
                            image={d?.posterPath ? ctx.media.imageFor(d.posterPath, px) : null} badges={badges.length ? badges : undefined}
                            still={!d?.posterPath && e.files[0] ? ctx.client.stillUrl(e.files[0].serverFileId) : null}
                            placeholderIcon={kind === "tv" ? "tv" : "movie"} onSelect={() => { void open(e, fk); }} />
                    );
                }} />
            {sort === "az" && load.s === "ok" && view.length > 0 && (
                <div className="wl-az" role="navigation" aria-label={t("wh.sortAz")}>
                    {LETTERS.map((l) => (
                        <button key={l} type="button" className={letters.has(l) ? "is-active" : ""} data-focusable="" data-focus-key={`lib:az:${l}`}
                            disabled={!letters.has(l)} onClick={() => jump(l)}>{l}</button>
                    ))}
                </div>
            )}
            <SidePanel open={panel !== null} title={panelTitle} items={panel ? panelItems[panel] : []} value={panelValue}
                onSelect={pick} onClose={() => setPanel(null)} />
        </div>
    );
}
