import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { FolderOpen, Heart, Link2Off, ListX, Music, SearchX, Settings, Sparkles, TriangleAlert, WifiOff } from "lucide-react";
import { engine } from "@/bridge/engine";
import type { DeckId, LibraryTrack } from "@/bridge/types";
import { useMixerStore } from "@/state/mixer-store";
import { useUiStore } from "@/state/ui-store";
import { useGigLocked } from "@/gig/gig-store";
import { useAutoMixStore } from "@/state/auto-mix-store";
import { playedTonight, useHistoryStore } from "@/state/history-store";
import { usePerfStore } from "@/state/perf-store";
import { loadLibraryTrack, restoreDeckWave } from "@/lib/load-track";
import { keyMatch } from "@/components/KeyChip";
import { separateStems, useStemJobs } from "@/components/deck-tabs/stem-jobs";
import { useLocale, useT, type Translate } from "@/i18n";
import { usePanelTier } from "@/layout/panel-tier";
import type { Tier } from "@/layout/types";
import { ScrolllessList } from "@/library/ScrolllessList";
import { keyAction, useTouchMode, useWindowedList } from "@/library/useWindowedList";
import { libraryNav } from "@/library/library-nav";
import { useLibraryPool } from "@/library/pool-store";
import { CopilotButton } from "@/copilot/CopilotButton";
import { ColumnHeader, DeckDot, DeckLetter, TrackRow, stemsView, trackTitle, type StemJobState } from "@/library/LibraryRows";
import { StateBlock } from "@/library/LibraryStates";
import {
    FilterChips,
    NO_FILTERS,
    OptionsPopover,
    PopSection,
    SearchField,
    SortButtons,
    SourceTabs,
    activeFilterCount,
    type Filters,
    type Source,
} from "@/library/LibraryToolbar";
import {
    DEFAULT_SORT,
    ICON_COLUMNS,
    byScore,
    compactColumns,
    decodeDecks,
    encodeDecks,
    filterTracks,
    fmtBpm,
    freeDeck,
    fullColumns,
    nextSort,
    pluralCategory,
    rankMatches,
    sortTracks,
    type MatchRef,
    type Ranked,
    type SortKey,
    type SortState,
} from "@/library/track-view";

/**
 * Library browser. Two sources:
 *   - **Companion**: browse the mixai.ro library served by the local MMO
 *     Server (`server/`) over HTTP, proxied through Rust. Tracks live on the
 *     same machine, so loading uses the row's local `filepath` directly.
 *   - **Local**: pick any audio file from disk (Tauri dialog).
 *
 * "Pro" table (Decks 1.5): 22 px zebra rows, a sortable header, a status dot for tracks on a
 * deck, dimmed rows for tracks played tonight, an overview-waveform preview, key chips with
 * the match against the master deck, and filter chips ("matches deck", "not played tonight",
 * favourites). Pieces live in `@/library/*`; the pure logic in `@/library/track-view`.
 *
 * Zero scroll: the track list is a scroll-less virtualised window
 * (`@/library/ScrolllessList`) that shows exactly the rows that fit and moves
 * row by row (wheel, keys, touch, controller via `libraryNav`). Layout follows
 * the panel tier: full (toolbar + header + columns), compact (search + short rows),
 * icon (search + title list + load buttons). Whatever a tier cannot show inline sits in
 * the "Library options" popover (also opened with Shift+F10 from the list).
 */

/** Width of the position-thumb slot / horizontal row padding per tier: keep in step with library.css. */
const ROW_PAD: Record<Tier, number> = { full: 8, compact: 6, icon: 4 };
/** The companion serves 100 tracks per page; pages are fetched until this many tracks are loaded. */
const PAGE_SIZE = 100;
const MAX_TRACKS = 2000;

interface SourceProps {
    tier: Tier;
    source: Source;
    setSource: (s: Source) => void;
}

export function Library() {
    const tier = usePanelTier();
    const [source, setSource] = useState<Source>("companion");
    const props = { tier, source, setSource };
    return (
        <div className="panel lib-root" data-tier={tier}>
            {source === "companion" ? <CompanionLibrary {...props} /> : <LocalFiles {...props} />}
        </div>
    );
}

