import { useCallback, useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, FolderOpen, Sparkles, WifiOff, Link2Off } from "lucide-react";
import { Button, EmptyState, ErrorState, Input, NoResultsState, SkeletonText, ToggleGroup, ToggleGroupItem } from "@mmo/ui";
import { engine } from "@/bridge/engine";
import type { DeckId, LibraryTrack } from "@/bridge/types";
import { useMixerStore } from "@/state/mixer-store";
import { useUiStore } from "@/state/ui-store";
import { parseCamelot, transitionScore } from "@/lib/harmonic";
import type { TransitionScore } from "@/lib/harmonic";
import { useAutoMixStore } from "@/state/auto-mix-store";
import { useT } from "@/i18n";

/**
 * Library browser. Two sources:
 *   - **Companion** — browse the mixai.ro library served by the local MMO
 *     Server (`server/`) over HTTP, proxied through Rust. Tracks live on the
 *     same machine, so loading uses the row's local `filepath` directly.
 *   - **Local** — pick any audio file from disk (Tauri dialog).
 */

type Source = "companion" | "local";

export function Library() {
    const t = useT();
    const [source, setSource] = useState<Source>("companion");

    return (
        <div className="panel" style={{ padding: 12, display: "grid", gridTemplateRows: "auto auto 1fr", gap: 8, minHeight: 0 }}>
            <ToggleGroup
                value={[source]}
                onValueChange={(v) => {
                    const next = v[0];
                    if (next === "companion" || next === "local") setSource(next);
                }}
                variant="outline"
                size="sm"
                className="w-full"
            >
                <ToggleGroupItem value="companion" className="flex-1 text-[11px] font-bold uppercase tracking-[0.06em]">
                    {t("library.companion")}
                </ToggleGroupItem>
                <ToggleGroupItem value="local" className="flex-1 text-[11px] font-bold uppercase tracking-[0.06em]">
                    {t("library.local")}
                </ToggleGroupItem>
            </ToggleGroup>

            {source === "companion" ? <CompanionLibrary /> : <LocalFiles />}
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

// ─── Companion ──────────────────────────────────────────────────────────────

function CompanionLibrary() {
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
    const [stemJob, setStemJob] = useState<Record<number, { state: string; progress: number }>>({});

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

    const load = async (deck: DeckId, t: LibraryTrack) => {
        const title = t.title ?? t.filename;
        const artist = t.artist ?? "Unknown";
        // Optimistic UI: reflect metadata immediately.
        patchDeck(deck, { trackId: String(t.id), title, artist, bpm: t.bpm ?? 0, loaded: true, position: 0 });
        setWaveform(deck, []);
        setDeckKey(deck, t.keyCamelot ?? null);
        // Try a direct local decode first (companion on this machine). If the
        // file isn't on local disk (remote companion / tunnel), stream it.
        let peaks: number[] | null = null;
        try {
            peaks = await engine.loadTrack({
                deck,
                source: t.filepath,
                trackId: String(t.id),
                title,
                artist,
                bpm: t.bpm ?? 0,
            });
        } catch {
            peaks = await engine.loadTrackStream({
                deck,
                trackId: t.id,
                title,
                artist,
                bpm: t.bpm ?? 0,
            });
        }
        if (peaks) setWaveform(deck, peaks);
        // If the companion has separated stems, attach them so the deck's
        // stem controls light up immediately.
        if (t.stemsStatus === "ready") {
            try {
                const s = await engine.companionTrackStems(t.id);
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
    };

    // Request stem separation for a track and poll until ready.
    const generateStems = useCallback(
        async (t: LibraryTrack) => {
            setStemJob((j) => ({ ...j, [t.id]: { state: "running", progress: 0 } }));
            try {
                const jobId = await engine.companionRequestStems(t.id);
                if (!jobId) throw new Error("no job id");
                // Poll every 1.5s until done/error.
                for (;;) {
                    await new Promise((r) => setTimeout(r, 1500));
                    const job = await engine.companionStemJob(jobId);
                    if (!job) continue;
                    setStemJob((j) => ({ ...j, [t.id]: { state: job.state, progress: job.progress } }));
                    if (job.state === "done") {
                        setTracks((prev) =>
                            prev.map((x) => (x.id === t.id ? { ...x, stemsStatus: "ready" } : x)),
                        );
                        break;
                    }
                    if (job.state === "error") break;
                }
            } catch {
                setStemJob((j) => ({ ...j, [t.id]: { state: "error", progress: 0 } }));
            }
        },
        [],
    );

        // Reference track for harmonic assist (the playing track on the chosen deck).
        const refDeck = assistDeck ? decks.find((d) => d.id === assistDeck) : null;
        const refKey = assistDeck ? parseCamelot(deckKeys[assistDeck]) : null;
        const refBpm = refDeck?.bpm ?? 0;

        // Rank visible tracks by transition score when assist is on; otherwise keep
        // the library's natural order with no match badge.
        const ranked = (() => {
            const base = tracks.map((t) => ({ t, match: null as ReturnType<typeof transitionScore> | null }));
            if (!assistDeck || (!refKey && refBpm <= 0)) return base;
            return base
                .map(({ t }) => ({
                    t,
                    match: transitionScore(
                        { key: refKey, bpm: refBpm },
                        { key: parseCamelot(t.keyCamelot), bpm: t.bpm ?? 0 },
                    ),
                }))
                .sort((a, b) => (b.match?.score ?? 0) - (a.match?.score ?? 0));
        })();

    if (status === "checking") {
        return (
            <div className="min-h-0 overflow-hidden p-2" aria-busy="true">
                <SkeletonText lines={5} />
            </div>
        );
    }
    if (status === "offline") {
        return (
            <EmptyState
                variant="inline"
                tone="warning"
                icon={<WifiOff aria-hidden />}
                title={t("library.offline")}
                description={t("library.offlineDetail")}
                className="min-h-0 overflow-y-auto"
            />
        );
    }
    if (status === "unconfigured") {
        return (
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
                className="min-h-0 overflow-y-auto"
            />
        );
    }

    return (
        <>
            <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("library.search")}
                size="sm"
                type="search"
                aria-label={t("library.search")}
            />
                <MixAssistBar
                    decks={decks}
                    deckKeys={deckKeys}
                    assistDeck={assistDeck}
                    setAssistDeck={setAssistDeck}
                />
                <div style={{ overflowY: "auto", display: "grid", gap: 4, alignContent: "start", minHeight: 0 }}>
                    {error && (
                        <ErrorState
                            variant="inline"
                            title={t("library.error")}
                            detail={error}
                            onRetry={() => void fetchTracks(query)}
                        />
                    )}
                    {!error && loading && tracks.length === 0 && (
                        <div className="p-2" aria-busy="true">
                            <SkeletonText lines={4} />
                        </div>
                    )}
                    {!error && !loading && tracks.length === 0 && query.trim() && (
                        <NoResultsState title={t("library.noResults")} description={t("library.noResultsDetail")} />
                    )}
                    {!error && !loading && tracks.length === 0 && !query.trim() && (
                        <EmptyState variant="inline" title={t("library.empty")} description={t("library.emptyDetail")} />
                    )}
                    {ranked.map(({ t, match }) => (
                        <TrackRow
                            key={t.id}
                            title={t.title ?? t.filename}
                            artist={t.artist ?? "Unknown"}
                            bpm={t.bpm ?? 0}
                            keyCamelot={t.keyCamelot}
                            match={match}
                            stemsStatus={t.stemsStatus}
                            stemJob={stemJob[t.id]}
                            onStems={() => void generateStems(t)}
                            onA={() => void load("a", t)}
                            onB={() => void load("b", t)}
                        />
                    ))}
                </div>
        </>
    );
}

// ─── Local files ─────────────────────────────────────────────────────────────

function LocalFiles() {
    const t = useT();
    const loadToDeck = useLoadToDeck();

    const openFileTo = async (deck: DeckId) => {
        const path = await engine.pickAudioFile();
        if (!path) return;
        const file = path.replace(/\\/g, "/").split("/").pop() ?? path;
        const title = file.replace(/\.[^.]+$/, "");
        await loadToDeck(deck, { id: path, title, artist: "Local file", bpm: 0, source: path });
    };

    return (
        <>
            <div style={{ display: "flex", gap: 6 }}>
                <span style={{ fontSize: 11, color: "var(--fg-dim)", alignSelf: "center", marginRight: "auto", display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <FolderOpen size={14} aria-hidden />
                    {t("library.pickFile")}
                </span>
                <button onClick={() => void openFileTo("a")} style={loadBtn("var(--accent-deck-a)")}>
                    <ChevronLeft size={12} aria-hidden /> {t("library.loadA")}
                </button>
                <button onClick={() => void openFileTo("b")} style={loadBtn("var(--accent-deck-b)")}>
                    {t("library.loadB")} <ChevronRight size={12} aria-hidden />
                </button>
            </div>
            <div style={{ overflowY: "auto", minHeight: 0 }}>
                <EmptyState variant="inline" icon={<FolderOpen aria-hidden />} title={t("library.local")} description={t("library.localHint")} />
            </div>
        </>
    );
}

// ─── Shared bits ─────────────────────────────────────────────────────────────

function TrackRow({
    title,
    artist,
    bpm,
    keyCamelot,
    match,
    stemsStatus,
    stemJob,
    onStems,
    onA,
    onB,
}: {
    title: string;
    artist: string;
    bpm: number;
    keyCamelot: string | null;
    match?: TransitionScore | null;
    stemsStatus?: string | null;
    stemJob?: { state: string; progress: number };
    onStems?: () => void;
    onA: () => void;
    onB: () => void;
}) {
    const busy = stemJob && stemJob.state !== "done" && stemJob.state !== "error";
    const ready = stemsStatus === "ready";
    const tt = useT();
    return (
        <div
            style={{
                display: "flex",
                gap: 8,
                alignItems: "center",
                padding: "8px 10px",
                borderRadius: 8,
                background: "var(--bg-elev)",
            }}
        >
            <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {title}
                </div>
                <div style={{ fontSize: 11, color: "var(--fg-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {artist}
                </div>
            </div>
            {keyCamelot && (
                <span className="mono" style={{ fontSize: 11, color: "var(--accent-2)" }}>
                    {keyCamelot}
                </span>
            )}
            {match && <MatchBadge match={match} />}
            <span className="mono" style={{ fontSize: 11, color: "var(--fg-dim)" }}>
                {bpm > 0 ? bpm.toFixed(0) : "--"}
            </span>
            {onStems &&
                (ready ? (
                    <span
                        title="Stems ready — loading a track auto-attaches them"
                        className="mono"
                        style={{ fontSize: 10, fontWeight: 700, color: "var(--accent)", display: "inline-flex", alignItems: "center", gap: 3 }}
                    >
                        <Sparkles size={10} aria-hidden /> {tt("library.stems")}
                    </span>
                ) : busy ? (
                    <span className="mono" style={{ fontSize: 10, color: "var(--fg-dim)" }}>
                        {stemJob!.state === "running"
                            ? `${Math.round((stemJob!.progress || 0) * 100)}%`
                            : "…"}
                    </span>
                ) : (
                    <button
                        onClick={onStems}
                        title="Generate stems (vocals / drums / bass / melody)"
                        style={{
                            fontSize: 10,
                            fontWeight: 700,
                            padding: "4px 8px",
                            borderRadius: 6,
                            background: "var(--bg-elev-2)",
                            color: "var(--fg-dim)",
                            border: "1px solid var(--border)",
                        }}
                    >
                        <Sparkles size={11} aria-hidden />
                    </button>
                ))}
            <button onClick={onA} style={loadBtn("var(--accent-deck-a)")}>
                <ChevronLeft size={12} aria-hidden /> A
            </button>
            <button onClick={onB} style={loadBtn("var(--accent-deck-b)")}>
                B <ChevronRight size={12} aria-hidden />
            </button>
        </div>
    );
}

/**
 * Harmonic mix-assist toggle bar. Pick a deck to rank library tracks by how
 * well they'd mix into that deck's playing track (Camelot key + BPM).
 */
function MixAssistBar({
    decks,
    deckKeys,
    assistDeck,
    setAssistDeck,
}: {
    decks: { id: DeckId; loaded: boolean; bpm: number; title: string | null }[];
    deckKeys: Record<DeckId, string | null>;
    assistDeck: DeckId | null;
    setAssistDeck: (d: DeckId | null) => void;
}) {
    const t = useT();
    const loaded = decks.filter((d) => d.loaded);
    const ref = assistDeck ? decks.find((d) => d.id === assistDeck) : null;
    return (
        <div
            style={{
                display: "flex",
                gap: 6,
                alignItems: "center",
                padding: "6px 8px",
                borderRadius: 8,
                background: "var(--bg-elev-2)",
            }}
        >
            <span style={{ fontSize: 10, color: "var(--fg-dim)", letterSpacing: "0.1em", marginRight: "auto", display: "inline-flex", alignItems: "center", gap: 4 }}>
                <Sparkles size={10} aria-hidden /> {t("library.mixAssist")}
                {ref && (
                    <span className="mono" style={{ marginLeft: 8, color: "var(--accent-2)" }}>
                        → {deckKeys[ref.id] ?? "?"} · {ref.bpm > 0 ? ref.bpm.toFixed(0) : "--"} BPM
                    </span>
                )}
            </span>
            <button
                onClick={() => setAssistDeck(null)}
                style={assistPill(assistDeck === null)}
                title="No ranking — natural library order"
            >
                OFF
            </button>
            {loaded.length === 0 && (
                <span style={{ fontSize: 10, color: "var(--fg-dim)" }}>load a deck…</span>
            )}
            {loaded.map((d) => (
                <button
                    key={d.id}
                    onClick={() => setAssistDeck(d.id)}
                    style={assistPill(assistDeck === d.id)}
                    title={`Rank against deck ${d.id.toUpperCase()}${d.title ? ` (${d.title})` : ""}`}
                >
                    {d.id.toUpperCase()}
                </button>
            ))}
        </div>
    );
}

/** Compact match badge: a coloured score chip + key/BPM hint. */
function MatchBadge({ match }: { match: TransitionScore }) {
    const pct = Math.round(match.score * 100);
    // Green ≥80, amber ≥55, dim otherwise.
    const color = match.score >= 0.8 ? "var(--success)" : match.score >= 0.55 ? "var(--warning)" : "var(--fg-dim)";
    const adj = match.bpmAdjustPct;
    const adjLabel = Math.abs(adj) < 0.05 ? "±0%" : `${adj > 0 ? "+" : ""}${adj.toFixed(1)}%`;
    return (
        <span
            title={`${match.key.label} · tempo ${adjLabel} to match`}
            className="mono"
            style={{
                display: "inline-flex",
                flexDirection: "column",
                alignItems: "flex-end",
                fontSize: 9,
                lineHeight: 1.1,
                color,
                fontWeight: 700,
                minWidth: 38,
            }}
        >
            <span>{pct}%</span>
            <span style={{ opacity: 0.8 }}>{match.key.label}</span>
        </span>
    );
}

function assistPill(active: boolean): React.CSSProperties {
    return {
        fontSize: 10,
        fontWeight: 700,
        padding: "3px 9px",
        borderRadius: 6,
        background: active ? "var(--accent)" : "var(--bg-elev)",
        color: active ? "var(--accent-fg)" : "var(--fg-dim)",
        border: "1px solid var(--border)",
    };
}

function loadBtn(color: string): React.CSSProperties {
    return {
        fontSize: 11,
        fontWeight: 700,
        padding: "4px 10px",
        borderRadius: 6,
        background: "var(--bg-elev-2)",
        color,
        border: `1px solid ${color}`,
        display: "inline-flex",
        alignItems: "center",
        gap: 2,
    };
}
