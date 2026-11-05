"use client";

/**
 * Search (WP16-38): autofocused box, 250 ms debounce, `?q=` kept in the URL (shareable, Back restores it).
 * "In your library" first — the server index grouped per title and filtered locally (TMDB titles once resolved,
 * file names before) plus TMDB hits the server flagged `inLibrary` — then everything else from `/media/search`.
 * Keyboard: Enter / ↓ in the box focuses the first result, arrows move in the grids, Esc clears.
 * Recent searches per profile in localStorage.
 */
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useTranslations } from "next-intl";
import { Search, SearchX, X } from "lucide-react";
import { Button, EmptyState } from "@mmo/ui";
import type { LibraryIndexRow, TitleCard } from "@/lib/mmo/media-types";
import { BackdropProvider } from "../backdrop";
import { MxTitleCard } from "../title-card";
import { ErrorBlock, GridSkeleton, LibCard, PosterGrid, Unsupported, useMediaScope } from "./common";
import { useLibDetails } from "./details";
import { fold, groupLibrary, matchesQuery } from "./lib";
import { useAsync, useLocalList, writeList } from "./use-async";

export const SEARCH_DEBOUNCE_MS = 250;
const MIN_CHARS = 2;
const RECENT_MAX = 8;
const recentKey = (profile: string) => `mixai-web:recent-searches:${profile}`;

