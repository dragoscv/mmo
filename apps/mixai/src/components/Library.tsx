import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ChevronDown, ChevronUp, FolderOpen, Link2Off, MoreVertical, Search, Sparkles, WifiOff } from "lucide-react";
import {
    Button,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuGroup,
    DropdownMenuLabel,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
    EmptyState,
    ErrorState,
    Input,
    NoResultsState,
    Popover,
    PopoverContent,
    PopoverTrigger,
    SkeletonText,
    ToggleGroup,
    ToggleGroupItem,
    cn,
} from "@mmo/ui";
import { engine } from "@/bridge/engine";
import type { DeckId, DeckState, LibraryTrack } from "@/bridge/types";
import { useMixerStore } from "@/state/mixer-store";
import { useUiStore } from "@/state/ui-store";
import { parseCamelot, transitionScore } from "@/lib/harmonic";
import type { TransitionScore } from "@/lib/harmonic";
import { useAutoMixStore } from "@/state/auto-mix-store";
import { useT, type Translate } from "@/i18n";
import { usePanelTier } from "@/layout/panel-tier";
import type { Tier } from "@/layout/types";
import { ScrolllessList } from "@/library/ScrolllessList";
import { keyAction, useSettledValue, useWheelRows, useWindowedList, type WindowedList } from "@/library/useWindowedList";
import { libraryNav } from "@/library/library-nav";

/**
 * Library browser. Two sources:
 *   - **Companion** — browse the mixai.ro library served by the local MMO
 *     Server (`server/`) over HTTP, proxied through Rust. Tracks live on the
 *     same machine, so loading uses the row's local `filepath` directly.
 *   - **Local** — pick any audio file from disk (Tauri dialog).
 *
 * Zero scroll: the track list is a scroll-less virtualised window
 * (`@/library/ScrolllessList`) that shows exactly the rows that fit and moves
 * row by row (wheel, keys, touch, controller via `libraryNav`). Layout follows
 * the panel tier: full (toolbar + columns), compact (search + short rows +
 * menu), icon (selected track + prev/next + search popover).
 */

type Source = "companion" | "local";

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
        <div
            className={cn("panel grid h-full min-h-0 min-w-0 overflow-hidden", tier === "icon" ? "gap-1 p-1.5" : "gap-2 p-2")}
            data-tier={tier}
        >
            {source === "companion" ? <CompanionLibrary {...props} /> : <LocalFiles {...props} />}
        </div>
    );
}

/** Shared track-load helper: patches deck metadata then decodes via the core. */
function useLoadToDeck() {
    const patchDeck = useMixerStore((s) => s.patchDeck);
    const setWaveform = useMixerStore((s) => s.setWaveform);

    return useCallback(
        async (deck: DeckId, t: { id: string; title: string; artist: string; bpm: number; source: string }) => {
            patchDeck(deck, {
                trackId: t.id,
                title: t.title,
                artist: t.artist,
                bpm: t.bpm,
                loaded: true,
                position: 0,
            });
            setWaveform(deck, []);
            const peaks = await engine.loadTrack({
                deck,
                source: t.source,
                trackId: t.id,
                title: t.title,
                artist: t.artist,
                bpm: t.bpm,
            });
            if (peaks) setWaveform(deck, peaks);
        },
        [patchDeck, setWaveform],
    );
}

/** Enter target: the deck that is not playing (A unless only A plays). */
function freeDeck(decks: readonly DeckState[]): DeckId {
    const a = decks.find((d) => d.id === "a");
    const b = decks.find((d) => d.id === "b");
    return a?.playing && !b?.playing ? "b" : "a";
}

// ─── Companion ──────────────────────────────────────────────────────────────

type Ranked = { t: LibraryTrack; match: TransitionScore | null };
type StemJob = { state: string; progress: number };

