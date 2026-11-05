/**
 * Home (WP16-32): cinematic backdrop-first. `media.homeCached()` paints instantly, `revalidateHome()` swaps rows in
 * place (focus kept by `data-focus-key`). The hero follows the focused card (150 ms debounce) with the TMDB logo,
 * chips, overview and Play/Resume · More info · My list; the backdrop follows too. Rows are virtualised (`Row`):
 * `continue` = LandscapeCard with progress + S/E (OK plays), the rest PosterCards (OK opens the title).
 * Server without `/media` (or empty) → rows from the `/video/scan` list (movies + shows).
 * Perf: `console.info('[perf] home first paint', ms, 'cached', bool)` + `window.__mixaiPerf`.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ProbedVideo } from "../lib/api";
import { focusByKey, currentFocus } from "../lib/focus";
import { preload, remPx } from "../lib/image";
import type { HomeRow, MediaHome, TitleCard } from "../lib/media-types";
import { groupShows, isEpisode, type Show } from "../lib/shows";
import { t } from "../i18n/messages";
import type { ScreenProps } from "../nav/ctx";
import { useScreenActive } from "../nav/Nav";
import { CARD_REM, Empty, ErrorState, LandscapeCard, LoadingRows, PosterCard, Row, useBackdrop } from "../ui";
import { HomeHero } from "./home/HomeHero";
import { cardKey, fileBase, playTitle } from "./home/media-ui";
import { cardBadges, cardSubtitle, rememberFlipSource } from "./home/widgets";
import { motionReduced } from "../lib/prefs";
import "./home/home.css";

type Scan = { s: "idle" } | { s: "loading" } | { s: "ok"; videos: ProbedVideo[] } | { s: "error"; message: string };
type Remote = { s: "loading" } | { s: "ok" } | { s: "error"; message: string };

declare global { interface Window { __mixaiPerf?: Record<string, unknown> } }

const HERO_DEBOUNCE_MS = 150;
/** Staged entrance length (home.css `.is-entering`: last row delay 410 + 270 ms) + slack. */
const ENTRANCE_MS = 760;
const mountedAt = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

function epLabel(c: TitleCard): string | undefined {
    const n = c.nextEpisode;
    return n && n.season > 0 ? t("wh.epCode", { s: n.season, e: n.episode }) : undefined;
}

