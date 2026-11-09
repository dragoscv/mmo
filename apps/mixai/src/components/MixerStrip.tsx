import { engine } from "@/bridge/engine";
import type { DeckId } from "@/bridge/types";
import { useMixerStore } from "@/state/mixer-store";
import { useT } from "@/i18n";
import { Knob } from "./Knob";
import { Fader } from "./Fader";
import { RoutingPanel } from "./RoutingPanel";
import { BeatFxUnit } from "./BeatFxUnit";

function ChannelStrip({ deckId }: { deckId: DeckId }) {
    const t = useT();
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
            <Knob value={deck.filter} min={-1} max={1} center={0} label="Filter" ariaLabel={t("mixer.filterAria", { id: deckId.toUpperCase() })} color={accent} onChange={setFilter} />
            <Knob value={deck.eqHigh} min={-26} max={6} center={0} label="Hi" ariaLabel={t("mixer.eqHighAria", { id: deckId.toUpperCase() })} onChange={(v) => setEq("high", v)} />
            <Knob value={deck.eqMid} min={-26} max={6} center={0} label="Mid" ariaLabel={t("mixer.eqMidAria", { id: deckId.toUpperCase() })} onChange={(v) => setEq("mid", v)} />
            <Knob value={deck.eqLow} min={-26} max={6} center={0} label="Low" ariaLabel={t("mixer.eqLowAria", { id: deckId.toUpperCase() })} onChange={(v) => setEq("low", v)} />
            <VuMeter level={deck.vu} />
            <Fader value={deck.volume} color={accent} onChange={setVolume} ariaLabel={t("mixer.volumeAria", { id: deckId.toUpperCase() })} />
            <button
                type="button"
                onClick={toggleCue}
                aria-pressed={deck.cue}
                aria-label={t("mixer.cueAria", { id: deckId.toUpperCase() })}
                title={t("mixer.cueHint")}
                style={{
                    fontSize: 10,
                    fontWeight: 700,
                    padding: "4px 10px",
                    borderRadius: 6,
                    background: deck.cue ? "var(--good)" : "var(--bg-elev-2)",
                    color: deck.cue ? "var(--accent-fg)" : "var(--fg)",
                }}
            >
                {t("mixer.cue")}
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
            style={{
                padding: 12,
                display: "grid",
                gap: 10,
                alignContent: "start",
                minHeight: 0,
                overflowY: "auto",
            }}
        >
            <div style={{ display: "flex", gap: 4, alignItems: "stretch", justifyContent: "center" }}>
                {decks.map((id) => (
                    <ChannelStrip key={id} deckId={id} />
                ))}
            </div>
            <RoutingPanel />
            <BeatFxUnit decks={decks} />
        </div>
    );
}