function CompanionLibrary({ tier, source, setSource }: SourceProps) {
    const t = useT();
    const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
    const patchDeck = useMixerStore((s) => s.patchDeck);
    const setWaveform = useMixerStore((s) => s.setWaveform);
    const setDeckKey = useMixerStore((s) => s.setDeckKey);
    const decks = useMixerStore((s) => s.decks);
    const deckKeys = useMixerStore((s) => s.deckKeys);
    const setPool = useAutoMixStore((s) => s.setPool);
    const [query, setQuery] = useState("");
    const [tracks, setTracks] = useState<LibraryTrack[]>([]);
    const [status, setStatus] = useState<"checking" | "offline" | "unconfigured" | "ready">("checking");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // Harmonic mix-assist: when set to a deck, rank tracks by transition score
    // against that deck's playing track (key + BPM compatibility).
    const [assistDeck, setAssistDeck] = useState<DeckId | null>(null);
    // Per-track stem-separation job progress (keyed by track id).
    const [stemJob, setStemJob] = useState<Record<number, StemJob>>({});
    const [searchOpen, setSearchOpen] = useState(false);
    const searchRef = useRef<HTMLInputElement | null>(null);

    // Probe the companion on mount.
    useEffect(() => {
        void (async () => {
            const st = await engine.companionStatus();
            if (!st || !st.online) setStatus("offline");
            else if (!st.authed) setStatus("unconfigured");
            else setStatus("ready");
        })();
    }, []);

    const fetchTracks = useCallback(async (search: string) => {
        setLoading(true);
        setError(null);
        try {
            const page = await engine.companionTracks({ search });
            if (page) setTracks(page.tracks);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setLoading(false);
        }
    }, []);

    // Load tracks once ready, and debounce on query change.
    useEffect(() => {
        if (status !== "ready") return;
        const id = setTimeout(() => void fetchTracks(query), 250);
        return () => clearTimeout(id);
    }, [status, query, fetchTracks]);

    // Keep the auto-mix candidate pool in sync with the visible library so the
    // "AI DJ" can auto-queue the next harmonic match.
    useEffect(() => {
        setPool(tracks);
    }, [tracks, setPool]);

    const load = useCallback(
        async (deck: DeckId, tr: LibraryTrack) => {
            const title = tr.title ?? tr.filename;
            const artist = tr.artist ?? "Unknown";
            // Optimistic UI: reflect metadata immediately.
            patchDeck(deck, { trackId: String(tr.id), title, artist, bpm: tr.bpm ?? 0, loaded: true, position: 0 });
            setWaveform(deck, []);
            setDeckKey(deck, tr.keyCamelot ?? null);
            // Try a direct local decode first (companion on this machine). If the
            // file isn't on local disk (remote companion / tunnel), stream it.
            let peaks: number[] | null = null;
            try {
                peaks = await engine.loadTrack({
                    deck,
                    source: tr.filepath,
                    trackId: String(tr.id),
                    title,
                    artist,
                    bpm: tr.bpm ?? 0,
                });
            } catch {
                peaks = await engine.loadTrackStream({
                    deck,
                    trackId: tr.id,
                    title,
                    artist,
                    bpm: tr.bpm ?? 0,
                });
            }
            if (peaks) setWaveform(deck, peaks);
            // If the companion has separated stems, attach them so the deck's
            // stem controls light up immediately.
            if (tr.stemsStatus === "ready") {
                try {
                    const s = await engine.companionTrackStems(tr.id);
                    if (s && (s.vocals || s.drums || s.bass || s.melody)) {
                        await engine.loadStems(deck, {
                            vocals: s.vocals,
                            drums: s.drums,
                            bass: s.bass,
                            melody: s.melody,
                        });
                    }
                } catch {
                    /* stems are best-effort; ignore failures */
                }
            }
        },
        [patchDeck, setWaveform, setDeckKey],
    );

    // Request stem separation for a track and poll until ready.
    const generateStems = useCallback(async (tr: LibraryTrack) => {
        setStemJob((j) => ({ ...j, [tr.id]: { state: "running", progress: 0 } }));
        try {
            const jobId = await engine.companionRequestStems(tr.id);
            if (!jobId) throw new Error("no job id");
            // Poll every 1.5s until done/error.
            for (;;) {
                await new Promise((r) => setTimeout(r, 1500));
                const job = await engine.companionStemJob(jobId);
                if (!job) continue;
                setStemJob((j) => ({ ...j, [tr.id]: { state: job.state, progress: job.progress } }));
                if (job.state === "done") {
                    setTracks((prev) => prev.map((x) => (x.id === tr.id ? { ...x, stemsStatus: "ready" } : x)));
                    break;
                }
                if (job.state === "error") break;
            }
        } catch {
            setStemJob((j) => ({ ...j, [tr.id]: { state: "error", progress: 0 } }));
        }
    }, []);

    // Reference track for harmonic assist (the playing track on the chosen deck).
    const refDeck = assistDeck ? decks.find((d) => d.id === assistDeck) : null;
    const refKeyLabel = assistDeck ? deckKeys[assistDeck] : null;
    const refBpm = refDeck?.bpm ?? 0;

    // Rank tracks by transition score when assist is on; otherwise keep the
    // library's natural order with no match badge.
    const ranked = useMemo<Ranked[]>(() => {
        const refKey = parseCamelot(refKeyLabel);
        const base = tracks.map((tr) => ({ t: tr, match: null as TransitionScore | null }));
        if (!assistDeck || (!refKey && refBpm <= 0)) return base;
        return base
            .map(({ t: tr }) => ({
                t: tr,
                match: transitionScore({ key: refKey, bpm: refBpm }, { key: parseCamelot(tr.keyCamelot), bpm: tr.bpm ?? 0 }),
            }))
            .sort((a, b) => (b.match?.score ?? 0) - (a.match?.score ?? 0));
    }, [tracks, assistDeck, refKeyLabel, refBpm]);

    const items = useMemo(() => (error ? [] : ranked), [error, ranked]);
    const list = useWindowedList(items.length, tier === "icon" ? 1 : undefined);
    const { dispatch } = list;
    const cursor = list.state.cursor;
    const selected = items[cursor]?.t ?? null;

    // New search / ranking → back to the top, like a hardware browser.
    useEffect(() => {
        dispatch({ type: "home" });
    }, [query, assistDeck, dispatch]);

    const activate = useCallback(
        (index: number, opts: { shift: boolean }) => {
            const tr = items[index]?.t;
            if (tr) void load(opts.shift ? "b" : freeDeck(decks), tr);
        },
        [items, load, decks],
    );

    // Controller / shortcut browse API (see @/library/library-nav).
    const navRef = useRef({ dispatch, selected, load, tier });
    navRef.current = { dispatch, selected, load, tier };
    useEffect(
        () =>
            libraryNav.subscribe((cmd) => {
                const n = navRef.current;
                if (cmd.type === "move") n.dispatch({ type: "move", n: cmd.delta });
                else if (cmd.type === "page") n.dispatch({ type: "page", dir: cmd.dir });
                else if (cmd.type === "load") {
                    if (n.selected) void n.load(cmd.deck, n.selected);
                } else if (n.tier === "icon") setSearchOpen(true);
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

    const assist: AssistProps = { decks, deckKeys, assistDeck, setAssistDeck };
    const menu = <LibraryMenu source={source} setSource={setSource} assist={status === "ready" ? assist : undefined} />;

    // ── Non-ready states ──
    if (status !== "ready") {
        if (tier === "icon") {
            return (
                <div className="flex min-h-0 min-w-0 items-start gap-1 overflow-hidden">
                    <div className="min-w-0 flex-1 overflow-hidden">
                        <StatusLine status={status} t={t} onSettings={() => setSettingsOpen(true)} />
                    </div>
                    {menu}
                </div>
            );
        }
        return (
            <div className="grid min-h-0 min-w-0 gap-2 overflow-hidden" style={{ gridTemplateRows: "auto minmax(0, 1fr)" }}>
                {tier === "full" ? <SourceSwitch source={source} setSource={setSource} /> : <div className="flex justify-end">{menu}</div>}
                {status === "checking" ? (
                    <div className="min-h-0 overflow-hidden p-2" aria-busy="true">
                        <SkeletonText lines={4} />
                    </div>
                ) : status === "offline" ? (
                    <EmptyState
                        variant="inline"
                        tone="warning"
                        icon={<WifiOff aria-hidden />}
                        title={t("library.offline")}
                        description={t("library.offlineDetail")}
                        className="min-h-0 overflow-hidden p-2"
                    />
                ) : (
                    <EmptyState
                        variant="inline"
                        icon={<Link2Off aria-hidden />}
                        title={t("library.unconfigured")}
                        description={t("library.unconfiguredDetail")}
                        actions={
                            <Button size="sm" onClick={() => setSettingsOpen(true)}>
                                {t("library.openSettings")}
                            </Button>
                        }
                        className="min-h-0 overflow-hidden p-2"
                    />
                )}
            </div>
        );
    }

    const placeholder = (
        <ListPlaceholder
            tier={tier}
            t={t}
            error={error}
            loading={loading}
            hasQuery={query.trim().length > 0}
            onRetry={() => void fetchTracks(query)}
        />
    );

    const searchInput = (
        <Input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onSearchKey}
            placeholder={t("library.search")}
            size="sm"
            type="search"
            aria-label={t("library.search")}
            title={t("libraryui.keysHint")}
            className="min-w-0"
        />
    );

    // ── Icon tier: one selected track + prev/next ──
    if (tier === "icon") {
        return (
            <IconBrowser
                t={t}
                list={list}
                selected={selected}
                placeholder={placeholder}
                menu={menu}
                onLoad={(deck) => {
                    if (selected) void load(deck, selected);
                }}
                onActivate={(shift) => activate(cursor, { shift })}
                search={
                    <Popover open={searchOpen} onOpenChange={(open) => setSearchOpen(open)}>
                        <PopoverTrigger render={<Button size="icon-xs" variant="ghost" aria-label={t("library.search")} />}>
                            <Search aria-hidden />
                        </PopoverTrigger>
                        <PopoverContent side="top" className="w-64 p-2" initialFocus={searchRef}>
                            {searchInput}
                        </PopoverContent>
                    </Popover>
                }
            />
        );
    }

    const full = tier === "full";
    const cols = full ? fullColumns(list.width) : COMPACT_COLUMNS;
    const fmtPos = (key: "libraryui.position" | "libraryui.positionLive") => (from: number, to: number, total: number) =>
        t(key, { from: fmtInt(from), to: fmtInt(to), total: fmtInt(total) });

    return (
        <div
            className="grid min-h-0 min-w-0 gap-2 overflow-hidden"
            style={{ gridTemplateRows: full ? "auto auto minmax(0, 1fr)" : "auto minmax(0, 1fr)" }}
        >
            <div className="flex min-w-0 items-center gap-2 overflow-hidden">
                {full && <SourceSwitch source={source} setSource={setSource} className="w-44 shrink-0" />}
                <div className="min-w-0 flex-1">{searchInput}</div>
                {!full && menu}
            </div>
            {full && <MixAssistBar {...assist} />}
            <ScrolllessList
                items={items}
                getKey={(r) => r.t.id}
                list={list}
                label={t("libraryui.list")}
                placeholder={placeholder}
                onActivate={activate}
                formatPosition={fmtPos("libraryui.position")}
                formatLive={fmtPos("libraryui.positionLive")}
                header={full ? <ColumnHeader t={t} cols={cols} /> : undefined}
                renderRow={({ t: tr, match }) =>
                    full ? (
                        <FullRow
                            t={t}
                            tr={tr}
                            match={match}
                            cols={cols}
                            stemJob={stemJob[tr.id]}
                            onStems={() => void generateStems(tr)}
                            onLoad={(deck) => void load(deck, tr)}
                        />
                    ) : (
                        <CompactRow t={t} tr={tr} onLoad={(deck) => void load(deck, tr)} />
                    )
                }
            />
        </div>
    );
}

// ─── Local files ─────────────────────────────────────────────────────────────

function LocalFiles({ tier, source, setSource }: SourceProps) {
    const t = useT();
    const loadToDeck = useLoadToDeck();

    const openFileTo = async (deck: DeckId) => {
        const path = await engine.pickAudioFile();
        if (!path) return;
        const file = path.replace(/\\/g, "/").split("/").pop() ?? path;
        const title = file.replace(/\.[^.]+$/, "");
        await loadToDeck(deck, { id: path, title, artist: "Local file", bpm: 0, source: path });
    };

    const full = tier === "full";
    const buttons = (
        <div className="flex shrink-0 items-center gap-1">
            <DeckButton deck="a" label={t("libraryui.loadPickTo", { deck: "A" })} onClick={() => void openFileTo("a")} wide={full}>
                {full ? t("library.loadA") : "A"}
            </DeckButton>
            <DeckButton deck="b" label={t("libraryui.loadPickTo", { deck: "B" })} onClick={() => void openFileTo("b")} wide={full}>
                {full ? t("library.loadB") : "B"}
            </DeckButton>
        </div>
    );
    const hint = (
        <span className="inline-flex min-w-0 flex-1 items-center gap-1.5 truncate text-[11px]" style={{ color: "var(--fg-dim)" }}>
            <FolderOpen className="size-3.5 shrink-0" aria-hidden />
            <span className="truncate">{t("library.pickFile")}</span>
        </span>
    );

    if (!full) {
        return (
            <div className="flex min-h-0 min-w-0 flex-col gap-1 overflow-hidden">
                <div className="flex min-w-0 items-center gap-1 overflow-hidden">
                    {hint}
                    <LibraryMenu source={source} setSource={setSource} />
                </div>
                {buttons}
            </div>
        );
    }

    return (
        <div className="grid min-h-0 min-w-0 gap-2 overflow-hidden" style={{ gridTemplateRows: "auto auto minmax(0, 1fr)" }}>
            <SourceSwitch source={source} setSource={setSource} />
            <div className="flex min-w-0 items-center gap-2 overflow-hidden">
                {hint}
                {buttons}
            </div>
            <EmptyState
                variant="inline"
                icon={<FolderOpen aria-hidden />}
                title={t("library.local")}
                description={t("library.localHint")}
                className="min-h-0 overflow-hidden p-2"
            />
        </div>
    );
}

// ─── Icon tier ───────────────────────────────────────────────────────────────

function IconBrowser({
    t,
    list,
    selected,
    placeholder,
    menu,
    search,
    onLoad,
    onActivate,
}: {
    t: Translate;
    list: WindowedList;
    selected: LibraryTrack | null;
    placeholder: ReactNode;
    menu: ReactNode;
    search: ReactNode;
    onLoad: (deck: DeckId) => void;
    onActivate: (shift: boolean) => void;
}) {
    const { state, dispatch, rowHeight } = list;
    const [node, setNode] = useState<HTMLDivElement | null>(null);
    const visibleRef = useRef(1);
    useWheelRows(node, dispatch, rowHeight, visibleRef);
    const title = selected ? (selected.title ?? selected.filename) : "";
    const live = useSettledValue(selected ? `${title} · ${state.cursor + 1} / ${state.total}` : "", 700);

    const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter") {
            e.preventDefault();
            onActivate(e.shiftKey);
            return;
        }
        const a = keyAction(e.key);
        if (!a) return;
        e.preventDefault();
        dispatch(a);
    };

    return (
        <div className="grid min-h-0 min-w-0 gap-1 overflow-hidden" style={{ gridTemplateRows: "minmax(0, 1fr) auto" }}>
            <div
                ref={setNode}
                tabIndex={0}
                role="group"
                aria-label={t("libraryui.selected")}
                title={t("libraryui.keysHint")}
                onKeyDown={onKeyDown}
                onDoubleClick={(e) => onActivate(e.shiftKey)}
                className="min-h-0 min-w-0 overflow-hidden rounded-md px-1 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
                {selected ? (
                    <>
                        <div className="truncate text-xs font-semibold leading-tight">{title}</div>
                        <div className="mono flex min-w-0 items-center gap-1.5 text-[10px] leading-tight" style={{ color: "var(--fg-dim)" }}>
                            <span>{selected.bpm ? selected.bpm.toFixed(0) : "--"} BPM</span>
                            {selected.keyCamelot && <span style={{ color: "var(--accent-2)" }}>{selected.keyCamelot}</span>}
                            <span className="ml-auto tabular-nums">
                                {fmtInt(state.cursor + 1)}/{fmtInt(state.total)}
                            </span>
                        </div>
                    </>
                ) : (
                    <div className="truncate text-[11px]" style={{ color: "var(--fg-dim)" }}>
                        {placeholder}
                    </div>
                )}
                <span className="sr-only" aria-live="polite" aria-atomic="true">
                    {live}
                </span>
            </div>
            <div className="flex min-w-0 items-center gap-1 overflow-hidden">
                <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={t("libraryui.prev")}
                    disabled={state.total === 0 || state.cursor === 0}
                    onClick={() => dispatch({ type: "move", n: -1 })}
                >
                    <ChevronUp aria-hidden />
                </Button>
                <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={t("libraryui.next")}
                    disabled={state.total === 0 || state.cursor >= state.total - 1}
                    onClick={() => dispatch({ type: "move", n: 1 })}
                >
                    <ChevronDown aria-hidden />
                </Button>
                {search}
                <span className="flex-1" />
                <DeckButton deck="a" label={t("libraryui.loadTo", { title, deck: "A" })} onClick={() => onLoad("a")} disabled={!selected}>
                    A
                </DeckButton>
                <DeckButton deck="b" label={t("libraryui.loadTo", { title, deck: "B" })} onClick={() => onLoad("b")} disabled={!selected}>
                    B
                </DeckButton>
                {menu}
            </div>
        </div>
    );
}