export function Home({ ctx }: ScreenProps<"home">) {
    const t0 = useRef(mountedAt());
    const [home, setHome] = useState<MediaHome | null>(() => ctx.media.homeCached());
    const cachedAtMount = useRef(home !== null && home.rows.some((r) => r.items.length > 0));
    const [remote, setRemote] = useState<Remote>(() => (cachedAtMount.current ? { s: "ok" } : { s: "loading" }));
    const [unsupported, setUnsupported] = useState(false);
    const [scan, setScan] = useState<Scan>({ s: "idle" });
    const [hero, setHero] = useState<TitleCard | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const heroTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const painted = useRef(false);
    const focusedOnce = useRef(false);
    const rootRef = useRef<HTMLDivElement>(null);
    const backdrop = useBackdrop();
    const active = useScreenActive();

    const rows = useMemo<HomeRow[]>(() => (home?.rows ?? []).filter((r) => r.items.length > 0), [home]);
    const mediaMode = rows.length > 0;

    // ─── Revalidate (mount + every time the screen comes back, e.g. after the player) ───
    const revalidate = useCallback((force = false) => {
        const keep = currentFocus()?.getAttribute("data-focus-key") ?? null;
        ctx.media.revalidateHome(force)
            .then((fresh) => {
                setRemote({ s: "ok" });
                if (fresh) {
                    setHome(fresh);
                    if (keep) requestAnimationFrame(() => { if (!document.querySelector(`[data-focus-key="${keep}"]`)) return; if (currentFocus()?.getAttribute("data-focus-key") !== keep) focusByKey(keep); });
                } else if (!ctx.media.homeCached()) setUnsupported(true);
            })
            .catch((e: Error) => setRemote({ s: "error", message: e.message }));
    }, [ctx.media]);

    useEffect(() => { revalidate(); }, [revalidate]);
    const wasActive = useRef(active);
    useEffect(() => {
        if (active && !wasActive.current) revalidate();
        wasActive.current = active;
    }, [active, revalidate]);

    // ─── Scan fallback ───────────────────────────────────────────────────
    const needScan = !mediaMode && (unsupported || remote.s === "error" || (remote.s === "ok" && rows.length === 0));
    useEffect(() => {
        if (!needScan || scan.s !== "idle") return;
        setScan({ s: "loading" });
        ctx.client.listVideos()
            .then((videos) => setScan({ s: "ok", videos }))
            .catch((e: Error) => setScan({ s: "error", message: e.message }));
    }, [needScan, scan.s, ctx.client]);

    // ─── Perf: first paint with real rows ────────────────────────────────
    const hasContent = mediaMode || scan.s === "ok";
    const entered = useRef(false);
    useLayoutEffect(() => {
        if (!hasContent || entered.current) return;
        entered.current = true;
        const root = rootRef.current;
        if (root && !motionReduced()) {
            // Before the first content paint, on the DOM (not state): no flash, no extra render.
            root.classList.add("is-entering");
            try { performance.mark("mixai:home-enter-start"); } catch { /* old engines */ }
            setTimeout(() => {
                root.classList.remove("is-entering");
                try { performance.mark("mixai:home-enter-end"); performance.measure("mixai:home-enter", "mixai:home-enter-start", "mixai:home-enter-end"); } catch { /* ignore */ }
            }, ENTRANCE_MS);
        }
    }, [hasContent]);
    useEffect(() => {
        if (!hasContent || painted.current) return;
        painted.current = true;
        requestAnimationFrame(() => {
            const now = mountedAt();
            const perf = { homeFirstPaintMs: Math.round(now), sinceMountMs: Math.round(now - t0.current), cached: cachedAtMount.current, mode: mediaMode ? "media" : "scan" };
            window.__mixaiPerf = { ...(window.__mixaiPerf ?? {}), ...perf };
            console.info("[perf] home first paint", perf.homeFirstPaintMs, "cached", perf.cached, "sinceMount", perf.sinceMountMs);
        });
    }, [hasContent, mediaMode]);

    // ─── Hero + backdrop follow focus ────────────────────────────────────
    const firstHero = useMemo(() => {
        for (const r of rows) if (r.id !== "continue") for (const c of r.items) if (c.backdropPath) return c;
        return rows[0]?.items[0] ?? null;
    }, [rows]);
    useEffect(() => { if (!hero && firstHero) setHero(firstHero); }, [hero, firstHero]);
    useEffect(() => {
        if (!active) return;
        const c = hero ?? firstHero;
        backdrop.show(c?.backdropPath ? ctx.media.image(c.backdropPath, "w1280") : null);
    }, [active, hero, firstHero, backdrop, ctx.media]);
    useEffect(() => () => { if (heroTimer.current) clearTimeout(heroTimer.current); }, []);

    const onCardFocus = useCallback((c: TitleCard, list: TitleCard[], i: number) => {
        if (heroTimer.current) clearTimeout(heroTimer.current);
        heroTimer.current = setTimeout(() => setHero(c), HERO_DEBOUNCE_MS);
        const px = remPx(CARD_REM.poster);
        void preload(list.slice(i + 1, i + 7).map((x) => ctx.media.imageFor(x.posterPath, px)));
        const next = list[i + 1];
        if (next?.backdropPath) void preload([ctx.media.image(next.backdropPath, "w1280")]);
    }, [ctx.media]);

    // ─── First focus: first card of the first row (not the hero buttons) ─
    useEffect(() => {
        if (focusedOnce.current || !hasContent || !active) return;
        const first = rows[0]?.items[0];
        const key = first ? `home:${rows[0]!.id}:${cardKey(first)}` : null;
        const h = requestAnimationFrame(() => {
            focusedOnce.current = true;
            const cur = currentFocus();
            if (cur && cur.closest(".wh-rows")) return;
            if (key) focusByKey(key);
        });
        return () => cancelAnimationFrame(h);
    }, [hasContent, rows, active]);

    // ─── Actions ─────────────────────────────────────────────────────────
    const openTitle = useCallback((c: TitleCard, focusKey: string) => {
        rememberFlipSource(focusKey, ctx.media.imageFor(c.posterPath, remPx(CARD_REM.poster)));
        ctx.nav.push({ name: "title", kind: c.kind, tmdbId: c.tmdbId, seed: c });
    }, [ctx.media, ctx.nav]);

    const playContinue = useCallback(async (c: TitleCard, focusKey: string) => {
        setBusy(cardKey(c));
        try {
            if (!(await playTitle(ctx, c.kind, c.tmdbId))) openTitle(c, focusKey);
        } catch { openTitle(c, focusKey); }
        finally { setBusy(null); }
    }, [ctx, openTitle]);

    const playScan = useCallback(async (v: ProbedVideo) => {
        setBusy(v.fileId);
        try {
            const video = await ctx.client.resolveVideo(v.fileId, v.path);
            ctx.nav.push({ name: "player", item: { kind: "video", video } });
        } catch { /* Player shows its own errors; resolve failure keeps us here */ }
        finally { setBusy(null); }
    }, [ctx.client, ctx.nav]);

    const lang = ctx.lang;
    const renderRow = (r: HomeRow) => {
        const isCont = r.id === "continue";
        const px = remPx(isCont ? CARD_REM.landscape : CARD_REM.poster);
        return (
            <Row<TitleCard> key={r.id} rowId={`home:${r.id}`} title={r.title[lang] ?? r.title.ro} items={r.items} testId="media-row"
                kind={isCont ? "landscape" : "poster"} itemKey={cardKey}
                onItemFocus={(c, i) => onCardFocus(c, r.items, i)}
                renderItem={(c) => {
                    const fk = `home:${r.id}:${cardKey(c)}`;
                    return isCont ? (
                        <LandscapeCard focusKey={fk} title={c.title} subtitle={epLabel(c) ?? cardSubtitle(c)} progress={c.progress ?? null}
                            image={ctx.media.imageFor(c.backdropPath ?? c.posterPath, px)} placeholderIcon={c.kind === "tv" ? "tv" : "movie"}
                            alwaysShowTitle testId="continue-card" badges={busy === cardKey(c) ? [{ label: t("common.loading"), tone: "neutral" }] : undefined}
                            onSelect={() => { void playContinue(c, fk); }} />
                    ) : (
                        <PosterCard focusKey={fk} title={c.title} subtitle={cardSubtitle(c)} badges={cardBadges(c)} progress={c.progress ?? null}
                            image={ctx.media.imageFor(c.posterPath, px)} placeholderIcon={c.kind === "tv" ? "tv" : "movie"} testId="media-card"
                            onSelect={() => openTitle(c, fk)} />
                    );
                }} />
        );
    };

    return (
        <div ref={rootRef} className="wh-home" data-testid="screen-home">
            <div className="wh-hero">
                <div className="wh-hero-inner">
                    {mediaMode
                        ? <HomeHero ctx={ctx} card={hero ?? firstHero} />
                        : <h1 className="wh-name">{t("screen.home")}</h1>}
                </div>
            </div>
            <div className="wh-rows" data-scroll="home-rows">
                {mediaMode && rows.map(renderRow)}
                {!mediaMode && remote.s === "loading" && <LoadingRows rows={2} />}
                {!mediaMode && remote.s !== "loading" && <ScanRows ctx={ctx} scan={scan} busy={busy} onPlay={playScan}
                    onOpenShow={(show) => ctx.nav.push({ name: "show", show })}
                    onRetry={() => { setScan({ s: "idle" }); setRemote({ s: "loading" }); revalidate(true); }}
                    mediaError={remote.s === "error" ? remote.message : null} />}
            </div>
        </div>
    );
}

