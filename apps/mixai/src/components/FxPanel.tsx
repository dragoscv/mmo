import { engine } from "@/bridge/engine";
import type { DeckId, DeckState } from "@/bridge/types";
import { useMixerStore } from "@/state/mixer-store";

/** FX kinds, matching the Rust `FxKind` enum (0=off, 1=echo, 2=reverb). */
const FX = [
    { kind: 0, label: "OFF", title: "No effect" },
    { kind: 1, label: "ECHO", title: "Beat-synced feedback echo" },
    { kind: 2, label: "REVERB", title: "Schroeder reverb tail" },
] as const;

/** Beat divisions for the echo time. */
const BEATS = [
    { value: 0.25, label: "1/4" },
    { value: 0.5, label: "1/2" },
    { value: 1, label: "1" },
    { value: 2, label: "2" },
] as const;

/**
 * Per-deck FX unit: a beat-synced echo or a reverb tail with a wet/dry blend.
 * The effect is a post-fader insert in the audio engine, so tails follow the
 * channel fader. Wet is smoothed in the engine for click-free toggling.
 */
export function FxPanel({ deckId, deck, accent }: { deckId: DeckId; deck: DeckState; accent: string }) {
    const patchDeck = useMixerStore((s) => s.patchDeck);

    const kind = deck.fxKind ?? 0;
    const wet = deck.fxWet ?? 0;
    const beats = deck.fxBeats ?? 0.5;
    const on = kind !== 0;

    const setKind = (next: number) => {
        patchDeck(deckId, { fxKind: next });
        void engine.setFxKind(deckId, next);
    };

    const setWet = (next: number) => {
        patchDeck(deckId, { fxWet: next });
        void engine.setFxWet(deckId, next);
    };

    const setBeats = (next: number) => {
        patchDeck(deckId, { fxBeats: next });
        void engine.setFxBeats(deckId, next);
    };

    return (
        <div style={{ display: "grid", gap: 6 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 10, color: "var(--fg-dim)", letterSpacing: "0.12em" }}>FX</span>
                <div style={{ display: "flex", gap: 3 }}>
                    {FX.map(({ kind: k, label, title }) => (
                        <button
                            key={k}
                            onClick={() => setKind(k)}
                            title={title}
                            style={{
                                padding: "3px 8px",
                                borderRadius: 8,
                                fontSize: 9,
                                fontWeight: 700,
                                letterSpacing: "0.04em",
                                background: kind === k ? accent : "var(--bg-elev-2)",
                                color: kind === k ? "#000" : "var(--fg-dim)",
                                transition: "background 120ms ease, color 120ms ease",
                            }}
                        >
                            {label}
                        </button>
                    ))}
                </div>
            </div>

            <div
                style={{
                    display: "grid",
                    gridTemplateColumns: "1fr auto",
                    gap: 8,
                    alignItems: "center",
                    opacity: on ? 1 : 0.4,
                    transition: "opacity 150ms ease",
                }}
            >
                {/* Wet/dry blend. */}
                <div style={{ display: "grid", gap: 3 }}>
                    <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.01}
                        value={wet}
                        title="Wet / dry mix"
                        disabled={!on}
                        onChange={(e) => setWet(Number(e.target.value))}
                        style={{ width: "100%", accentColor: accent }}
                    />
                    <span className="mono" style={{ fontSize: 9, color: "var(--fg-dim)" }}>
                        WET {Math.round(wet * 100)}%
                    </span>
                </div>

                {/* Echo beat division (only meaningful for echo, but harmless for reverb). */}
                <div style={{ display: "flex", gap: 2 }}>
                    {BEATS.map(({ value, label }) => (
                        <button
                            key={value}
                            onClick={() => setBeats(value)}
                            disabled={!on}
                            title={`Echo time: ${label} beat`}
                            style={{
                                padding: "2px 6px",
                                borderRadius: 5,
                                fontSize: 9,
                                fontWeight: 700,
                                background: Math.abs(beats - value) < 1e-6 ? accent : "var(--bg-elev-2)",
                                color: Math.abs(beats - value) < 1e-6 ? "#000" : "var(--fg-dim)",
                            }}
                        >
                            {label}
                        </button>
                    ))}
                </div>
            </div>
        </div>
    );
}