// ─── Rows ────────────────────────────────────────────────────────────────────

interface Columns {
    template: string;
    genre: boolean;
    time: boolean;
}

const COMPACT_COLUMNS: Columns = { template: "minmax(0, 1fr) auto auto", genre: false, time: false };

/** Wider panels get Genre and Time columns. */
function fullColumns(width: number): Columns {
    const wide = width >= 760;
    const parts = [
        "minmax(0, 1.4fr)",
        "minmax(0, 1fr)",
        ...(wide ? ["minmax(0, 0.7fr)", "3rem"] : []),
        "2.75rem",
        "2.5rem",
        "2.75rem",
        "1.75rem",
        "3.25rem",
    ];
    return { template: parts.join(" "), genre: wide, time: wide };
}

function ColumnHeader({ t, cols }: { t: Translate; cols: Columns }) {
    return (
        <div
            aria-hidden
            className="grid h-5 items-center gap-1.5 px-2 text-[10px] font-semibold uppercase tracking-[0.08em]"
            style={{ gridTemplateColumns: cols.template, color: "var(--fg-dim)" }}
        >
            <span className="truncate">{t("libraryui.colTitle")}</span>
            <span className="truncate">{t("libraryui.colArtist")}</span>
            {cols.genre && <span className="truncate">{t("libraryui.colGenre")}</span>}
            {cols.time && <span className="truncate text-right">{t("libraryui.colTime")}</span>}
            <span className="truncate text-right">{t("libraryui.colBpm")}</span>
            <span className="truncate">{t("libraryui.colKey")}</span>
            <span className="truncate text-right">{t("libraryui.colMatch")}</span>
            <span className="truncate text-center">{t("libraryui.colStems")}</span>
            <span className="truncate text-center">{t("libraryui.colLoad")}</span>
        </div>
    );
}

