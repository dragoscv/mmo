import { Suspense, lazy } from "react";
import { Lock, LockOpen, Pause, Play, RefreshCw } from "lucide-react";
import { Skeleton } from "@mmo/ui";
import { engine } from "@/bridge/engine";
import type { DeckId } from "@/bridge/types";
import { useMixerStore } from "@/state/mixer-store";
import { useT } from "@/i18n";
import { Waveform } from "./Waveform";
import { PerformancePads } from "./PerformancePads";

// Below-the-fold deck sections: not needed for first paint of the transport.
const StemControls = lazy(() => import("./StemControls").then((m) => ({ default: m.StemControls })));
const FxPanel = lazy(() => import("./FxPanel").then((m) => ({ default: m.FxPanel })));

function fmtTime(sec: number): string {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
}

export function Deck({ deckId }: { deckId: DeckId }) {
    const t = useT();
    const deck = useMixerStore((s) => s.deck(deckId));
    const patchDeck = useMixerStore((s) => s.patchDeck);

    // Deck colours are fixed per deck (D9) and never follow the theme accent.
    const accent = `var(--deck-${deckId})`;

    const togglePlay = () => {
        const next = !deck.playing;
        patchDeck(deckId, { playing: next });
        if (next) void engine.play(deckId);
        else void engine.pause(deckId);
    };

    const setTempo = (t: number) => {
        patchDeck(deckId, { tempo: t });
        void engine.setTempo(deckId, t);
    };

    const toggleKeyLock = () => {
        const next = !deck.keyLock;
        patchDeck(deckId, { keyLock: next });
        void engine.setKeyLock(deckId, next);
    };

    return (
        <div
            className="panel deck-card"
            data-playing={deck.playing ? "true" : "false"}
            style={{ ["--deck" as string]: accent, padding: 12, display: "grid", gap: 8, alignContent: "start" }}
        >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span
                        style={{
                            width: 10,
                            height: 10,
                            borderRadius: 99,
                            background: accent,
                            boxShadow: `var(--glow) ${accent}`,
                        }}
                    />
                    <strong style={{ letterSpacing: "0.1em" }}>{t("deck.title", { id: deckId.toUpperCase() })}</strong>
                </div>
                <span className="mono" style={{ fontSize: 11, color: "var(--fg-dim)" }}>
                    {deck.bpm > 0 ? (deck.bpm * deck.tempo).toFixed(1) : "--"} BPM
                </span>
            </div>

            <div style={{ minHeight: 30 }}>
                <div style={{ fontWeight: 600 }}>{deck.title ?? t("deck.noTrack")}</div>
                <div style={{ fontSize: 12, color: "var(--fg-dim)" }}>{deck.artist ?? "—"}</div>
            </div>

            <Waveform deck={deck} accent={accent} />

            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }} className="mono">
                <span>{fmtTime(deck.position)}</span>
                <span style={{ color: "var(--fg-dim)" }}>-{fmtTime(deck.duration - deck.position)}</span>
            </div>

            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <button
                    onClick={togglePlay}
                    disabled={!deck.loaded}
                    style={{
                        flex: 1,
                        padding: "10px 0",
                        borderRadius: 10,
                        background: deck.playing ? accent : "var(--bg-elev-2)",
                        color: deck.playing ? "var(--background)" : "var(--fg)",
                        fontWeight: 700,
                        opacity: deck.loaded ? 1 : 0.4,
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        gap: 6,
                    }}
                >
                    {deck.playing ? <Pause size={14} aria-hidden /> : <Play size={14} aria-hidden />}
                    {deck.playing ? t("deck.pause") : t("deck.play")}
                </button>
                <button
                    onClick={toggleKeyLock}
                    title="Key lock (preserve pitch when changing tempo)"
                    style={{
                        padding: "10px 12px",
                        borderRadius: 10,
                        background: deck.keyLock ? "var(--accent)" : "var(--bg-elev-2)",
                        color: deck.keyLock ? "var(--accent-fg)" : "var(--fg)",
                        fontWeight: 700,
                        fontSize: 12,
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 6,
                    }}
                >
                    {deck.keyLock ? <Lock size={13} aria-hidden /> : <LockOpen size={13} aria-hidden />}
                    {t("deck.key")}
                </button>
                <button
                    onClick={() => void engine.sync(deckId)}
                    disabled={!deck.loaded}
                    title="Beat sync to the other deck"
                    style={{
                        padding: "10px 12px",
                        borderRadius: 10,
                        background: "var(--bg-elev-2)",
                        color: "var(--fg)",
                        fontWeight: 700,
                        fontSize: 12,
                        opacity: deck.loaded ? 1 : 0.4,
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 6,
                    }}
                >
                    <RefreshCw size={13} aria-hidden />
                    {t("deck.sync")}
                </button>
            </div>

            <div style={{ display: "grid", gap: 4 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--fg-dim)" }}>
                    <span style={{ textTransform: "uppercase" }}>{t("deck.tempo")}</span>
                    <span className="mono">{((deck.tempo - 1) * 100 >= 0 ? "+" : "") + ((deck.tempo - 1) * 100).toFixed(1)}%</span>
                </div>
                <input
                    type="range"
                    min={0.5}
                    max={1.5}
                    step={0.001}
                    value={deck.tempo}
                    onChange={(e) => setTempo(Number(e.target.value))}
                />
            </div>

            <Suspense fallback={<Skeleton className="h-16 w-full" />}>
                <StemControls deckId={deckId} deck={deck} accent={accent} />
                <FxPanel deckId={deckId} deck={deck} accent={accent} />
            </Suspense>

            <PerformancePads deckId={deckId} deck={deck} accent={accent} />
        </div>
    );
}
