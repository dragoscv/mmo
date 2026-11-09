import { engine } from "@/bridge/engine";
import type { DeckId, DeckState } from "@/bridge/types";
import { useT } from "@/i18n";
import { cn } from "@mmo/ui";

const PAD_COUNT = 8;
const BEAT_LOOPS = [1, 2, 4, 8] as const;

const padBase =
    "flex min-h-6 min-w-6 items-center justify-center rounded-lg text-[11px] font-bold transition-colors duration-100 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--ring)] disabled:opacity-40";

/**
 * Hot-cue pads. State is owned by the Rust audio core (cues are captured at
 * the live playhead), so this is fire-and-forget: it sends commands and reads
 * back `deck.hotCues` from the 30 Hz snapshot. The grid stretches to fill its
 * box (pads grow with the panel); `count` 4 shows only cues 1–4 (compact tier).
 */
export function HotCuePads({
    deckId,
    deck,
    accent,
    count = PAD_COUNT,
    className,
}: {
    deckId: DeckId;
    deck: DeckState;
    accent: string;
    count?: 4 | 8;
    className?: string;
}) {
    const t = useT();
    const onPad = (slot: number, e: React.MouseEvent) => {
        if (e.shiftKey) {
            void engine.clearHotCue(deckId, slot);
            return;
        }
        if (deck.hotCues[slot] != null) void engine.jumpHotCue(deckId, slot);
        else void engine.setHotCue(deckId, slot);
    };
    const rows = count === 8 ? 2 : 1;
    return (
        <div
            role="group"
            aria-label={t("deckui.hotCues")}
            className={cn("grid min-h-0 gap-1.5", className)}
            style={{ gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gridTemplateRows: `repeat(${rows}, minmax(24px, 1fr))` }}
        >
            {Array.from({ length: count }, (_, slot) => {
                const isSet = deck.hotCues[slot] != null;
                return (
                    <button
                        key={slot}
                        type="button"
                        onClick={(e) => onPad(slot, e)}
                        disabled={!deck.loaded}
                        aria-label={t(isSet ? "deckui.cueJump" : "deckui.cueSet", { n: slot + 1 })}
                        title={t(isSet ? "deckui.cueJumpHint" : "deckui.cueSetHint")}
                        className={padBase}
                        style={{
                            background: isSet ? accent : "var(--bg-elev-2)",
                            color: isSet ? "var(--accent-fg)" : "var(--fg-dim)",
                            boxShadow: isSet ? `var(--glow) ${accent}` : "none",
                            // Not colour-only: set pads get a solid border, empty ones a dashed one.
                            border: `1px ${isSet ? "solid" : "dashed"} ${isSet ? accent : "var(--border)"}`,
                        }}
                    >
                        {slot + 1}
                    </button>
                );
            })}
        </div>
    );
}

/** Beat-loop sizes + LOOP toggle (one row). */
export function LoopRow({ deckId, deck, className }: { deckId: DeckId; deck: DeckState; className?: string }) {
    const t = useT();
    const canBeat = deck.loaded && deck.bpm > 0;
    return (
        <div role="group" aria-label={t("deckui.loops")} className={cn("flex min-h-0 gap-1.5", className)}>
            {BEAT_LOOPS.map((beats) => (
                <button
                    key={beats}
                    type="button"
                    onClick={() => void engine.beatloop(deckId, beats)}
                    disabled={!canBeat}
                    aria-label={t("deckui.beatLoop", { n: beats })}
                    title={t("deckui.beatLoop", { n: beats })}
                    className={cn(padBase, "flex-1 bg-[var(--bg-elev-2)] text-[var(--fg)]")}
                >
                    {beats}
                </button>
            ))}
            <button
                type="button"
                onClick={() => void engine.loopToggle(deckId)}
                disabled={!deck.loaded}
                aria-pressed={deck.loopActive}
                title={t("deckui.loopToggle")}
                className={cn(padBase, "flex-[1.4]")}
                style={{
                    background: deck.loopActive ? "var(--accent)" : "var(--bg-elev-2)",
                    color: deck.loopActive ? "var(--accent-fg)" : "var(--fg)",
                    boxShadow: deck.loopActive ? "var(--glow) var(--accent)" : "none",
                }}
            >
                {t("deckui.loop")}
            </button>
        </div>
    );
}

/** Manual loop in/out + halve/double. */
export function LoopEditRow({ deckId, deck, className }: { deckId: DeckId; deck: DeckState; className?: string }) {
    const t = useT();
    const btn = cn(padBase, "flex-1 bg-[var(--bg-elev-2)] text-[var(--fg)]");
    return (
        <div role="group" aria-label={t("deckui.loopEdit")} className={cn("flex min-h-0 gap-1.5", className)}>
            <button type="button" onClick={() => void engine.loopIn(deckId)} disabled={!deck.loaded} aria-label={t("deckui.loopInAria")} className={btn}>
                {t("deckui.loopIn")}
            </button>
            <button type="button" onClick={() => void engine.loopOut(deckId)} disabled={!deck.loaded} aria-label={t("deckui.loopOutAria")} className={btn}>
                {t("deckui.loopOut")}
            </button>
            <button type="button" onClick={() => void engine.loopScale(deckId, 0.5)} disabled={!deck.loaded || !deck.loopActive} aria-label={t("deckui.loopHalve")} className={btn}>
                ½
            </button>
            <button type="button" onClick={() => void engine.loopScale(deckId, 2)} disabled={!deck.loaded || !deck.loopActive} aria-label={t("deckui.loopDouble")} className={btn}>
                ×2
            </button>
        </div>
    );
}

/** Hot cues + loop rows stacked (kept for any caller that wants the whole block). */
export function PerformancePads({ deckId, deck, accent }: { deckId: DeckId; deck: DeckState; accent: string }) {
    return (
        <div className="grid min-h-0 gap-2">
            <HotCuePads deckId={deckId} deck={deck} accent={accent} />
            <LoopRow deckId={deckId} deck={deck} />
            <LoopEditRow deckId={deckId} deck={deck} />
        </div>
    );
}