function FullRow({
    t,
    tr,
    match,
    cols,
    stemJob,
    onStems,
    onLoad,
}: {
    t: Translate;
    tr: LibraryTrack;
    match: TransitionScore | null;
    cols: Columns;
    stemJob?: StemJob;
    onStems: () => void;
    onLoad: (deck: DeckId) => void;
}) {
    const title = tr.title ?? tr.filename;
    return (
        <div className="grid h-full items-center gap-1.5 px-2" style={{ gridTemplateColumns: cols.template }}>
            <span className="truncate text-[13px] font-semibold">{title}</span>
            <span className="truncate text-[11px]" style={{ color: "var(--fg-dim)" }}>
                {tr.artist ?? t("libraryui.unknownArtist")}
            </span>
            {cols.genre && (
                <span className="truncate text-[11px]" style={{ color: "var(--fg-dim)" }}>
                    {tr.genre ?? ""}
                </span>
            )}
            {cols.time && (
                <span className="mono text-right text-[11px] tabular-nums" style={{ color: "var(--fg-dim)" }}>
                    {fmtDuration(tr.duration)}
                </span>
            )}
            <span className="mono text-right text-[11px] tabular-nums" style={{ color: "var(--fg-dim)" }}>
                {tr.bpm ? tr.bpm.toFixed(0) : "--"}
            </span>
            <span className="mono truncate text-[11px]" style={{ color: "var(--accent-2)" }}>
                {tr.keyCamelot ?? ""}
            </span>
            <span className="flex justify-end">{match ? <MatchBadge match={match} /> : null}</span>
            <span className="flex justify-center">
                <StemsCell t={t} ready={tr.stemsStatus === "ready"} job={stemJob} onStems={onStems} />
            </span>
            <LoadPair t={t} title={title} onLoad={onLoad} />
        </div>
    );
}

