import { engine } from "@/bridge/engine";
import type { DeckId } from "@/bridge/types";
import { useMixerStore } from "@/state/mixer-store";
import { Knob } from "./Knob";
import { Fader } from "./Fader";

function ChannelStrip({ deckId }: { deckId: DeckId }) {
    const deck = useMixerStore((s) => s.deck(deckId));
    const patchDeck = useMixerStore((s) => s.patchDeck);
    const accent = deckId === "a" || deckId === "c" ? "var(--accent-deck-a)" : "var(--accent-deck-b)";

    const setEq = (band: "low" | "mid" | "high", db: number) => {
        patchDeck(deckId, band === "low" ? { eqLow: db } : band === "mid" ? { eqMid: db } : { eqHigh: db });
        void engine.setEq(deckId, band, db);
    };
    const setFilter = (v: number) => {
        patchDeck(deckId, { filter: v });
        void engine.setFilter(deckId, v);
    };
    const setVolume = (v: number) => {
        patchDeck(deckId, { volume: v });
        void engine.setVolume(deckId, v);
    };
    const toggleCue = () => {
        const next = !deck.cue;
        patchDeck(deckId, { cue: next });
        void engine.setCue(deckId, next);
    };

    return (
        <div style={{ display: "grid", justifyItems: "center", gap: 8, padding: "0 6px" }}>
            <span style={{ fontSize: 10, fontWeight: 700, color: accent }}>{deckId.toUpperCase()}</span>
            <Knob value={deck.filter} min={-1} max={1} center={0} label="Filter" color={accent} onChange={setFilter} />
            <Knob value={deck.eqHigh} min={-26} max={6} center={0} label="Hi" onChange={(v) => setEq("high", v)} />
            <Knob value={deck.eqMid} min={-26} max={6} center={0} label="Mid" onChange={(v) => setEq("mid", v)} />
            <Knob value={deck.eqLow} min={-26} max={6} center={0} label="Low" onChange={(v) => setEq("low", v)} />
            <VuMeter level={deck.vu} />
            <Fader value={deck.volume} color={accent} onChange={setVolume} />
            <button
                onClick={toggleCue}
                style={{
                    fontSize: 10,
                    fontWeight: 700,
                    padding: "4px 10px",
                    borderRadius: 6,
                    background: deck.cue ? "var(--good)" : "var(--bg-elev-2)",
                    color: deck.cue ? "#000" : "var(--fg)",
                }}
            >
                CUE
            </button>
        </div>
    );
}

function VuMeter({ level }: { level: number }) {
    return (
        <div style={{ width: 8, height: 80, background: "var(--bg-elev-2)", borderRadius: 4, overflow: "hidden", position: "relative" }}>
            <div
                style={{
                    position: "absolute",
                    bottom: 0,
                    left: 0,
                    right: 0,
                    height: `${Math.min(1, level) * 100}%`,
                    background: "linear-gradient(0deg, var(--good), var(--warn) 80%, var(--danger))",
                }}
            />
        </div>
    );
}

export function MixerStrip({ decks }: { decks: DeckId[] }) {
    return (
        <div
            className="panel"
            style={{ padding: 12, display: "flex", gap: 4, alignItems: "stretch" }}
        >
            {decks.map((id) => (
                <ChannelStrip key={id} deckId={id} />
            ))}
        </div>
    );
}