/** The source switch as a popover section (tiers without the inline tabs). */
function SourceSection({ t, source, setSource }: { t: Translate; source: Source; setSource: (s: Source) => void }) {
    return (
        <PopSection label={t("libraryui.source")}>
            {(["companion", "local"] as const).map((s) => (
                <button key={s} type="button" className="dk-btn" aria-pressed={source === s} onClick={() => setSource(s)}>
                    {t(s === "companion" ? "library.companion" : "library.local")}
                </button>
            ))}
        </PopSection>
    );
}

// ─── Companion ──────────────────────────────────────────────────────────────

type Status = "checking" | "offline" | "unconfigured" | "ready";

function CompanionLibrary({ tier, source, setSource }: SourceProps) {
    const t = useT();
    const locale = useLocale();
    const touch = useTouchMode();
    const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
    // Gig lock: the buttons stay focusable; pressing one says why Settings stay closed (ui-store asks the gate).
    const gigLocked = useGigLocked();
    // One string for all the library needs from the decks: it changes when a deck loads, starts /
    // stops or changes tempo, not on every engine snapshot (idle and playback stay free).
    const deckKey = useMixerStore((s) => encodeDecks(s.decks));
    const decks = useMemo(() => decodeDecks(deckKey), [deckKey]);
    const deckKeys = useMixerStore((s) => s.deckKeys);
    const clockSource = usePerfStore((s) => s.clock?.source ?? null);
    const played = useHistoryStore((s) => s.played);
    const setPool = useAutoMixStore((s) => s.setPool);

    const [query, setQuery] = useState("");
    const [tracks, setTracks] = useState<LibraryTrack[]>([]);
    const [total, setTotal] = useState(0);
    // The companion has answered a track query at least once (an empty list before that is not "an empty library").
    const [answered, setAnswered] = useState(false);
    const [status, setStatus] = useState<Status>("checking");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [sort, setSort] = useState<SortState>(DEFAULT_SORT);
    const [filters, setFilters] = useState<Filters>(NO_FILTERS);
    // With a "matches deck" filter the best transition comes first, until a column is clicked.
    const [scoreOrder, setScoreOrder] = useState(true);
    // Stem-separation jobs by track id: the store the deck's STEMS tab uses, so a remount of the
    // library keeps the progress and a track never gets a second job.
    const stemJob: Record<string, StemJobState | undefined> = useStemJobs((s) => s.jobs);
    const [menuOpen, setMenuOpen] = useState(false);
    // Last load that failed (file not reachable from this machine, decode error): the row and the toolbar say so.
    const [loadError, setLoadError] = useState<{ id: number; deck: DeckId; title: string; message: string } | null>(null);
    const loadSeq = useRef<Partial<Record<DeckId, number>>>({});
    const searchRef = useRef<HTMLInputElement | null>(null);
    const listRef = useRef<HTMLDivElement | null>(null);

    // Probe the companion on mount.
    useEffect(() => {
        let live = true;
        engine.companionStatus().then(
            (st) => {
                if (!live) return;
                if (!st || !st.online) setStatus("offline");
                else if (!st.authed) setStatus("unconfigured");
                else setStatus("ready");
            },
            // A probe that fails is an unreachable companion, not "checking" forever.
            () => {
                if (live) setStatus("offline");
            },
        );
        return () => {
            live = false;
        };
    }, []);

    // Newest request wins; an older one that resolves late is dropped.
    const reqRef = useRef(0);
    /**
     * Fetch the library in the companion's `sort` order, page after page (up to `MAX_TRACKS`).
     * `progressive` shows each page as it arrives (first load, search); a re-sort swaps the
     * list once, when complete (the rows on screen are already re-sorted locally).
     */
    const fetchTracks = useCallback(async (search: string, by: SortState, progressive: boolean) => {
        const req = ++reqRef.current;
        setLoading(true);
        setError(null);
        try {
            const opts = { search, sort: by.key, order: by.dir };
            const first = await engine.companionTracks(opts);
            if (req !== reqRef.current) return;
            if (first) {
                setAnswered(true);
                const seen = new Set<number>();
                let acc = first.tracks.filter((x) => !seen.has(x.id) && seen.add(x.id));
                if (progressive) setTracks(acc);
                setTotal(first.total);
                const pages = Math.min(first.totalPages, Math.ceil(MAX_TRACKS / PAGE_SIZE));
                for (let page = 2; page <= pages; page++) {
                    const next = await engine.companionTracks({ ...opts, page });
                    if (req !== reqRef.current) return;
                    if (!next || next.tracks.length === 0) break;
                    acc = acc.concat(next.tracks.filter((x) => !seen.has(x.id) && seen.add(x.id)));
                    if (progressive) setTracks(acc);
                }
                if (!progressive) setTracks(acc);
            }
        } catch (e) {
            if (req === reqRef.current) setError(e instanceof Error ? e.message : String(e));
        } finally {
            if (req === reqRef.current) setLoading(false);
        }
    }, []);

    // Load tracks once ready; debounce on query change. A sort change re-queries in that order
    // without blanking the list.
    const fetched = useRef<{ query: string } | null>(null);
    useEffect(() => {
        if (status !== "ready") return;
        const progressive = fetched.current?.query !== query;
        const id = setTimeout(() => {
            fetched.current = { query };
            void fetchTracks(query, sort, progressive);
        }, 250);
        return () => clearTimeout(id);
    }, [status, query, sort, fetchTracks]);

    // Keep the auto-mix candidate pool in sync with the loaded library so the
    // "AI DJ" can auto-queue the next harmonic match.
    useEffect(() => {
        setPool(tracks);
    }, [tracks, setPool]);
    // The same pool for everything else that works on "the library" (co-pilot, song requests).
    useEffect(() => {
        useLibraryPool.getState().set(tracks, fetched.current?.query ?? "", total, answered);
    }, [tracks, total, answered]);
    useEffect(() => () => useLibraryPool.getState().set([], "", 0, false), []);

    const load = useCallback((deck: DeckId, tr: LibraryTrack) => {
        const mixer = useMixerStore.getState();
        const before = { key: mixer.deckKeys[deck], wave: mixer.waveforms[deck] };
        const seq = (loadSeq.current[deck] ?? 0) + 1;
        loadSeq.current[deck] = seq;
        setLoadError((e) => (e && e.deck === deck ? null : e));
        loadLibraryTrack(deck, tr).catch((err: unknown) => {
            // A newer load on this deck owns its state now.
            if (loadSeq.current[deck] !== seq) return;
            // The loader is optimistic (key + empty waveform set before the decode): the deck still
            // holds its previous track, so put both back, or the key chips and "matches deck" would
            // compare against a track that never loaded. Only what the loader left behind is undone:
            // a load from elsewhere (auto-mix, the deck's own picker) may have replaced it meanwhile.
            const m = useMixerStore.getState();
            if (m.deckKeys[deck] === (tr.keyCamelot ?? null)) m.setDeckKey(deck, before.key);
            if (m.waveforms[deck].length === 0) m.setWaveform(deck, before.wave);
            // No peaks to put back (track loaded before a UI reload): fetch the held track's wave again.
            if (before.wave.length === 0) void restoreDeckWave(deck, () => loadSeq.current[deck] === seq);
            setLoadError({ id: tr.id, deck, title: trackTitle(tr), message: err instanceof Error ? err.message : String(err) });
        });
    }, []);

    const toggleFav = useCallback((tr: LibraryTrack) => {
        const put = (v: boolean | null) => setTracks((prev) => prev.map((x) => (x.id === tr.id ? { ...x, isFavorite: v } : x)));
        put(tr.isFavorite !== true);
        engine.companionToggleFavorite(tr.id).then(
            (v) => {
                if (typeof v === "boolean") put(v);
            },
            () => put(tr.isFavorite),
        );
    }, []);

    // Request stem separation for a track (the shared job store polls, with a limit on unanswered polls).
    const requestStems = useCallback((tr: LibraryTrack) => separateStems(null, String(tr.id)), []);
    // A finished job makes its row "stems ready" (also for a job started from a deck's STEMS tab).
    useEffect(() => {
        const done = new Set<number>();
        for (const [id, job] of Object.entries(stemJob)) if (job?.state === "done") done.add(Number(id));
        if (done.size === 0) return;
        setTracks((prev) => (prev.some((x) => done.has(x.id) && x.stemsStatus !== "ready") ? prev.map((x) => (done.has(x.id) && x.stemsStatus !== "ready" ? { ...x, stemsStatus: "ready" } : x)) : prev));
    }, [stemJob, tracks]);

    // ── derived view ──
    const playedIds = useMemo(() => {
        const now = Date.now();
        const ids = new Set<string>();
        for (const [id, at] of Object.entries(played)) if (playedTonight(at, now)) ids.add(id);
        return ids;
    }, [played]);

    const loadedOn = useMemo(() => {
        const map = new Map<string, DeckId[]>();
        for (const d of decks) {
            if (!d.trackId) continue;
            const on = map.get(d.trackId);
            if (on) on.push(d.id);
            else map.set(d.trackId, [d.id]);
        }
        return map;
    }, [decks]);

    const matchDeck = filters.matchDeck;
    const matchRef = useMemo<MatchRef | null>(() => {
        if (!matchDeck) return null;
        const d = decks.find((x) => x.id === matchDeck);
        return { key: deckKeys[matchDeck], bpm: d?.loaded ? d.bpm : 0, trackId: d?.trackId ?? null };
    }, [matchDeck, decks, deckKeys]);

    // Key the chips are compared against: the match deck, else the playing (master) deck.
    const masterKey = useMemo(() => {
        if (matchDeck) return deckKeys[matchDeck];
        const playing = decks.filter((d) => d.loaded && d.playing);
        const master = playing.find((d) => d.id === clockSource) ?? playing[0];
        return master ? deckKeys[master.id] : null;
    }, [matchDeck, decks, deckKeys, clockSource]);

    const sorted = useMemo(() => sortTracks(tracks, sort), [tracks, sort]);
    const byScoreNow = matchRef !== null && scoreOrder;
    const items = useMemo<Ranked[]>(() => {
        if (error) return [];
        const kept = filterTracks(sorted, filters, (id) => playedIds.has(id));
        if (!matchRef) return kept.map((tr) => ({ t: tr, match: null }));
        const ranked = rankMatches(kept, matchRef, (k) => {
            const m = keyMatch(k, matchRef.key);
            return m === null ? null : m !== "clash";
        });
        // Stable: equal scores keep the column order.
        return byScoreNow ? [...ranked].sort(byScore) : ranked;
    }, [error, sorted, filters, playedIds, matchRef, byScoreNow]);

    const list = useWindowedList(items.length);
    const { dispatch } = list;
    const cursor = list.state.cursor;
    const selected = items[cursor]?.t ?? null;

    // New search / order / filter → back to the top, like a hardware browser.
    useEffect(() => {
        dispatch({ type: "home" });
    }, [query, sort, filters, scoreOrder, dispatch]);

    const activate = useCallback(
        (index: number, opts: { shift: boolean }) => {
            const tr = items[index]?.t;
            if (tr) load(opts.shift ? "b" : freeDeck(decks), tr);
        },
        [items, load, decks],
    );

    const select = useCallback(
        (index: number, focus: boolean) => {
            dispatch({ type: "jumpTo", index });
            if (focus) listRef.current?.focus({ preventScroll: true });
        },
        [dispatch],
    );

    // Controller / shortcut browse API (see @/library/library-nav).
    const navRef = useRef({ dispatch, selected, load });
    navRef.current = { dispatch, selected, load };
    useEffect(
        () =>
            libraryNav.subscribe((cmd) => {
                const n = navRef.current;
                if (cmd.type === "move") n.dispatch({ type: "move", n: cmd.delta });
                else if (cmd.type === "page") n.dispatch({ type: "page", dir: cmd.dir });
                else if (cmd.type === "load") {
                    if (n.selected) n.load(cmd.deck, n.selected);
                } else if (cmd.type === "search") setQuery(cmd.query);
                else searchRef.current?.focus();
            }),
        [],
    );

    // Arrow / page keys and Enter also drive the list from the search box.
    const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "Enter") {
            e.preventDefault();
            activate(cursor, { shift: e.shiftKey });
            return;
        }
        if (e.key === "Home" || e.key === "End") return;
        const a = keyAction(e.key);
        if (!a) return;
        e.preventDefault();
        dispatch(a);
    };

    const onSort = useCallback((key: SortKey) => {
        setScoreOrder(false);
        setSort((cur) => nextSort(cur, key));
    }, []);
    const onMatch = useCallback((deck: DeckId | null) => {
        setScoreOrder(true);
        setFilters((f) => ({ ...f, matchDeck: deck }));
    }, []);
    const onToggle = useCallback((key: "notPlayed" | "favorites") => setFilters((f) => ({ ...f, [key]: !f[key] })), []);

    const full = tier === "full";
    const icon = tier === "icon";
    const btn = touch ? 44 : 24;
    const contentW = list.width - 2 * ROW_PAD[tier];
    const diff = matchRef !== null && matchRef.bpm > 0;
    const cols = useMemo(
        () => (tier === "full" ? fullColumns(contentW, { diff, btn }) : tier === "compact" ? compactColumns(contentW, { btn }) : ICON_COLUMNS),
        [tier, contentW, diff, btn],
    );
    const dateFmt = useMemo(() => new Intl.DateTimeFormat(locale, { day: "2-digit", month: "2-digit", year: "2-digit" }), [locale]);
    const intFmt = useMemo(() => new Intl.NumberFormat(locale), [locale]);

    const sourceSection = <SourceSection t={t} source={source} setSource={setSource} />;

    // ── Non-ready states ──
    if (status !== "ready") {
        return (
            <>
                <div className="lib-toolbar">
                    {full ? (
                        <SourceTabs t={t} source={source} setSource={setSource} />
                    ) : (
                        <>
                            <span className="dk-label lib-c lib-spacer">{t("library.companion")}</span>
                            <OptionsPopover label={t("libraryui.menu")} open={menuOpen} onOpenChange={setMenuOpen}>
                                {sourceSection}
                            </OptionsPopover>
                        </>
                    )}
                </div>
                <div className="lib-statewrap">
                    {status === "checking" ? (
                        <StateBlock tier={tier} busy title={t("common.loading")} />
                    ) : status === "offline" ? (
                        <StateBlock tier={tier} tone="warning" icon={<WifiOff size={14} aria-hidden />} title={t("library.offline")} detail={t("library.offlineDetail")} />
                    ) : (
                        <StateBlock
                            tier={tier}
                            icon={<Link2Off size={14} aria-hidden />}
                            title={t("library.unconfigured")}
                            detail={t("library.unconfiguredDetail")}
                            action={
                                icon ? (
                                    // Icon tier (200 px): the text button would squeeze the title to "Neas…".
                                    <button type="button" className="dk-btn dk-btn-xs" aria-label={t("library.openSettings")} aria-disabled={gigLocked || undefined} title={gigLocked ? t("gig.lockedShort") : t("library.openSettings")} onClick={() => setSettingsOpen(true)}>
                                        <Settings size={12} aria-hidden />
                                    </button>
                                ) : (
                                    <button type="button" className="dk-btn" aria-disabled={gigLocked || undefined} title={gigLocked ? t("gig.lockedShort") : undefined} onClick={() => setSettingsOpen(true)}>
                                        {t("library.openSettings")}
                                    </button>
                                )
                            }
                        />
                    )}
                </div>
            </>
        );
    }

    // ── Ready ──
    const filterCount = activeFilterCount(filters);
    const shown = items.length;
    const base = Math.max(total, tracks.length);
    const countWord = (n: number) => t(`libraryui.count.${pluralCategory(n, locale)}`, { n: intFmt.format(n) });
    const countLong = shown === base ? countWord(base) : `${t("libraryui.countOf", { shown: intFmt.format(shown), total: intFmt.format(base) })} (${countWord(base)})`;
    const countText = shown === base ? countWord(base) : t("libraryui.countOf", { shown: intFmt.format(shown), total: intFmt.format(base) });
    const countShort = shown === base ? intFmt.format(base) : `${intFmt.format(shown)}/${intFmt.format(base)}`;
    // Text chips need ~430 px; below that they are icon chips (same names, as tooltips).
    const wide = full && list.width >= 900;
    const chips = (labels: boolean) => <FilterChips t={t} decks={decks} filters={filters} labels={labels} onMatch={onMatch} onToggle={onToggle} />;

    const placeholder = error ? (
        <StateBlock
            tier={tier}
            tone="error"
            icon={<TriangleAlert size={14} aria-hidden />}
            title={t("library.error")}
            detail={error}
            detailOneLine
            action={
                <button type="button" className="dk-btn dk-btn-xs" onClick={() => void fetchTracks(query, sort, true)}>
                    {t("common.retry")}
                </button>
            }
        />
    ) : tracks.length === 0 && loading ? (
        <StateBlock tier={tier} busy title={t("library.loading")} />
    ) : tracks.length > 0 ? (
        <StateBlock
            tier={tier}
            icon={<ListX size={14} aria-hidden />}
            title={t("libraryui.noFiltered")}
            detail={t("libraryui.noFilteredDetail")}
            action={
                <button type="button" className="dk-btn dk-btn-xs" onClick={() => setFilters(NO_FILTERS)}>
                    {t("libraryui.clearFilters")}
                </button>
            }
        />
    ) : query.trim().length > 0 ? (
        <StateBlock tier={tier} icon={<SearchX size={14} aria-hidden />} title={t("library.noResults")} detail={t("library.noResultsDetail")} />
    ) : (
        <StateBlock tier={tier} icon={<Music size={14} aria-hidden />} title={t("library.empty")} detail={t("library.emptyDetail")} />
    );

    const rowLabel = ({ t: tr }: Ranked) => {
        const id = String(tr.id);
        const parts = [trackTitle(tr), tr.artist?.trim() || t("libraryui.unknownArtist")];
        if (tr.bpm && tr.bpm > 0) parts.push(`${fmtBpm(tr.bpm)} BPM`);
        if (tr.keyCamelot) parts.push(tr.keyCamelot);
        for (const deck of loadedOn.get(id) ?? []) parts.push(t("libraryui.onDeck", { deck: deck.toUpperCase() }));
        if (playedIds.has(id)) parts.push(t("libraryui.played"));
        if (loadError?.id === tr.id) parts.push(t("libraryui.loadFailedShort"));
        return parts.join(", ");
    };

    const menuLabel = !full && filterCount > 0 ? `${t("libraryui.menu")} · ${t("libraryui.filtersOn", { n: filterCount })}` : t("libraryui.menu");
    const loadFailedText = loadError ? t("libraryui.loadFailed", { title: loadError.title, deck: loadError.deck.toUpperCase() }) : "";

    return (
        <>
            <div className="lib-toolbar">
                {full && <SourceTabs t={t} source={source} setSource={setSource} />}
                <SearchField t={t} value={query} onChange={setQuery} onKeyDown={onSearchKey} inputRef={searchRef} />
                {full && chips(wide)}
                {full && <span className="lib-spacer" />}
                {!icon && <CopilotButton />}
                {loadError && (
                    <button
                        type="button"
                        className="dk-btn dk-btn-xs lib-loaderr"
                        aria-label={`${loadFailedText}. ${t("libraryui.dismiss")}`}
                        title={`${loadFailedText}\n${loadError.message}`}
                        onClick={() => setLoadError(null)}
                    >
                        <TriangleAlert size={12} aria-hidden />
                        {wide && <span className="lib-c">{t("libraryui.loadFailedShort")}</span>}
                    </button>
                )}
                <span className="sr-only" role="alert">
                    {loadFailedText}
                </span>
                {icon ? (
                    (["a", "b"] as const).map((deck) => {
                        const label = selected ? t("libraryui.loadTo", { title: trackTitle(selected), deck: deck.toUpperCase() }) : t("libraryui.loadDeck", { deck: deck.toUpperCase() });
                        return (
                            <button
                                key={deck}
                                type="button"
                                className="dk-btn dk-btn-xs"
                                aria-label={label}
                                title={label}
                                disabled={!selected}
                                onClick={() => {
                                    if (selected) load(deck, selected);
                                }}
                            >
                                <DeckLetter deck={deck} />
                            </button>
                        );
                    })
                ) : (
                    <>
                        <span className="dk-num lib-count" aria-hidden title={countLong}>
                            {full && list.width >= 620 ? countText : countShort}
                        </span>
                        {/* Announced once, when the list is complete: the count grows with every page while it loads. */}
                        <span className="sr-only" role="status">
                            {loading ? "" : countLong}
                        </span>
                    </>
                )}
                <OptionsPopover label={menuLabel} open={menuOpen} onOpenChange={setMenuOpen} active={!full && filterCount > 0}>
                    {!full && sourceSection}
                    {!full && <PopSection label={t("libraryui.filters")}>{chips(true)}</PopSection>}
                    <PopSection label={t("libraryui.sort")}>
                        <SortButtons t={t} sort={sort} scoreOrder={byScoreNow} canScore={matchRef !== null} onSort={onSort} onScore={() => setScoreOrder(true)} />
                    </PopSection>
                    {selected ? (
                        <SelectedActions t={t} tr={selected} stemJob={stemJob[selected.id]} onLoad={load} onFav={toggleFav} onStems={requestStems} />
                    ) : (
                        <PopSection label={t("libraryui.selected")}>
                            <span className="lib-dim">{t("libraryui.noSelection")}</span>
                        </PopSection>
                    )}
                </OptionsPopover>
            </div>
            <ScrolllessList
                items={items}
                getKey={(r) => r.t.id}
                getLabel={rowLabel}
                list={list}
                listRef={listRef}
                label={t("libraryui.list")}
                placeholder={placeholder}
                onActivate={activate}
                onMenuKey={() => setMenuOpen(true)}
                formatLive={(from, to, n) => t("libraryui.positionLive", { from: intFmt.format(from), to: intFmt.format(to), total: intFmt.format(n) })}
                header={full ? <ColumnHeader t={t} cols={cols} sort={byScoreNow ? null : sort} onSort={onSort} /> : undefined}
                renderRow={({ t: tr, match }, { index }) => (
                    <TrackRow
                        t={t}
                        tr={tr}
                        match={match}
                        cols={cols}
                        index={index}
                        loadedOn={loadedOn.get(String(tr.id))}
                        played={playedIds.has(String(tr.id))}
                        failed={loadError?.id === tr.id}
                        masterKey={masterKey}
                        matchDeck={matchRef ? matchDeck : null}
                        refBpm={matchRef?.bpm ?? 0}
                        stemJob={stemJob[tr.id]}
                        dateFmt={dateFmt}
                        listRef={listRef}
                        onSelect={select}
                        onLoad={load}
                        onFav={toggleFav}
                        onStems={requestStems}
                    />
                )}
            />
        </>
    );
}