function CompactRow({ t, tr, onLoad }: { t: Translate; tr: LibraryTrack; onLoad: (deck: DeckId) => void }) {
    const title = tr.title ?? tr.filename;
    const artist = tr.artist ?? t("libraryui.unknownArtist");
    return (
        <div className="grid h-full items-center gap-1.5 px-2" style={{ gridTemplateColumns: COMPACT_COLUMNS.template }}>
            <span className="min-w-0 overflow-hidden leading-tight">
                <span className="block truncate text-xs font-semibold">{title}</span>
                <span className="block truncate text-[10px] [[data-density=compact]_&]:hidden" style={{ color: "var(--fg-dim)" }}>
                    {artist}
                </span>
            </span>
            <span className="mono flex flex-col items-end text-[10px] leading-tight tabular-nums" style={{ color: "var(--fg-dim)" }}>
                <span>{tr.bpm ? tr.bpm.toFixed(0) : "--"}</span>
                {tr.keyCamelot && <span style={{ color: "var(--accent-2)" }}>{tr.keyCamelot}</span>}
            </span>
            <LoadPair t={t} title={title} onLoad={onLoad} />
        </div>
    );
}

function LoadPair({ t, title, onLoad }: { t: Translate; title: string; onLoad: (deck: DeckId) => void }) {
    return (
        <span className="flex items-center justify-center gap-1">
            <DeckButton deck="a" inRow label={t("libraryui.loadTo", { title, deck: "A" })} onClick={() => onLoad("a")}>
                A
            </DeckButton>
            <DeckButton deck="b" inRow label={t("libraryui.loadTo", { title, deck: "B" })} onClick={() => onLoad("b")}>
                B
            </DeckButton>
        </span>
    );
}

