import { memo, useState } from "react";
import { Eraser, SlidersHorizontal, X } from "lucide-react";
import { engine } from "@/bridge/engine";
import type { DeckId, DeckState } from "@/bridge/types";
import { useT } from "@/i18n";
import { useDeckGrid } from "@/grid/grid-store";
import { gridFromDeck, type GridModel } from "@/grid/markers";
import { cn } from "@mmo/ui";
import { MorePopover } from "./panel-ui";
import { soft } from "./deck-tabs/soft-disabled";
import { LOOP_SIZES, beatsLabel, deckPropsEqual, fmtCueTime, fmtLoopTime, loopBeats, loopLabel, matchLoopSize } from "./deck-tabs/tab-math";
import { useFitLevel } from "./deck-tabs/use-fit";

const PAD_COUNT = 8;
/** Pads shown at a time when the box holds neither two rows nor eight pads in a row. */
const PAD_PAGE = 4;
/** Loop sizes of the one-row variant (compact deck: under the four pads). */
const SHORT_LOOPS = [1, 2, 4, 8] as const;
/** Loop sizes kept in the row when all nine do not fit (the popover next to them has all). */
const MID_LOOPS = [0.5, 1, 2, 4, 8, 16] as const;

interface HotCuePadsProps {
    deckId: DeckId;
    deck: DeckState;
    /** Deck colour. Not used by the pads (each cue has its own colour); kept for callers. */
    accent: string;
    count?: 4 | 8;
    className?: string;
}

/**
 * Hot-cue pads. State is owned by the Rust audio core (cues are captured at the live
 * playhead), so this is fire-and-forget: it sends commands and reads back `deck.hotCues`
 * from the 30 Hz snapshot. The pads stretch to fill their box; `count` 4 shows only cues
 * 1–4 (compact tier).
 *
 * Clearing a cue: Shift+click, Delete / Backspace on a focused pad, or the eraser button
 * (arms ONE clear: the next set pad pressed is cleared), so it works with a mouse, a
 * keyboard and a touch screen.
 *
 * Eight pads take the roomiest form that fits their box: two rows of four, else one row of
 * eight, else four at a time with a page button (touch mode in a low box).
 */
function HotCuePadsImpl({ deckId, deck, count = PAD_COUNT, className }: HotCuePadsProps) {
    const t = useT();
    const [armed, setArmed] = useState(false);
     const [page, setPage] = useState(0);
     const [ref, level] = useFitLevel<HTMLDivElement>(count === PAD_COUNT ? 2 : 0, String(count));
     const paged = level === 2;
     const first = paged ? page * PAD_PAGE : 0;
     const shown = paged ? PAD_PAGE : count;
    const rows = count === PAD_COUNT && level === 0 ? 2 : 1;
     const otherFirst = (1 - page) * PAD_PAGE;
    const anySet = deck.hotCues.slice(0, count).some((c) => c != null);
    const clearing = armed && anySet;

    const clear = (slot: number) => {
        void engine.clearHotCue(deckId, slot);
        setArmed(false);
    };
    const onPad = (slot: number, shift: boolean) => {
        const isSet = deck.hotCues[slot] != null;
        if (shift || (clearing && isSet)) {
            clear(slot);
            return;
        }
        if (isSet) void engine.jumpHotCue(deckId, slot);
        else void engine.setHotCue(deckId, slot);
    };

    return (
        <div ref={ref} role="group" aria-label={t("deckui.hotCues")} className={cn("dt-cues", className)}>
            <div className="dt-pads" data-count={shown} style={{ ["--dt-cols" as string]: rows === 2 ? shown / 2 : shown, ["--dt-rows" as string]: rows }}>
                {Array.from({ length: shown }, (_, i) => {
                    const slot = first + i;
                    const at = deck.hotCues[slot];
                    const isSet = at != null;
                    const willClear = clearing && isSet;
                    return (
                        <button
                            key={slot}
                            type="button"
                            className="dk-pad dt-pad"
                            data-set={isSet}
                            data-clear={willClear ? "" : undefined}
                            style={{ ["--pad-color" as string]: `var(--cue-${slot + 1})` }}
                            onClick={(e) => onPad(slot, e.shiftKey)}
                            onKeyDown={(e) => {
                                if (!isSet || (e.key !== "Delete" && e.key !== "Backspace")) return;
                                // Keep the deck shortcuts (bound to bare keys) from firing too.
                                e.preventDefault();
                                e.stopPropagation();
                                clear(slot);
                            }}
                            disabled={!deck.loaded}
                            aria-label={t(willClear ? "decktabs.cueClear" : isSet ? "deckui.cueJump" : "deckui.cueSet", { n: slot + 1 })}
                            title={t(isSet ? "decktabs.cuePadHint" : "deckui.cueSetHint")}
                        >
                            <b>{slot + 1}</b>
                            {isSet && <span className="dk-num dt-pad-time">{fmtCueTime(at)}</span>}
                            {willClear && <X size={11} aria-hidden className="dt-pad-x" />}
                        </button>
                    );
                })}
            </div>
            {paged && (
                <button
                    type="button"
                    className="dk-btn dk-btn-xs dt-cue-page"
                    onClick={() => setPage((p) => 1 - p)}
                    aria-label={t("decktabs.cuePage", { from: otherFirst + 1, to: otherFirst + PAD_PAGE })}
                    title={t("decktabs.cuePage", { from: otherFirst + 1, to: otherFirst + PAD_PAGE })}
                >
                    {otherFirst + 1}–{otherFirst + PAD_PAGE}
                </button>
            )}
            <button
                type="button"
                className="dk-btn dk-btn-icon dt-cue-clear"
                aria-pressed={clearing}
                aria-label={t("decktabs.cueClearMode")}
                title={t("decktabs.cueClearMode")}
                {...soft(!anySet, () => setArmed((a) => !a))}
            >
                <Eraser size={13} aria-hidden />
            </button>
        </div>
    );
}
export const HotCuePads = memo(HotCuePadsImpl, deckPropsEqual<DeckState, HotCuePadsProps>(["loaded", "hotCues"]));

