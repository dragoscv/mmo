import { engine } from "@/bridge/engine";
import type { DeckId, DeckState } from "@/bridge/types";
import { useMixerStore } from "@/state/mixer-store";
import { useT, type MessageKey } from "@/i18n";
import { cn } from "@mmo/ui";

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

const chip =
    "inline-flex min-h-6 min-w-6 items-center justify-center rounded-md px-2 text-[9px] font-bold tracking-[0.04em] transition-colors duration-100 focus-visible:outline-2 focus-visible:outline-[var(--ring)] disabled:opacity-40";

/**
 * Per-deck FX unit: a beat-synced echo or a reverb tail with a wet/dry blend.
 * The effect is a post-fader insert in the audio engine, so tails follow the
 * channel fader. Wet is smoothed in the engine for click-free toggling.
 */
export function FxPanel({ deckId, deck, accent, className }: { deckId: DeckId; deck: DeckState; accent: string; className?: string }) {
    const t = useT();
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
        <div className={cn("grid min-w-0 content-start gap-1.5", className)}>
            <div className="flex flex-wrap items-center justify-between gap-1">
                <span className="text-[10px] tracking-[0.12em] text-[var(--fg-dim)]">{t("deckui.fx")}</span>
                <div role="radiogroup" aria-label={t("deckui.fxType")} className="flex gap-0.5">
                    {FX.map(({ kind: k, label, title }) => (
                        <button
                            key={k}
                            type="button"
                            role="radio"
                            aria-checked={kind === k}
                            onClick={() => setKind(k)}
                            title={t(title)}
                            className={chip}
                            style={{ background: kind === k ? accent : "var(--bg-elev-2)", color: kind === k ? "var(--accent-fg)" : "var(--fg-dim)" }}
                        >
                            {t(label)}
                        </button>
                    ))}
                </div>
            </div>
            <div className="grid min-w-0 items-center gap-2" style={{ gridTemplateColumns: "minmax(0, 1fr) auto", opacity: on ? 1 : 0.4 }}>
                <label className="flex min-w-0 items-center gap-1.5">
                    <span className="mono w-14 shrink-0 text-[9px] text-[var(--fg-dim)]">{t("deckui.fxWet", { n: Math.round(wet * 100) })}</span>
                    <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.01}
                        value={wet}
                        aria-label={t("deckui.fxWetAria")}
                        disabled={!on}
                        onChange={(e) => setWet(Number(e.target.value))}
                        className="min-w-0 flex-1"
                        style={{ minHeight: 24, accentColor: accent }}
                    />
                </label>
                <div role="radiogroup" aria-label={t("deckui.fxBeats")} className="flex gap-0.5">
                    {BEATS.map(({ value, label }) => {
                        const sel = Math.abs(beats - value) < 1e-6;
                        return (
                            <button
                                key={value}
                                type="button"
                                role="radio"
                                aria-checked={sel}
                                onClick={() => setBeats(value)}
                                disabled={!on}
                                title={t("deckui.fxBeatHint", { n: label })}
                                className={cn(chip, "px-1.5")}
                                style={{ background: sel ? accent : "var(--bg-elev-2)", color: sel ? "var(--accent-fg)" : "var(--fg-dim)" }}
                            >
                                {label}
                            </button>
                        );
                    })}
                </div>
            </div>
        </div>
    );
}