/** ≥ 24 px deck-coloured load button. Inside list rows it is skipped by Tab (Enter / Shift+Enter load instead). */
function DeckButton({
    deck,
    label,
    onClick,
    children,
    inRow,
    wide,
    disabled,
}: {
    deck: "a" | "b";
    label: string;
    onClick: () => void;
    children: ReactNode;
    inRow?: boolean;
    wide?: boolean;
    disabled?: boolean;
}) {
    const color = deck === "a" ? "var(--accent-deck-a)" : "var(--accent-deck-b)";
    return (
        <button
            type="button"
            aria-label={label}
            title={label}
            tabIndex={inRow ? -1 : undefined}
            disabled={disabled}
            onClick={(e) => {
                e.stopPropagation();
                onClick();
            }}
            onDoubleClick={(e) => e.stopPropagation()}
            className={cn(
                "inline-flex h-6 shrink-0 items-center justify-center rounded-md border text-[11px] font-bold outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40",
                wide ? "px-2.5" : "w-6",
            )}
            style={{ color, borderColor: color, background: "var(--bg-elev-2)" }}
        >
            {children}
        </button>
    );
}

function StemsCell({ t, ready, job, onStems }: { t: Translate; ready: boolean; job?: StemJob; onStems: () => void }) {
    if (ready) {
        return (
            <span title={t("libraryui.stemsReady")} className="inline-flex" style={{ color: "var(--accent)" }}>
                <Sparkles className="size-3.5" aria-hidden />
                <span className="sr-only">{t("libraryui.stemsReady")}</span>
            </span>
        );
    }
    if (job && job.state !== "done" && job.state !== "error") {
        const pct = job.state === "running" ? Math.round((job.progress || 0) * 100) : 0;
        return (
            <span className="mono text-[10px] tabular-nums" style={{ color: "var(--fg-dim)" }} title={t("libraryui.stemsProgress", { pct })}>
                {job.state === "running" ? `${pct}%` : "…"}
            </span>
        );
    }
    return (
        <button
            type="button"
            tabIndex={-1}
            aria-label={t("libraryui.stemsGenerate")}
            title={t("libraryui.stemsGenerate")}
            onClick={(e) => {
                e.stopPropagation();
                onStems();
            }}
            onDoubleClick={(e) => e.stopPropagation()}
            className="inline-flex size-6 items-center justify-center rounded-md border outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
            style={{ color: "var(--fg-dim)", borderColor: "var(--border)", background: "var(--bg-elev-2)" }}
        >
            <Sparkles className="size-3" aria-hidden />
        </button>
    );
}