/** Deck fields the loop rows read (the position is not one of them: no render per frame). */
const LOOP_FIELDS = ["id", "trackId", "loaded", "bpm", "firstBeat", "loopActive", "loopStart", "loopEnd"] as const;

function useLoopGrid(deck: DeckState): GridModel | null {
    const stored = useDeckGrid(deck.id, deck.trackId);
    return stored ?? (deck.bpm > 0 ? gridFromDeck(deck.bpm, deck.firstBeat) : null);
}

interface LoopRowProps {
    deckId: DeckId;
    deck: DeckState;
    className?: string;
    /** One-row variant: sizes 1 / 2 / 4 / 8 and the LOOP on/off toggle. */
    short?: boolean;
    /** Six sizes (1/2 … 16) instead of nine, for a row that cannot hold them all. */
    mid?: boolean;
}

/**
 * Beat-loop sizes (1/8 … 32 beats). The size of the running loop is marked (outline +
 * `aria-pressed`). `short` adds the LOOP toggle, for places with no {@link LoopEditRow}.
 */
function LoopRowImpl({ deckId, deck, className, short, mid }: LoopRowProps) {
    const t = useT();
    const grid = useLoopGrid(deck);
    const canBeat = deck.loaded && deck.bpm > 0;
    const running = deck.loopActive ? matchLoopSize(loopBeats(grid, deck.loopStart, deck.loopEnd)) : null;
    const sizes: readonly number[] = short ? SHORT_LOOPS : mid ? MID_LOOPS : LOOP_SIZES;
    return (
        <div role="group" aria-label={t("deckui.loops")} className={cn("dt-loop-row", className)} style={{ ["--dt-n" as string]: sizes.length + (short ? 1 : 0) }}>
            {sizes.map((beats) => {
                const label = beatsLabel(beats);
                return (
                    <button
                        key={beats}
                        type="button"
                        className="dk-cell"
                        aria-pressed={running === beats}
                        onClick={() => void engine.beatloop(deckId, beats)}
                        disabled={!canBeat}
                        aria-label={t("deckui.beatLoop", { n: label })}
                        title={t("deckui.beatLoop", { n: label })}
                    >
                        {label}
                    </button>
                );
            })}
            {short && (
                <button
                    type="button"
                    className="dk-btn dk-btn-xs"
                    onClick={() => void engine.loopToggle(deckId)}
                    disabled={!deck.loaded}
                    aria-pressed={deck.loopActive}
                    title={t("deckui.loopToggle")}
                >
                    {t("deckui.loop")}
                </button>
            )}
        </div>
    );
}
export const LoopRow = memo(LoopRowImpl, deckPropsEqual<DeckState, LoopRowProps>(LOOP_FIELDS));

interface LoopEditRowProps {
    deckId: DeckId;
    deck: DeckState;
    className?: string;
}

