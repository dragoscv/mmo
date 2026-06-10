import { useMemo, useState } from "react";
import { engine } from "@/bridge/engine";
import type { DeckId, DeckState } from "@/bridge/types";
import { useMixerStore } from "@/state/mixer-store";

/** Stem layer order matches the Rust engine: vocals, drums, bass, melody. */
const STEMS = [
    { idx: 0, label: "VOX", title: "Vocals" },
    { idx: 1, label: "DRM", title: "Drums" },
    { idx: 2, label: "BAS", title: "Bass" },
    { idx: 3, label: "MEL", title: "Melody" },
] as const;

/**
 * Live per-stem control: mute/solo/blend vocals, drums, bass and melody on the
 * fly. Visible only once stems are loaded for the deck (set `hasStems`). Gains
 * are smoothed in the audio engine so toggles are click-free.
 */
export function StemControls({ deckId, deck, accent }: { deckId: DeckId; deck: DeckState; accent: string }) {
    const patchDeck = useMixerStore((s) => s.patchDeck);
    const [solo, setSolo] = useState<number | null>(null);

    const gains = useMemo(() => {
        const g = deck.stemGains ?? [1, 1, 1, 1];
        return [g[0] ?? 1, g[1] ?? 1, g[2] ?? 1, g[3] ?? 1];
    }, [deck.stemGains]);

    if (!deck.hasStems) return null;

    const apply = (next: number[], nextSolo: number | null) => {
        patchDeck(deckId, { stemGains: next });
        setSolo(nextSolo);
        for (const { idx } of STEMS) void engine.setStemGain(deckId, idx, next[idx] ?? 1);
    };

    const toggleMute = (idx: number) => {
        const muted = (gains[idx] ?? 1) <= 0.001;
        const next = gains.slice();
        next[idx] = muted ? 1 : 0;
        apply(next, null);
    };

    const toggleSolo = (idx: number) => {
        if (solo === idx) {
            apply([1, 1, 1, 1], null);
        } else {
            const next = [0, 0, 0, 0];
            next[idx] = 1;
            apply(next, idx);
        }
    };

    const setGain = (idx: number, v: number) => {
        const next = gains.slice();
        next[idx] = v;
        patchDeck(deckId, { stemGains: next });
        void engine.setStemGain(deckId, idx, v);
    };

    const toggleActive = () => {
        const next = !deck.stemsActive;
        patchDeck(deckId, { stemsActive: next });
        void engine.setStemsActive(deckId, next);
    };

    return (
        <div style={{ display: "grid", gap: 6 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 10, color: "var(--fg-dim)", letterSpacing: "0.12em" }}>STEMS</span>
                <button
                    onClick={toggleActive}
                    title="Toggle stem playback (vs. full mix)"
                    style={{
                        padding: "3px 10px",
                        borderRadius: 8,
                        fontSize: 10,
                        fontWeight: 700,
                        background: deck.stemsActive ? accent : "var(--bg-elev-2)",
                        color: deck.stemsActive ? "#000" : "var(--fg)",
                    }}
                >
                    {deck.stemsActive ? "ON" : "OFF"}
                </button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6, opacity: deck.stemsActive ? 1 : 0.4 }}>
                {STEMS.map(({ idx, label, title }) => {
                    const g = gains[idx] ?? 1;
                    const muted = g <= 0.001;
                    const isSolo = solo === idx;
                    return (
                        <div key={idx} style={{ display: "grid", gap: 4, justifyItems: "center" }}>
                            <input
                                type="range"
                                min={0}
                                max={1.2}
                                step={0.01}
                                value={g}
                                title={`${title} gain`}
                                disabled={!deck.stemsActive}
                                onChange={(e) => setGain(idx, Number(e.target.value))}
                                style={{
                                    writingMode: "vertical-lr",
                                    direction: "rtl",
                                    width: 18,
                                    height: 60,
                                    accentColor: accent,
                                }}
                            />
                            <span className="mono" style={{ fontSize: 9, color: "var(--fg-dim)" }}>{label}</span>
                            <div style={{ display: "flex", gap: 2 }}>
                                <button
                                    onClick={() => toggleMute(idx)}
                                    disabled={!deck.stemsActive}
                                    title={`Mute ${title}`}
                                    style={{
                                        padding: "2px 5px",
                                        borderRadius: 5,
                                        fontSize: 9,
                                        fontWeight: 700,
                                        background: muted ? "var(--danger)" : "var(--bg-elev-2)",
                                        color: muted ? "#fff" : "var(--fg-dim)",
                                    }}
                                >
                                    M
                                </button>
                                <button
                                    onClick={() => toggleSolo(idx)}
                                    disabled={!deck.stemsActive}
                                    title={`Solo ${title}`}
                                    style={{
                                        padding: "2px 5px",
                                        borderRadius: 5,
                                        fontSize: 9,
                                        fontWeight: 700,
                                        background: isSolo ? accent : "var(--bg-elev-2)",
                                        color: isSolo ? "#000" : "var(--fg-dim)",
                                    }}
                                >
                                    S
                                </button>
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
