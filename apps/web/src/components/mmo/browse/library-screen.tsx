"use client";

/**
 * Library grid (WP16-38, `/media/browse/{movie|tv}`): the server's own files (`/media/library`) grouped per title.
 * Cards resolve TMDB details lazily (≤ 4 concurrent `/media/title`, session cache) — guessed names until then.
 * Sort (recent / A–Z / year / rating), genre chips, unwatched filter (from `/media/progress`), A–Z jump bar.
 * Scales to 1000+ titles: the grid renders in growing pages (IntersectionObserver sentinel) and every card uses
 * `content-visibility:auto`, so off-screen cards cost neither layout nor paint. Sort/filters live in the URL.
 */
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Film, Tv } from "lucide-react";
import { Button, EmptyState } from "@mmo/ui";
import type { LibraryIndexRow, MediaKind, ProgressEntry } from "@/lib/mmo/media-types";
import { BackdropProvider } from "../backdrop";
import { ErrorBlock, GridSkeleton, LibCard, PosterGrid, Unsupported, useMediaScope } from "./common";
import { useLibDetails } from "./details";
import {
    genreList, groupLibrary, LETTERS, letterIndex, SORTS, sortEntries, watchedKeys, type LibEntry, type SortKey,
} from "./lib";
import { useAsync } from "./use-async";

const PAGE = 120;
const isSort = (s: string | null | undefined): s is SortKey => !!s && (SORTS as readonly string[]).includes(s);