/** Manual loop: IN / OUT, halve / double, EXIT / RELOOP and the loop state as text. */
function LoopEditRowImpl({ deckId, deck, className }: LoopEditRowProps) {
    const t = useT();
    const grid = useLoopGrid(deck);
    const beats = loopBeats(grid, deck.loopStart, deck.loopEnd);
    const length = beats !== null ? loopLabel(beats) : fmtLoopTime(Math.max(0, deck.loopEnd - deck.loopStart));
    const noLoop = !deck.loaded || !deck.loopActive;
    const state = deck.loopActive ? t("decktabs.loopOnState", { n: length }) : t("decktabs.loopOffState");
    return (
        <div role="group" aria-label={t("deckui.loopEdit")} className={cn("dt-loop-edit", className)}>
            <button type="button" className="dk-btn dk-btn-xs" onClick={() => void engine.loopIn(deckId)} disabled={!deck.loaded} aria-label={t("deckui.loopInAria")}>
                {t("deckui.loopIn")}
            </button>
            <button type="button" className="dk-btn dk-btn-xs" onClick={() => void engine.loopOut(deckId)} disabled={!deck.loaded} aria-label={t("deckui.loopOutAria")}>
                {t("deckui.loopOut")}
            </button>
            <button type="button" className="dk-btn dk-btn-xs" aria-label={t("deckui.loopHalve")} title={t("deckui.loopHalve")} {...soft(noLoop, () => void engine.loopScale(deckId, 0.5))}>
                ½
            </button>
            <button type="button" className="dk-btn dk-btn-xs" aria-label={t("deckui.loopDouble")} title={t("deckui.loopDouble")} {...soft(noLoop, () => void engine.loopScale(deckId, 2))}>
                ×2
            </button>
            <button type="button" className="dk-btn dk-btn-xs" aria-label={t("decktabs.loopExitAria")} title={t("decktabs.loopExitAria")} {...soft(noLoop, () => void engine.loopExit(deckId))}>
                {t("decktabs.loopExit")}
            </button>
            <button
                type="button"
                className="dk-btn dk-btn-xs"
                aria-label={t("decktabs.reloopAria")}
                title={t("decktabs.reloopAria")}
                {...soft(!deck.loaded || deck.loopActive, () => void engine.loopToggle(deckId))}
            >
                {t("decktabs.reloop")}
            </button>
            <span className="dk-well dt-loop-state" data-on={deck.loopActive} title={state}>
                <span className="dk-label" aria-hidden>
                    {t("deckui.loop")}
                </span>
                <span className="dk-num dk-num-sm" aria-hidden>
                    {deck.loopActive ? length : t("deckui.off")}
                </span>
                {/* The live region holds the sentence as TEXT: a status whose text is hidden and
                    that only has an `aria-label` announces nothing when the loop changes. */}
                <span role="status" className="sr-only">
                    {state}
                </span>
            </span>
        </div>
    );
}
export const LoopEditRow = memo(LoopEditRowImpl, deckPropsEqual<DeckState, LoopEditRowProps>(LOOP_FIELDS));

/**
 * Body of the LOOP tab: the size cells over the manual-loop row. A box too low for two rows
 * keeps the sizes (the running one is marked) and moves the manual-loop row into a popover
 * (level 1); a row too narrow for nine sizes keeps six and the popover has all nine (level 2).
 */
function LoopsBodyImpl({ deckId, deck, accent }: { deckId: DeckId; deck: DeckState; accent: string }) {
    const t = useT();
    const [ref, level] = useFitLevel<HTMLDivElement>(2);
    return (
        <div ref={ref} className="dt-loops" data-level={level}>
            <LoopRow deckId={deckId} deck={deck} mid={level === 2} />
            {level === 0 ? (
                <LoopEditRow deckId={deckId} deck={deck} />
            ) : (
                <MorePopover label={t("deckui.loopEdit")} icon={<SlidersHorizontal size={13} aria-hidden />} side="top">
                    <div className="dt-loops-pop" data-deck-scope="" style={{ ["--deck" as string]: accent }}>
                        {level === 2 && <LoopRow deckId={deckId} deck={deck} />}
                        <LoopEditRow deckId={deckId} deck={deck} />
                    </div>
                </MorePopover>
            )}
        </div>
    );
}
export const LoopsBody = memo(LoopsBodyImpl, deckPropsEqual<DeckState, { deckId: DeckId; deck: DeckState; accent: string }>(LOOP_FIELDS));

/** Hot cues + loop rows stacked (kept for any caller that wants the whole block). */
export function PerformancePads({ deckId, deck, accent }: { deckId: DeckId; deck: DeckState; accent: string }) {
    return (
        <div className="grid min-h-0 gap-1">
            <HotCuePads deckId={deckId} deck={deck} accent={accent} />
            <LoopRow deckId={deckId} deck={deck} />
            <LoopEditRow deckId={deckId} deck={deck} />
        </div>
    );
}
