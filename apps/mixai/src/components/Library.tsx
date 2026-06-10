import { useCallback, useEffect, useState } from "react";
import { engine } from "@/bridge/engine";
import type { DeckId, LibraryTrack } from "@/bridge/types";
import { useMixerStore } from "@/state/mixer-store";
import { parseCamelot, transitionScore } from "@/lib/harmonic";
import type { TransitionScore } from "@/lib/harmonic";
import { useAutoMixStore } from "@/state/auto-mix-store";

/**
 * Library browser. Two sources:
 *   - **Companion** — browse the muzicai.ro library served by the local MMO
 *     Companion (`server/`) over HTTP, proxied through Rust. Tracks live on the
 *     same machine, so loading uses the row's local `filepath` directly.
 *   - **Local** — pick any audio file from disk (Tauri dialog).
 */

type Source = "companion" | "local";

export function Library() {
    const [source, setSource] = useState<Source>("companion");

    return (
        <div className="panel" style={{ padding: 12, display: "grid", gridTemplateRows: "auto auto 1fr", gap: 8, minHeight: 0 }}>
            <div style={{ display: "flex", gap: 4, background: "var(--bg-elev-2)", borderRadius: 8, padding: 2 }}>
                {(["companion", "local"] as const).map((s) => (
                    <button
                        key={s}
                        onClick={() => setSource(s)}
                        style={{
                            flex: 1,
                            padding: "6px 10px",
                            borderRadius: 6,
                            fontSize: 11,
                            fontWeight: 700,
                            textTransform: "uppercase",
                            letterSpacing: "0.06em",
                            background: source === s ? "var(--accent)" : "transparent",
                            color: source === s ? "#000" : "var(--fg-dim)",
                        }}
                    >
                        {s === "companion" ? "muzicai.ro" : "Local file"}
                    </button>
                ))}
            </div>

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
        return <Hint>Connecting to companion…</Hint>;
    }
    if (status === "offline") {
        return (
            <Hint>
                MMO Companion not reachable. Start the companion app, then reopen this panel.
            </Hint>
        );
    }
    if (status === "unconfigured") {
        return (
            <Hint>
                Companion online, but not paired. Add your device token and user id in{" "}
                <strong>Settings → muzicai.ro library</strong>.
            </Hint>
        );
    }

    return (
        <>
            <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search muzicai.ro library…"
                style={searchStyle}
            />
                <MixAssistBar
                    decks={decks}
                    deckKeys={deckKeys}
                    assistDeck={assistDeck}
                    setAssistDeck={setAssistDeck}
                />
                <div style={{ overflowY: "auto", display: "grid", gap: 4, alignContent: "start", minHeight: 0 }}>
                    {error && <Hint>⚠ {error}</Hint>}
                    {!error && loading && tracks.length === 0 && <Hint>Loading…</Hint>}
                    {!error && !loading && tracks.length === 0 && <Hint>No tracks found.</Hint>}
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
                <span style={{ fontSize: 11, color: "var(--fg-dim)", alignSelf: "center", marginRight: "auto" }}>
                    Open a file from disk →
                </span>
                <button onClick={() => void openFileTo("a")} style={loadBtn("var(--accent-deck-a)")}>
                    ◄ Deck A
                </button>
                <button onClick={() => void openFileTo("b")} style={loadBtn("var(--accent-deck-b)")}>
                    Deck B ►
                </button>
            </div>
            <div style={{ overflowY: "auto", minHeight: 0 }}>
                <Hint>Pick any MP3, WAV, FLAC, AAC, M4A, OGG or AIFF file to load it onto a deck.</Hint>
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
                        style={{ fontSize: 10, fontWeight: 700, color: "var(--accent)" }}
                    >
                        ✦ STEMS
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
                        ✦
                    </button>
                ))}
            <button onClick={onA} style={loadBtn("var(--accent-deck-a)")}>
                ◄ A
            </button>
            <button onClick={onB} style={loadBtn("var(--accent-deck-b)")}>
                B ►
            </button>
        </div>
    );
}

function Hint({ children }: { children: React.ReactNode }) {
    return <p style={{ fontSize: 12, color: "var(--fg-dim)", padding: "8px 4px", lineHeight: 1.5 }}>{children}</p>;
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
            <span style={{ fontSize: 10, color: "var(--fg-dim)", letterSpacing: "0.1em", marginRight: "auto" }}>
                ✦ MIX ASSIST
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
    const color = match.score >= 0.8 ? "#34d399" : match.score >= 0.55 ? "#fbbf24" : "var(--fg-dim)";
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
        color: active ? "#000" : "var(--fg-dim)",
        border: "1px solid var(--border)",
    };
}

const searchStyle: React.CSSProperties = {
    background: "var(--bg-elev-2)",
    border: "1px solid var(--border)",
    borderRadius: 8,
    padding: "8px 10px",
    color: "var(--fg)",
    fontSize: 13,
};

function loadBtn(color: string): React.CSSProperties {
    return {
        fontSize: 11,
        fontWeight: 700,
        padding: "4px 10px",
        borderRadius: 6,
        background: "var(--bg-elev-2)",
        color,
        border: `1px solid ${color}`,
    };
}