export function LibraryScreen({ kind }: { kind: MediaKind }) {
    const t = useTranslations("mx.browse.library");
    const { media, scope } = useMediaScope();
    const params = useSearchParams();
    const router = useRouter();
    const pathname = usePathname() ?? `/media/browse/${kind}`;
    const sortParam = params?.get("sort");
    const sort: SortKey = isSort(sortParam) ? sortParam : "recent";
    const genre = params?.get("genre") ?? "";
    const unwatched = params?.get("unwatched") === "1";
    const { load, retry } = useAsync<LibraryIndexRow[]>(scope ? `${scope}|library` : null, async (attempt) => {
        if (!media) return null;
        if (attempt > 0) media.invalidate();
        const idx = await media.mediaLibrary();
        return idx ? idx.items : null;
    });
    const progressLoad = useAsync<ProgressEntry[]>(scope ? `${scope}|progress` : null, async () => {
        if (!media) return null;
        const p = await media.getProgress().catch(() => null);
        return p?.entries ?? [];
    }).load;
    const progress = progressLoad.s === "ok" ? progressLoad.data : null;
    const [limit, setLimit] = useState(PAGE);
    const sentinel = useRef<HTMLDivElement>(null);
    const gridEl = useRef<HTMLUListElement | null>(null);
    const pendingJump = useRef<number | null>(null);
    const details = useLibDetails(media);
    const { want, get, restricted, tick } = details;

    const setParam = useCallback((key: string, value: string | null) => {
        const next = new URLSearchParams(params?.toString() ?? "");
        if (value) next.set(key, value); else next.delete(key);
        const qs = next.toString();
        router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
        setLimit(PAGE);
    }, [params, pathname, router]);

    const entries = useMemo(() => (load.s === "ok" ? groupLibrary(load.data, kind) : []), [load, kind]);
    const watched = useMemo(() => watchedKeys(entries, progress ?? []), [entries, progress]);
    const progressOf = useMemo(() => {
        const m = new Map<string, number>();
        for (const p of progress ?? []) {
            if (p.kind !== kind || p.completed || p.durationSec <= 0 || p.positionSec <= 0) continue;
            m.set(`${p.kind}:${p.tmdbId}`, Math.max(m.get(`${p.kind}:${p.tmdbId}`) ?? 0, p.positionSec / p.durationSec));
        }
        return m;
    }, [progress, kind]);

    // Sorting/filtering by anything but "recent" needs every title's details → resolve all in the background.
    const needsAll = sort !== "recent" || genre !== "";
    useEffect(() => { if (needsAll && entries.length > 0) want(entries); }, [needsAll, entries, want]);

    const view = useMemo(() => {
        void tick;
        const list = entries.filter((e) => {
            if (restricted(e)) return false;
            if (unwatched && watched.has(e.key)) return false;
            if (genre && !get(e)?.genres.includes(genre)) return false;
            return true;
        });
        return sortEntries(list, sort, (e) => {
            const d = get(e);
            return { name: d?.title ?? e.guess, year: d?.year ?? null, rating: d?.rating ?? null };
        });
    }, [entries, tick, restricted, unwatched, watched, genre, get, sort]);

    const shown = useMemo(() => view.slice(0, limit), [view, limit]);
    // Visible page first (urgent), so posters appear where the user looks.
    useEffect(() => { if (shown.length > 0) want(shown, true); }, [shown, want]);

    const genres = useMemo(() => { void tick; return genreList(entries.map((e) => get(e))); }, [entries, get, tick]);
    const names = useMemo(() => view.map((e) => get(e)?.title ?? e.guess), [view, get]);
    const letters = useMemo(() => (sort === "az" ? letterIndex(names) : null), [sort, names]);

    // Grow the rendered page when the sentinel scrolls into view.
    useEffect(() => {
        const el = sentinel.current;
        if (!el || limit >= view.length) return;
        const io = new IntersectionObserver((xs) => { if (xs.some((x) => x.isIntersecting)) setLimit((n) => n + PAGE); }, { rootMargin: "1200px 0px" });
        io.observe(el);
        return () => io.disconnect();
    }, [limit, view.length]);

    const jump = (letter: string) => {
        const i = letters?.get(letter);
        if (i == null) return;
        pendingJump.current = i;
        if (i >= limit) setLimit(i + PAGE); else focusIndex(i);
    };
    const focusIndex = (i: number) => {
        const a = gridEl.current?.querySelectorAll<HTMLElement>(":scope > li")[i]?.querySelector<HTMLElement>("a[href]");
        pendingJump.current = null;
        if (!a) return;
        a.focus({ preventScroll: true });
        a.scrollIntoView({ block: "center" });
    };
    useEffect(() => { if (pendingJump.current != null && pendingJump.current < limit) focusIndex(pendingJump.current); }, [limit]);

    const Icon = kind === "movie" ? Film : Tv;
    const heading = kind === "movie" ? t("movies") : t("shows");

    return (
        <BackdropProvider>
            <div className="mx-page-head">
                <div>
                    <h1 className="mx-page-title">{heading}</h1>
                    {load.s === "ok" ? <p className="mxb-count" role="status">{t("count", { count: view.length })}</p> : null}
                </div>
                <div className="mxb-toolbar">
                    <label className="sr-only" htmlFor="mxb-sort">{t("sortLabel")}</label>
                    <select id="mxb-sort" className="mxb-select" value={sort} onChange={(e) => setParam("sort", e.target.value === "recent" ? null : e.target.value)}>
                        {SORTS.map((s) => <option key={s} value={s}>{t(`sort.${s}`)}</option>)}
                    </select>
                    {progress && progress.length > 0 ? (
                        <button type="button" className="mxb-chip" aria-pressed={unwatched} onClick={() => setParam("unwatched", unwatched ? null : "1")}>
                            {t("unwatched")}
                        </button>
                    ) : null}
                </div>
            </div>

            {genres.length > 0 ? (
                <div className="mxb-chips" role="group" aria-label={t("genres")}>
                    <button type="button" className="mxb-chip" aria-pressed={genre === ""} onClick={() => setParam("genre", null)}>{t("allGenres")}</button>
                    {genres.map((g) => (
                        <button key={g} type="button" className="mxb-chip" aria-pressed={genre === g} onClick={() => setParam("genre", genre === g ? null : g)}>{g}</button>
                    ))}
                </div>
            ) : null}

            {load.s === "loading" ? <GridSkeleton label={t("loading")} /> : null}
            {load.s === "error" ? <ErrorBlock error={load.error} onRetry={retry} /> : null}
            {load.s === "unsupported" ? <Unsupported /> : null}
            {load.s === "ok" && entries.length === 0 ? (
                <EmptyState icon={<Icon aria-hidden />} title={t("empty")} description={t("emptyBody")} />
            ) : null}
            {load.s === "ok" && entries.length > 0 && view.length === 0 ? (
                <EmptyState
                    icon={<Icon aria-hidden />}
                    title={needsAll && details.pending() > 0 ? t("resolving") : t("noMatch")}
                    description={t("noMatchBody")}
                    actions={<Button variant="secondary" onClick={() => router.replace(pathname, { scroll: false })}>{t("clearFilters")}</Button>}
                />
            ) : null}

            {view.length > 0 ? (
                <div className="mxb-lib">
                    <div>
                        <PosterGrid label={heading} gridRef={(el) => { gridEl.current = el; }}>
                            {shown.map((e) => (
                                <li key={e.key}>
                                    <LibCard entry={e} details={get(e)} progress={e.tmdbId != null ? progressOf.get(`${kind}:${e.tmdbId}`) ?? (watched.has(e.key) ? 1 : null) : null} />
                                </li>
                            ))}
                        </PosterGrid>
                        {limit < view.length ? <div ref={sentinel} className="h-px" aria-hidden /> : null}
                    </div>
                    {letters ? (
                        <nav className="mxb-jump" aria-label={t("jump")}>
                            {LETTERS.map((l) => (
                                <button key={l} type="button" disabled={!letters.has(l)} onClick={() => jump(l)} aria-label={t("jumpTo", { letter: l })}>{l}</button>
                            ))}
                        </nav>
                    ) : null}
                </div>
            ) : null}
        </BackdropProvider>
    );
}