export function SearchScreen() {
    const t = useTranslations("mx.browse.search");
    const { media, scope } = useMediaScope();
    const params = useSearchParams();
    const router = useRouter();
    const pathname = usePathname() ?? "/media/search";
    const [q, setQ] = useState(() => params?.get("q") ?? "");
    const [debounced, setDebounced] = useState(q.trim());
    const input = useRef<HTMLInputElement>(null);
    const resultsRef = useRef<HTMLDivElement>(null);
    const details = useLibDetails(media);
    const profileId = media?.profile ?? "default";
    const recentStore = recentKey(profileId);
    const recent = useLocalList(recentStore).slice(0, RECENT_MAX);
    const setRecent = (list: string[]) => writeList(recentStore, list);

    useEffect(() => { input.current?.focus(); }, []);

    useEffect(() => {
        const h = setTimeout(() => setDebounced(q.trim()), SEARCH_DEBOUNCE_MS);
        return () => clearTimeout(h);
    }, [q]);

    // Keep `?q=` in sync without adding history entries per keystroke.
    useEffect(() => {
        const cur = params?.get("q") ?? "";
        if (cur === debounced) return;
        router.replace(debounced ? `${pathname}?q=${encodeURIComponent(debounced)}` : pathname, { scroll: false });
    }, [debounced, params, pathname, router]);

    const libLoad = useAsync<LibraryIndexRow[]>(scope ? `${scope}|library` : null, async () => {
        if (!media) return null;
        const idx = await media.mediaLibrary().catch(() => null);
        return idx?.items ?? [];
    }).load;
    const library = libLoad.s === "ok" ? libLoad.data : null;

    const active = debounced.length >= MIN_CHARS;
    const search = useAsync<TitleCard[]>(scope && active ? `${scope}|q|${debounced}` : null, async () => {
        if (!media) return null;
        const p = await media.mediaSearch(debounced);
        return p ? p.results : null;
    });
    const results = search.load;

    const entries = useMemo(() => (library ? [...groupLibrary(library, "movie"), ...groupLibrary(library, "tv")] : []), [library]);
    // Resolve library titles in the background so local matching uses real names, not only file names.
    const want = details.want;
    useEffect(() => { if (active && entries.length > 0) want(entries); }, [active, entries, want]);

    const titles = results.s === "ok" ? results.data : [];
    const libHits = useMemo(() => {
        void details.tick;
        if (!active) return [];
        return entries.filter((e) => !details.restricted(e) && matchesQuery(details.get(e)?.title ?? e.guess, debounced)).slice(0, 60);
    }, [active, entries, details, debounced]);
    const libKeys = useMemo(() => new Set(libHits.map((e) => e.key)), [libHits]);
    const flagged = titles.filter((c) => c.inLibrary && !libKeys.has(`${c.kind}:${c.tmdbId}`));
    const rest = titles.filter((c) => !c.inLibrary && !libKeys.has(`${c.kind}:${c.tmdbId}`));
    const libCount = libHits.length + flagged.length;

    const remember = () => {
        if (!active) return;
        const next = [debounced, ...recent.filter((x) => fold(x) !== fold(debounced))].slice(0, RECENT_MAX);
        setRecent(next);
    };

    const focusFirst = () => {
        const first = resultsRef.current?.querySelector<HTMLElement>("ul > li > a[href]");
        if (first) { first.focus(); remember(); return true; }
        return false;
    };

    const onInputKey = (e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "Enter" || e.key === "ArrowDown") {
            if (e.key === "Enter") setDebounced(q.trim());
            if (focusFirst()) e.preventDefault();
        } else if (e.key === "Escape" && q) {
            e.preventDefault();
            setQ("");
        }
    };

    const loading = active && results.s === "loading";
    const nothing = active && results.s === "ok" && titles.length === 0 && libHits.length === 0;

    return (
        <BackdropProvider>
            <div className="mx-page-head">
                <h1 className="mx-page-title">{t("title")}</h1>
            </div>
            <form role="search" className="mxb-search" onSubmit={(e) => { e.preventDefault(); setDebounced(q.trim()); focusFirst(); }}>
                <Search aria-hidden className="size-5" />
                <label htmlFor="mxb-search-input" className="sr-only">{t("label")}</label>
                <input
                    id="mxb-search-input"
                    ref={input}
                    type="search"
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    onKeyDown={onInputKey}
                    placeholder={t("placeholder")}
                    autoComplete="off"
                    spellCheck={false}
                    enterKeyHint="search"
                    aria-describedby="mxb-search-hint"
                    aria-controls="mxb-search-results"
                />
                <p id="mxb-search-hint" className="sr-only">{t("hint")}</p>
            </form>

            <div id="mxb-search-results" ref={resultsRef} aria-live="polite" aria-busy={loading || undefined}>
                {!active ? (
                    recent.length > 0 ? (
                        <section className="mxb-section" aria-labelledby="mxb-recent-h">
                            <div className="flex items-center justify-between gap-2">
                                <h2 id="mxb-recent-h" className="mxb-h2">{t("recent")}</h2>
                                <Button variant="ghost" size="sm" onClick={() => setRecent([])}>
                                    <X aria-hidden className="size-4" /> {t("clearRecent")}
                                </Button>
                            </div>
                            <div className="mxb-recent">
                                {recent.map((r) => (
                                    <button key={r} type="button" className="mxb-chip" onClick={() => { setQ(r); setDebounced(r); input.current?.focus(); }}>{r}</button>
                                ))}
                            </div>
                        </section>
                    ) : (
                        <EmptyState className="mt-8" icon={<Search aria-hidden />} title={t("idle")} description={t("idleBody")} />
                    )
                ) : null}

                {active && libCount > 0 ? (
                    <section className="mxb-section" aria-labelledby="mxb-lib-h">
                        <h2 id="mxb-lib-h" className="mxb-h2">{t("inLibrary")} <span className="mxb-count">({libCount})</span></h2>
                        <PosterGrid label={t("inLibrary")}>
                            {libHits.map((e) => <li key={e.key}><LibCard entry={e} details={details.get(e)} /></li>)}
                            {flagged.map((c) => <li key={`${c.kind}:${c.tmdbId}`}><MxTitleCard item={c} /></li>)}
                        </PosterGrid>
                    </section>
                ) : null}

                {active && results.s === "loading" ? (
                    <section className="mxb-section"><GridSkeleton count={12} label={t("loading")} /></section>
                ) : null}
                {active && results.s === "error" ? <ErrorBlock error={results.error} onRetry={search.retry} /> : null}
                {active && results.s === "unsupported" ? <Unsupported /> : null}
                {active && rest.length > 0 ? (
                    <section className="mxb-section" aria-labelledby="mxb-res-h">
                        <h2 id="mxb-res-h" className="mxb-h2">{t("results")} <span className="mxb-count">({rest.length})</span></h2>
                        <PosterGrid label={t("results")}>
                            {rest.map((c) => <li key={`${c.kind}:${c.tmdbId}`}><MxTitleCard item={c} /></li>)}
                        </PosterGrid>
                    </section>
                ) : null}
                {nothing ? <EmptyState className="mt-8" icon={<SearchX aria-hidden />} title={t("empty", { q: debounced })} description={t("emptyBody")} /> : null}
                {active ? <p className="sr-only" role="status">{loading ? t("loading") : t("count", { count: libCount + rest.length })}</p> : null}
            </div>
        </BackdropProvider>
    );
}