/** Compact match badge: a coloured score chip + key hint. */
function MatchBadge({ match }: { match: TransitionScore }) {
    const pct = Math.round(match.score * 100);
    // Green ≥80, amber ≥55, dim otherwise.
    const color = match.score >= 0.8 ? "var(--success)" : match.score >= 0.55 ? "var(--warning)" : "var(--fg-dim)";
    const adj = match.bpmAdjustPct;
    const adjLabel = Math.abs(adj) < 0.05 ? "±0%" : `${adj > 0 ? "+" : ""}${adj.toFixed(1)}%`;
    return (
        <span title={`${match.key.label} · tempo ${adjLabel}`} className="mono inline-flex flex-col items-end text-[9px] font-bold leading-[1.1]" style={{ color }}>
            <span>{pct}%</span>
            <span className="opacity-80">{match.key.label}</span>
        </span>
    );
}

// ─── Toolbar bits ────────────────────────────────────────────────────────────

function SourceSwitch({ source, setSource, className }: { source: Source; setSource: (s: Source) => void; className?: string }) {
    const t = useT();
    return (
        <ToggleGroup
            value={[source]}
            onValueChange={(v) => {
                const next = v[0];
                if (next === "companion" || next === "local") setSource(next);
            }}
            variant="outline"
            size="sm"
            aria-label={t("libraryui.source")}
            className={cn("w-full", className)}
        >
            <ToggleGroupItem value="companion" className="flex-1 text-[11px] font-bold uppercase tracking-[0.06em]">
                {t("library.companion")}
            </ToggleGroupItem>
            <ToggleGroupItem value="local" className="flex-1 text-[11px] font-bold uppercase tracking-[0.06em]">
                {t("library.local")}
            </ToggleGroupItem>
        </ToggleGroup>
    );
}

interface AssistProps {
    decks: readonly DeckState[];
    deckKeys: Record<DeckId, string | null>;
    assistDeck: DeckId | null;
    setAssistDeck: (d: DeckId | null) => void;
}

