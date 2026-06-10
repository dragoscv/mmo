import { engine } from "@/bridge/engine";
import type { DeckId, DeckState } from "@/bridge/types";

const PAD_COUNT = 8;
const BEAT_LOOPS = [1, 2, 4, 8] as const;

/**
 * Hot-cue pads + beat-loop controls for a deck.
 *
 * State is owned by the Rust audio core (cues are captured at the live
 * playhead), so this component is fire-and-forget: it sends commands and
 * reads back `deck.hotCues` / `deck.loopActive` from the 30 Hz snapshot.
 */
export function PerformancePads({ deckId, deck, accent }: { deckId: DeckId; deck: DeckState; accent: string }) {
    const onPad = (slot: number, e: React.MouseEvent) => {
        if (e.shiftKey) {
            void engine.clearHotCue(deckId, slot);
            return;
        }
        const isSet = deck.hotCues[slot] != null;
        if (isSet) void engine.jumpHotCue(deckId, slot);
        else void engine.setHotCue(deckId, slot);
    };

    return (
        <div style={{ display: "grid", gap: 8 }}>
            {/* Hot-cue pads */}
            <div
                style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(4, 1fr)",
                    gap: 6,
                }}
            >
                {Array.from({ length: PAD_COUNT }, (_, slot) => {
                    const isSet = deck.hotCues[slot] != null;
                    return (
                        <button
                            key={slot}
                            onClick={(e) => onPad(slot, e)}
                            disabled={!deck.loaded}
                            title={isSet ? "Click to jump · Shift+click to clear" : "Click to set hot cue"}
                            style={{
                                padding: "10px 0",
                                borderRadius: 8,
                                fontSize: 11,
                                fontWeight: 700,
                                background: isSet ? accent : "var(--bg-elev-2)",
                                color: isSet ? "#000" : "var(--fg-dim)",
                                boxShadow: isSet ? `var(--glow) ${accent}` : "none",
                                opacity: deck.loaded ? 1 : 0.4,
                                transition: "background 120ms ease, color 120ms ease",
                            }}
                        >
                            {slot + 1}
                        </button>
                    );
                })}
            </div>

            {/* Beat-loop row */}
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                {BEAT_LOOPS.map((beats) => (
                    <button
                        key={beats}
                        onClick={() => void engine.beatloop(deckId, beats)}
                        disabled={!deck.loaded || deck.bpm <= 0}
                        title={`${beats}-beat loop`}
                        style={{
                            flex: 1,
                            padding: "8px 0",
                            borderRadius: 8,
                            fontSize: 11,
                            fontWeight: 700,
                            background: "var(--bg-elev-2)",
                            color: "var(--fg)",
                            opacity: deck.loaded && deck.bpm > 0 ? 1 : 0.4,
                        }}
                    >
                        {beats}
                    </button>
                ))}
                <button
                    onClick={() => void engine.loopToggle(deckId)}
                    disabled={!deck.loaded}
                    title="Toggle loop"
                    style={{
                        flex: 1.4,
                        padding: "8px 0",
                        borderRadius: 8,
                        fontSize: 11,
                        fontWeight: 700,
                        background: deck.loopActive ? "var(--accent)" : "var(--bg-elev-2)",
                        color: deck.loopActive ? "#000" : "var(--fg)",
                        boxShadow: deck.loopActive ? "var(--glow) var(--accent)" : "none",
                        opacity: deck.loaded ? 1 : 0.4,
                    }}
                >
                    LOOP
                </button>
            </div>

            {/* Manual loop in/out + halve/double */}
            <div style={{ display: "flex", gap: 6 }}>
                <button
                    onClick={() => void engine.loopIn(deckId)}
                    disabled={!deck.loaded}
                    style={padStyle(deck.loaded)}
                >
                    IN
                </button>
                <button
                    onClick={() => void engine.loopOut(deckId)}
                    disabled={!deck.loaded}
                    style={padStyle(deck.loaded)}
                >
                    OUT
                </button>
                <button
                    onClick={() => void engine.loopScale(deckId, 0.5)}
                    disabled={!deck.loaded || !deck.loopActive}
                    style={padStyle(deck.loaded && deck.loopActive)}
                >
                    ½
                </button>
                <button
                    onClick={() => void engine.loopScale(deckId, 2)}
                    disabled={!deck.loaded || !deck.loopActive}
                    style={padStyle(deck.loaded && deck.loopActive)}
                >
                    ×2
                </button>
            </div>
        </div>
    );
}

function padStyle(enabled: boolean): React.CSSProperties {
    return {
        flex: 1,
        padding: "8px 0",
        borderRadius: 8,
        fontSize: 11,
        fontWeight: 700,
        background: "var(--bg-elev-2)",
        color: "var(--fg)",
        opacity: enabled ? 1 : 0.4,
    };
}