/** Actions on the selected track at full target size (the dense row controls are smaller than 24 px). */
function SelectedActions({
    t,
    tr,
    stemJob,
    onLoad,
    onFav,
    onStems,
}: {
    t: Translate;
    tr: LibraryTrack;
    stemJob: StemJobState | undefined;
    onLoad: (deck: DeckId, tr: LibraryTrack) => void;
    onFav: (tr: LibraryTrack) => void;
    onStems: (tr: LibraryTrack) => void;
}) {
    const title = trackTitle(tr);
    const fav = tr.isFavorite === true;
    const stems = stemsView(t, tr, stemJob);
    return (
        <PopSection label={t("libraryui.selected")}>
            <span className="lib-c lib-pop-title" title={title}>
                {title}
            </span>
            {(["a", "b"] as const).map((deck) => (
                <button key={deck} type="button" className="dk-btn" aria-label={t("libraryui.loadTo", { title, deck: deck.toUpperCase() })} onClick={() => onLoad(deck, tr)}>
                    <DeckDot deck={deck} />
                    {t(deck === "a" ? "library.loadA" : "library.loadB")}
                </button>
            ))}
            <button type="button" className="dk-btn" aria-pressed={fav} aria-label={t(fav ? "libraryui.favRemove" : "libraryui.favAdd", { title })} onClick={() => onFav(tr)}>
                <Heart size={12} aria-hidden fill={fav ? "currentColor" : "none"} />
                {t("libraryui.favorite")}
            </button>
            <button type="button" className="dk-btn" disabled={stems.kind === "ready" || stems.kind === "running"} aria-label={stems.label} title={stems.label} onClick={() => onStems(tr)}>
                <Sparkles size={12} aria-hidden />
                {t("libraryui.stems")}
                {stems.kind === "running" && <span className="dk-num">{stems.pct}%</span>}
            </button>
        </PopSection>
    );
}