function ScanRows({ ctx, scan, busy, onPlay, onOpenShow, onRetry, mediaError }: {
    ctx: ScreenProps<"home">["ctx"]; scan: Scan; busy: string | null; mediaError: string | null;
    onPlay: (v: ProbedVideo) => void; onOpenShow: (s: Show) => void; onRetry: () => void;
}) {
    const all = scan.s === "ok" ? scan.videos : [];
    const movies = useMemo(() => all.filter((v) => !isEpisode(v)), [all]);
    const shows = useMemo(() => groupShows(all), [all]);
    if (scan.s === "loading" || scan.s === "idle") return <LoadingRows rows={2} />;
    if (scan.s === "error") return <ErrorState message={mediaError ?? scan.message} onRetry={onRetry} />;
    if (movies.length === 0 && shows.length === 0) {
        return <Empty icon="movie" title={t("wh.emptyTitle")} message={t("home.moviesEmpty")} action={{ label: t("common.retry"), icon: "refresh", onClick: onRetry }} />;
    }
    const px = remPx(CARD_REM.poster);
    const art = (v: ProbedVideo) => (v.posterPath ? ctx.client.tmdbImageUrl(v.posterPath, px > 185 ? "w342" : "w185") : ctx.client.stillUrl(v.fileId));
    return (
        <>
            {movies.length > 0 && (
                <Row<ProbedVideo> rowId="home:scan-movies" title={t("home.movies")} items={movies} itemKey={(v) => v.fileId} testId="media-row"
                    renderItem={(v) => (
                        <PosterCard focusKey={`home:scan:${v.fileId}`} title={v.parsed.title || fileBase(v.path)} subtitle={v.parsed.year ? String(v.parsed.year) : undefined}
                            image={art(v)} testId="scan-card" badges={busy === v.fileId ? [{ label: t("common.loading"), tone: "neutral" }] : undefined}
                            onSelect={() => onPlay(v)} />
                    )} />
            )}
            {shows.length > 0 && (
                <Row<Show> rowId="home:scan-shows" title={t("home.shows")} items={shows} itemKey={(s) => s.key} testId="media-row"
                    renderItem={(s) => (
                        <PosterCard focusKey={`home:show:${s.key}`} title={s.title} subtitle={t("home.episodes", { n: s.episodes.length })}
                            image={art(s.episodes[0]!)} placeholderIcon="tv" onSelect={() => onOpenShow(s)} />
                    )} />
            )}
        </>
    );
}
