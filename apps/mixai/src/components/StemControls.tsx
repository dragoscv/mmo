import { useMemo, useState } from "react";
import { engine } from "@/bridge/engine";
import type { DeckId, DeckState } from "@/bridge/types";
import { useMixerStore } from "@/state/mixer-store";
import { useT, type MessageKey } from "@/i18n";
import { cn } from "@mmo/ui";

/** Stem layer order matches the Rust engine: vocals, drums, bass, melody. */
const STEMS: readonly { idx: number; label: MessageKey; title: MessageKey }[] = [
    { idx: 0, label: "deckui.stemVoxShort", title: "deckui.stemVox" },
    { idx: 1, label: "deckui.stemDrmShort", title: "deckui.stemDrm" },
    { idx: 2, label: "deckui.stemBasShort", title: "deckui.stemBas" },
    { idx: 3, label: "deckui.stemMelShort", title: "deckui.stemMel" },
];

const small =
    "inline-flex min-h-6 min-w-6 items-center justify-center rounded-md text-[9px] font-bold focus-visible:outline-2 focus-visible:outline-[var(--ring)] disabled:opacity-40";

/**
 * Live per-stem control: mute/solo/blend vocals, drums, bass and melody on the
 * fly. Gains are smoothed in the audio engine so toggles are click-free. The
 * vertical gain sliders stretch to the height they get (the deck's Stems tab).
 * Without separated stems it shows a short hint instead of nothing, so the tab
 * never looks broken.
 */
export function StemControls({ deckId, deck, accent, className }: { deckId: DeckId; deck: DeckState; accent: string; className?: string }) {
    const t = useT();
    const patchDeck = useMixerStore((s) => s.patchDeck);
    const [solo, setSolo] = useState<number | null>(null);

    const gains = useMemo(() => {
        const g = deck.stemGains ?? [1, 1, 1, 1];
        return [g[0] ?? 1, g[1] ?? 1, g[2] ?? 1, g[3] ?? 1];
    }, [deck.stemGains]);

    if (!deck.hasStems) {
        return (
            <p className={cn("m-0 grid min-h-0 place-items-center text-center text-[11px] text-[var(--fg-dim)]", className)}>
                {t("deckui.noStems")}
            </p>
        );
    }

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
        <div className={cn("grid min-h-0 gap-1.5", className)} style={{ gridTemplateRows: "auto minmax(0, 1fr)" }}>
            <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] tracking-[0.12em] text-[var(--fg-dim)]">{t("deckui.stems")}</span>
                <button
                    type="button"
                    onClick={toggleActive}
                    aria-pressed={deck.stemsActive}
                    title={t("deckui.stemsToggleHint")}
                    className={cn(small, "px-2.5 text-[10px]")}
                    style={{
                        background: deck.stemsActive ? accent : "var(--bg-elev-2)",
                        color: deck.stemsActive ? "var(--accent-fg)" : "var(--fg)",
                    }}
                >
                    {deck.stemsActive ? t("deckui.on") : t("deckui.off")}
                </button>
            </div>
            <div className="grid min-h-0 grid-cols-4 gap-1.5" style={{ opacity: deck.stemsActive ? 1 : 0.4 }}>
                {STEMS.map(({ idx, label, title }) => {
                    const g = gains[idx] ?? 1;
                    const muted = g <= 0.001;
                    const isSolo = solo === idx;
                    const name = t(title);
                    return (
                        <div key={idx} className="grid min-h-0 justify-items-center gap-1" style={{ gridTemplateRows: "minmax(24px, 1fr) auto auto" }}>
                            <input
                                type="range"
                                min={0}
                                max={1.2}
                                step={0.01}
                                value={g}
                                aria-label={t("deckui.stemGain", { stem: name })}
                                disabled={!deck.stemsActive}
                                onChange={(e) => setGain(idx, Number(e.target.value))}
                                style={{ writingMode: "vertical-lr", direction: "rtl", width: 24, height: "100%", minHeight: 0, accentColor: accent }}
                            />
                            <span className="mono text-[9px] text-[var(--fg-dim)]">{t(label)}</span>
                            <div className="flex gap-0.5">
                                <button
                                    type="button"
                                    onClick={() => toggleMute(idx)}
                                    disabled={!deck.stemsActive}
                                    aria-pressed={muted}
                                    aria-label={t("deckui.stemMute", { stem: name })}
                                    className={small}
                                    style={{ background: muted ? "var(--danger)" : "var(--bg-elev-2)", color: muted ? "var(--destructive-foreground)" : "var(--fg-dim)" }}
                                >
                                    M
                                </button>
                                <button
                                    type="button"
                                    onClick={() => toggleSolo(idx)}
                                    disabled={!deck.stemsActive}
                                    aria-pressed={isSolo}
                                    aria-label={t("deckui.stemSolo", { stem: name })}
                                    className={small}
                                    style={{ background: isSolo ? accent : "var(--bg-elev-2)", color: isSolo ? "var(--accent-fg)" : "var(--fg-dim)" }}
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