// ─── Local files ─────────────────────────────────────────────────────────────

/**
 * Local-file load: patches deck metadata then decodes via the core. Optimistic like the
 * companion loader (`load` above): the key is cleared (a local file carries none, and the
 * previous track's key must not stay on the chip) and the waveform emptied before the decode.
 * A rejected load puts back what this call left behind (the deck still holds its previous
 * track) and rethrows, so the caller can say so. `current()` = false when a newer load on the
 * deck owns its state.
 */
async function loadLocalFile(deck: DeckId, t: { id: string; title: string; artist: string; bpm: number; source: string }, current: () => boolean): Promise<void> {
    const store = useMixerStore.getState();
    const before = { key: store.deckKeys[deck], wave: store.waveforms[deck] };
    store.patchDeck(deck, {
        trackId: t.id,
        title: t.title,
        artist: t.artist,
        bpm: t.bpm,
        loaded: true,
        position: 0,
    });
    store.setWaveform(deck, []);
    store.setDeckKey(deck, null);
    try {
        const peaks = await engine.loadTrack({
            deck,
            source: t.source,
            trackId: t.id,
            title: t.title,
            artist: t.artist,
            bpm: t.bpm,
        });
        if (peaks && current()) useMixerStore.getState().setWaveform(deck, peaks);
    } catch (err) {
        if (current()) {
            const m = useMixerStore.getState();
            if (m.deckKeys[deck] === null) m.setDeckKey(deck, before.key);
            if (m.waveforms[deck].length === 0) m.setWaveform(deck, before.wave);
            // No peaks to put back (track loaded before a UI reload): fetch the held track's wave again.
            if (before.wave.length === 0) void restoreDeckWave(deck, current);
        }
        throw err;
    }
}