/** Compact / icon tiers: the source switch and mix assist collapse into this menu. */
function LibraryMenu({ source, setSource, assist }: { source: Source; setSource: (s: Source) => void; assist?: AssistProps }) {
    const t = useT();
    const loaded = assist ? assist.decks.filter((d) => d.loaded) : [];
    return (
        <DropdownMenu>
            <DropdownMenuTrigger render={<Button size="icon-xs" variant="ghost" aria-label={t("libraryui.menu")} />}>
                <MoreVertical aria-hidden />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuGroup>
                    <DropdownMenuLabel>{t("libraryui.source")}</DropdownMenuLabel>
                    <DropdownMenuRadioGroup
                        value={source}
                        onValueChange={(v: unknown) => {
                            if (v === "companion" || v === "local") setSource(v);
                        }}
                    >
                        <DropdownMenuRadioItem value="companion">{t("library.companion")}</DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="local">{t("library.local")}</DropdownMenuRadioItem>
                    </DropdownMenuRadioGroup>
                </DropdownMenuGroup>
                {assist && (
                    <>
                        <DropdownMenuSeparator />
                        <DropdownMenuGroup>
                            <DropdownMenuLabel>{t("library.mixAssist")}</DropdownMenuLabel>
                            <DropdownMenuRadioGroup
                                value={assist.assistDeck ?? "off"}
                                onValueChange={(v: unknown) => {
                                    if (v === "off") assist.setAssistDeck(null);
                                    else if (v === "a" || v === "b" || v === "c" || v === "d") assist.setAssistDeck(v);
                                }}
                            >
                                <DropdownMenuRadioItem value="off">{t("libraryui.assistOff")}</DropdownMenuRadioItem>
                                {loaded.map((d) => (
                                    <DropdownMenuRadioItem key={d.id} value={d.id}>
                                        {t("libraryui.assistDeck", { deck: d.id.toUpperCase() })}
                                    </DropdownMenuRadioItem>
                                ))}
                            </DropdownMenuRadioGroup>
                            {loaded.length === 0 && <DropdownMenuLabel>{t("libraryui.assistNone")}</DropdownMenuLabel>}
                        </DropdownMenuGroup>
                    </>
                )}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

/**
 * Harmonic mix-assist toggle bar (full tier). Pick a deck to rank library
 * tracks by how well they'd mix into that deck's playing track (Camelot key + BPM).
 */
function MixAssistBar({ decks, deckKeys, assistDeck, setAssistDeck }: AssistProps) {
    const t = useT();
    const loaded = decks.filter((d) => d.loaded);
    const ref = assistDeck ? decks.find((d) => d.id === assistDeck) : null;
    return (
        <div className="flex min-w-0 items-center gap-1.5 overflow-hidden rounded-md px-2 py-0.5" style={{ background: "var(--bg-elev-2)" }}>
            <span className="mr-auto inline-flex min-w-0 items-center gap-1 truncate text-[10px] tracking-[0.1em]" style={{ color: "var(--fg-dim)" }}>
                <Sparkles className="size-2.5 shrink-0" aria-hidden />
                <span className="truncate">{t("library.mixAssist")}</span>
                {ref && (
                    <span className="mono ml-2 truncate" style={{ color: "var(--accent-2)" }}>
                        → {deckKeys[ref.id] ?? "?"} · {ref.bpm > 0 ? ref.bpm.toFixed(0) : "--"} BPM
                    </span>
                )}
            </span>
            <AssistPill active={assistDeck === null} onClick={() => setAssistDeck(null)} title={t("libraryui.assistOffHint")}>
                {t("libraryui.assistOff")}
            </AssistPill>
            {loaded.length === 0 && (
                <span className="truncate text-[10px]" style={{ color: "var(--fg-dim)" }}>
                    {t("libraryui.assistNone")}
                </span>
            )}
            {loaded.map((d) => (
                <AssistPill
                    key={d.id}
                    active={assistDeck === d.id}
                    onClick={() => setAssistDeck(d.id)}
                    title={t("libraryui.assistDeck", { deck: d.id.toUpperCase() }) + (d.title ? ` (${d.title})` : "")}
                >
                    {d.id.toUpperCase()}
                </AssistPill>
            ))}
        </div>
    );
}

function AssistPill({ active, onClick, title, children }: { active: boolean; onClick: () => void; title: string; children: ReactNode }) {
    return (
        <button
            type="button"
            aria-pressed={active}
            title={title}
            onClick={onClick}
            className="inline-flex h-6 min-w-6 shrink-0 items-center justify-center rounded-md border px-2 text-[10px] font-bold uppercase outline-none focus-visible:ring-2 focus-visible:ring-ring"
            style={{
                background: active ? "var(--accent)" : "var(--bg-elev)",
                color: active ? "var(--accent-fg)" : "var(--fg-dim)",
                borderColor: "var(--border)",
            }}
        >
            {children}
        </button>
    );
}

// ─── States ──────────────────────────────────────────────────────────────────

function StatusLine({ status, t, onSettings }: { status: "checking" | "offline" | "unconfigured"; t: Translate; onSettings: () => void }) {
    if (status === "checking") {
        return (
            <div aria-busy="true" className="p-1">
                <SkeletonText lines={2} />
            </div>
        );
    }
    const offline = status === "offline";
    return (
        <div className="flex min-w-0 flex-col gap-1 overflow-hidden">
            <span
                className="inline-flex min-w-0 items-center gap-1.5 text-xs font-semibold"
                style={{ color: offline ? "var(--warning)" : undefined }}
                title={t(offline ? "library.offlineDetail" : "library.unconfiguredDetail")}
            >
                {offline ? <WifiOff className="size-3.5 shrink-0" aria-hidden /> : <Link2Off className="size-3.5 shrink-0" aria-hidden />}
                <span className="truncate">{t(offline ? "library.offline" : "library.unconfigured")}</span>
            </span>
            {!offline && (
                <Button size="xs" variant="outline" className="self-start" onClick={onSettings}>
                    {t("library.openSettings")}
                </Button>
            )}
        </div>
    );
}

function ListPlaceholder({
    tier,
    t,
    error,
    loading,
    hasQuery,
    onRetry,
}: {
    tier: Tier;
    t: Translate;
    error: string | null;
    loading: boolean;
    hasQuery: boolean;
    onRetry: () => void;
}) {
    if (tier !== "full") {
        if (error)
            return (
                <span className="inline-flex min-w-0 items-center gap-1.5 text-[11px]">
                    <span className="truncate" style={{ color: "var(--destructive)" }} title={error}>
                        {t("library.error")}
                    </span>
                    <Button size="xs" variant="ghost" onClick={onRetry}>
                        {t("common.retry")}
                    </Button>
                </span>
            );
        const key = loading ? "library.loading" : hasQuery ? "library.noResults" : "library.empty";
        return (
            <span className="truncate text-[11px]" style={{ color: "var(--fg-dim)" }} aria-busy={loading || undefined}>
                {t(key)}
            </span>
        );
    }
    if (error) return <ErrorState variant="inline" title={t("library.error")} detail={error} onRetry={onRetry} className="overflow-hidden p-2" />;
    if (loading)
        return (
            <div className="w-full p-2" aria-busy="true">
                <SkeletonText lines={3} />
            </div>
        );
    if (hasQuery) return <NoResultsState title={t("library.noResults")} description={t("library.noResultsDetail")} className="overflow-hidden p-2" />;
    return <EmptyState variant="inline" title={t("library.empty")} description={t("library.emptyDetail")} className="overflow-hidden p-2" />;
}

// ─── Format helpers ──────────────────────────────────────────────────────────

const intFmt = new Intl.NumberFormat("ro-RO");

function fmtInt(n: number): string {
    return intFmt.format(n);
}

function fmtDuration(sec: number | null): string {
    if (!sec || sec <= 0) return "";
    const s = Math.round(sec);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
