import { memo } from "react";
import { engine } from "@/bridge/engine";
import type { DeckId, DeckState } from "@/bridge/types";
import { useMixerStore } from "@/state/mixer-store";
import { useT, type MessageKey } from "@/i18n";
import { cn } from "@mmo/ui";
import { RadioCells } from "./deck-tabs/RadioCells";
import { deckPropsEqual } from "./deck-tabs/tab-math";

/** FX kinds, matching the Rust `FxKind` enum (0=off, 1=echo, 2=reverb). */
const FX: readonly { kind: number; label: MessageKey; title: MessageKey }[] = [
    { kind: 0, label: "deckui.fxOff", title: "deckui.fxOffHint" },
    { kind: 1, label: "deckui.fxEcho", title: "deckui.fxEchoHint" },
    { kind: 2, label: "deckui.fxReverb", title: "deckui.fxReverbHint" },
];

/** Beat divisions for the echo time. */
const BEATS = [
    { value: 0.25, label: "1/4" },
    { value: 0.5, label: "1/2" },
    { value: 1, label: "1" },
    { value: 2, label: "2" },
] as const;

interface FxPanelProps {
    deckId: DeckId;
    deck: DeckState;
    /** Deck colour; the look takes it from `--deck`, kept for callers. */
    accent: string;
    className?: string;
    /**
     * `all` (default) = type, wet and echo time; `main` = type and wet; `beats` = the echo time
     * alone (for a popover next to a `main` panel).
     */
    part?: "all" | "main" | "beats";
}

interface FxBeatsProps {
    deckId: DeckId;
    deck: DeckState;
    className?: string;
}

/** Echo time (beat division) of the deck FX: a radio group, off while no effect is selected. */
function FxBeatsImpl({ deckId, deck, className }: FxBeatsProps) {
    const t = useT();
    const patchDeck = useMixerStore((s) => s.patchDeck);
    const beats = deck.fxBeats ?? 0.5;
    const on = (deck.fxKind ?? 0) !== 0;
    const setBeats = (next: number) => {
        patchDeck(deckId, { fxBeats: next });
        void engine.setFxBeats(deckId, next);
    };
    const beatValue = BEATS.find((b) => Math.abs(beats - b.value) < 1e-6)?.value ?? -1;
    return (
        <RadioCells
            label={t("deckui.fxBeats")}
            value={beatValue}
            options={BEATS.map(({ value, label }) => ({ value, label, title: t("deckui.fxBeatHint", { n: label }) }))}
            onChange={setBeats}
            disabled={!on}
            className={cn("dt-fx-beats", className)}
        />
    );
}
const FxBeats = memo(FxBeatsImpl, deckPropsEqual<DeckState, FxBeatsProps>(["fxKind", "fxBeats"]));

/**
 * Per-deck FX unit: a beat-synced echo or a reverb tail with a wet/dry blend. The effect is
 * a post-fader insert in the audio engine, so tails follow the channel fader. Wet is smoothed
 * in the engine for click-free toggling. Type and echo time are radio groups (one tab stop,
 * arrow keys); the selected cell is outlined and `aria-checked`.
 */
function FxPanelImpl(props: FxPanelProps) {
    if (props.part === "beats") return <FxBeats deckId={props.deckId} deck={props.deck} className={props.className} />;
    return <FxMain {...props} />;
}

function FxMain({ deckId, deck, className, part = "all" }: FxPanelProps) {
    const t = useT();
    const patchDeck = useMixerStore((s) => s.patchDeck);

    const kind = deck.fxKind ?? 0;
    const wet = deck.fxWet ?? 0;
    const on = kind !== 0;
    const pct = Math.round(wet * 100);

    const setKind = (next: number) => {
        patchDeck(deckId, { fxKind: next });
        void engine.setFxKind(deckId, next);
    };
    const setWet = (next: number) => {
        patchDeck(deckId, { fxWet: next });
        void engine.setFxWet(deckId, next);
    };

    return (
        <div role="group" aria-label={t("deckui.fx")} className={cn("dt-fx", className)} data-on={on}>
            <RadioCells
                label={t("deckui.fxType")}
                value={kind}
                options={FX.map(({ kind: k, label, title }) => ({ value: k, label: t(label), title: t(title) }))}
                onChange={setKind}
                className="dt-fx-kind"
            />
            <label className="dt-fx-wet">
                <span className="dk-label">{t("decktabs.fxWetLabel")}</span>
                <input
                    type="range"
                    className="dt-range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={wet}
                    aria-label={t("deckui.fxWetAria")}
                    aria-valuetext={`${pct} %`}
                    disabled={!on}
                    onChange={(e) => setWet(Number(e.target.value))}
                    style={{ ["--v" as string]: `${pct}%` }}
                />
                <span className="dk-num dk-num-sm dt-fx-pct">{pct}%</span>
            </label>
            {part === "all" && <FxBeats deckId={deckId} deck={deck} />}
        </div>
    );
}
export const FxPanel = memo(FxPanelImpl, deckPropsEqual<DeckState, FxPanelProps>(["fxKind", "fxWet", "fxBeats"]));