function LocalFiles({ tier, source, setSource }: SourceProps) {
    const t = useT();
    const [menuOpen, setMenuOpen] = useState(false);
    // Last local load that failed (unreadable file, decode error): the tile says so until the next try.
    const [loadError, setLoadError] = useState<{ deck: DeckId; title: string; message: string } | null>(null);
    const loadSeq = useRef<Partial<Record<DeckId, number>>>({});

    const openFileTo = async (deck: DeckId) => {
        let title = "";
        // The sequence is taken after the picker returns: a dialog left open (or cancelled) must
        // not make a load that started meanwhile on this deck look stale.
        let seq = -1;
        const current = () => loadSeq.current[deck] === seq;
        try {
            const path = await engine.pickAudioFile();
            if (!path) return;
            seq = (loadSeq.current[deck] ?? 0) + 1;
            loadSeq.current[deck] = seq;
            const file = path.replace(/\\/g, "/").split("/").pop() ?? path;
            title = file.replace(/\.[^.]+$/, "");
            setLoadError((e) => (e && e.deck === deck ? null : e));
            await loadLocalFile(deck, { id: path, title, artist: t("library.local"), bpm: 0, source: path }, current);
        } catch (err) {
            // A newer load on this deck owns its state (and its message) now.
            if (seq !== -1 && !current()) return;
            setLoadError({ deck, title: title || t("library.local"), message: err instanceof Error ? err.message : String(err) });
        }
    };

    const full = tier === "full";
    const icon = tier === "icon";
    const buttons: ReactNode = (["a", "b"] as const).map((deck) => (
        <button
            key={deck}
            type="button"
            className={icon ? "dk-btn dk-btn-xs" : "dk-btn"}
            aria-label={t("libraryui.loadPickTo", { deck: deck.toUpperCase() })}
            title={t("libraryui.loadPickTo", { deck: deck.toUpperCase() })}
            onClick={() => void openFileTo(deck)}
        >
            {icon ? <DeckLetter deck={deck} /> : <DeckDot deck={deck} />}
            {!icon && t(deck === "a" ? "library.loadA" : "library.loadB")}
        </button>
    ));

    return (
        <>
            <div className="lib-toolbar">
                {full ? (
                    <SourceTabs t={t} source={source} setSource={setSource} />
                ) : (
                    <>
                        <span className="dk-label lib-c lib-spacer">{t("library.local")}</span>
                        <OptionsPopover label={t("libraryui.menu")} open={menuOpen} onOpenChange={setMenuOpen}>
                            <SourceSection t={t} source={source} setSource={setSource} />
                        </OptionsPopover>
                    </>
                )}
            </div>
            <div className="lib-statewrap">
                {loadError ? (
                    <StateBlock
                        tier={tier}
                        tone="error"
                        icon={<TriangleAlert size={14} aria-hidden />}
                        title={t("libraryui.loadFailed", { title: loadError.title, deck: loadError.deck.toUpperCase() })}
                        detail={loadError.message}
                        detailOneLine
                        action={buttons}
                    />
                ) : (
                    <StateBlock tier={tier} icon={<FolderOpen size={14} aria-hidden />} title={t("library.pickFile")} detail={t("library.localHint")} action={buttons} />
                )}
            </div>
        </>
    );
}
