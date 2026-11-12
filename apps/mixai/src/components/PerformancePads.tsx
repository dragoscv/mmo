import { memo, useId, useState } from "react";
import { Eraser, Repeat, RepeatOff, SlidersHorizontal, X } from "lucide-react";
import { engine } from "@/bridge/engine";
import { saveCueLoop } from "@/bridge/stems";
import type { DeckId, DeckState } from "@/bridge/types";
import { useT } from "@/i18n";
import { useDeckGrid } from "@/grid/grid-store";
import { gridFromDeck, type GridModel } from "@/grid/markers";
import { cn } from "@mmo/ui";
import { MorePopover } from "./panel-ui";
import { useBeatsText } from "./deck-tabs/beats-text";
import { soft } from "./deck-tabs/soft-disabled";
import {
    LOOP_SIZES,
    beatsLabel,
    cueLoopBeats,
    cueLoopOffer,
    deckPropsEqual,
    fmtCueTime,
    fmtLoopTime,
    loopBeats,
    loopLabel,
    matchLoopSize,
    padArmLive,
    padPress,
    type PadArm,
    type PadArmKind,
} from "./deck-tabs/tab-math";
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
 * Cue loops: a hot cue can carry a loop. While a loop runs, the loop button arms ONE save: the
 * next pad pressed (set or empty) gets the running loop (the cue moves to the loop's start);
 * Alt+click (Alt+Enter on a focused pad) does the same in one step. Such a pad shows a loop
 * glyph and the length in beats, and jumping to it starts the loop again. With no loop running
 * the same button (then a crossed loop glyph) arms ONE removal: the next cue-loop pad pressed
 * loses its loop (the cue stays).
 *
 * An armed action keeps the meaning it had when its button was pressed and is dropped as soon
 * as the deck is no longer in that state (the loop ended or started, the last cue went, another
 * track was loaded): see `padArmLive`. While armed, the button is pressed (`aria-pressed`), every
 * pad the press would act on shows the action's glyph in a frame, and a status line says it.
 *
 * Eight pads take the roomiest form that fits their box: two rows of four, else one row of
 * eight, else four at a time with a page button (touch mode in a low box).
 */
function HotCuePadsImpl({ deckId, deck, count = PAD_COUNT, className }: HotCuePadsProps) {
    const t = useT();
    const beatsText = useBeatsText();
    const ids = useId();
    const [arm, setArm] = useState<PadArm | null>(null);
    /** The last arm was dropped by the deck (not used, not cancelled): said once to screen readers. */
    const [dropped, setDropped] = useState(false);
     const [page, setPage] = useState(0);
     const [ref, level] = useFitLevel<HTMLDivElement>(count === PAD_COUNT ? 2 : 0, String(count));
     const paged = level === 2;
     const first = paged ? page * PAD_PAGE : 0;
     const shown = paged ? PAD_PAGE : count;
    const rows = count === PAD_COUNT && level === 0 ? 2 : 1;
     const otherFirst = (1 - page) * PAD_PAGE;
    const anySet = deck.hotCues.slice(0, count).some((c) => c != null);
    const loopOf = (slot: number) => (deck.hotCues[slot] != null ? cueLoopBeats(deck.hotCueLoops, slot) : null);
    const anyLoop = Array.from({ length: count }, (_, slot) => loopOf(slot)).some((b) => b !== null);
    const context = { loaded: deck.loaded, loopActive: deck.loopActive, anyCueLoop: anyLoop, anySet };
    /** What the loop button does now: store the running loop, take a stored one off, or nothing. */
    const offer = cueLoopOffer(context);
    /** The armed action, as long as the deck is still in the state it was armed in. */
    const live = padArmLive(arm, deck.trackId, context);
    const clearing = live === "clear";
    const looping = live === "save" || live === "remove";
    // An arm the deck outgrew is dropped for good: it must not come back when the state returns
    // (armed "save", loop exited, a new loop later: the pad pressed then is pressed to jump).
    // State adjusted while rendering (no effect): React renders again at once with the arm gone.
    if (arm !== null && live === null) {
        setArm(null);
        setDropped(true);
    }

    const disarm = () => {
        setArm(null);
        setDropped(false);
    };
    /** Arm `kind` (fixed now, with the track it is armed on), or cancel it when it is the armed one. */
    const toggleArm = (kind: PadArmKind) => {
        setDropped(false);
        setArm(live === kind ? null : { kind, trackId: deck.trackId });
    };
    const clear = (slot: number) => {
        void engine.clearHotCue(deckId, slot);
        disarm();
    };
    /** The pad a press would store the running loop on / take the stored loop off. */
    const loopTarget = (slot: number) => live === "save" || (live === "remove" && loopOf(slot) !== null);
    const onPad = (slot: number, shift: boolean, alt: boolean) => {
        const isSet = deck.hotCues[slot] != null;
        // The "no longer armed" note is about the past: any pad press ends it.
        if (dropped) setDropped(false);
        switch (padPress({ isSet, hasLoop: loopOf(slot) !== null, shift, alt, arm: live, loopActive: deck.loopActive })) {
            case "clear":
                clear(slot);
                return;
            case "saveLoop":
            case "removeLoop":
                // One engine command for both: it stores the running loop, and with no loop
                // running it takes the slot's loop off.
                void saveCueLoop(deckId, slot);
                disarm();
                return;
            case "jump":
                void engine.jumpHotCue(deckId, slot);
                return;
            case "set":
                void engine.setHotCue(deckId, slot);
                return;
        }
    };
    const status = live !== null ? t(`decktabs.padArmed.${live}`) : dropped ? t("decktabs.padArmDropped") : "";
    const loopLabelKey = offer === "remove" ? "decktabs.cueLoopRemoveMode" : "decktabs.cueLoopSaveMode";

    return (
        <div ref={ref} role="group" aria-label={t("deckui.hotCues")} className={cn("dt-cues", className)}>
            {/* What a pad does, as its accessible description (the tooltip alone is out of reach of a keyboard). */}
            <span id={`${ids}set`} hidden>
                {t("decktabs.cuePadHint")}
            </span>
            <span id={`${ids}empty`} hidden>
                {t("decktabs.cueSetPadHint")}
            </span>
            <span id={`${ids}needs`} hidden>
                {t("decktabs.cueLoopNeedsLoop")}
            </span>
            <div className="dt-pads" data-count={shown} style={{ ["--dt-cols" as string]: rows === 2 ? shown / 2 : shown, ["--dt-rows" as string]: rows }}>
                {Array.from({ length: shown }, (_, i) => {
                    const slot = first + i;
                    const at = deck.hotCues[slot];
                    const isSet = at != null;
                    const willClear = clearing && isSet;
                    const loop = loopOf(slot);
                    const loopText = loop !== null ? loopLabel(loop) : null;
                    const willLoop = !willClear && loopTarget(slot);
                    const action = willClear
                        ? t("decktabs.cueClear", { n: slot + 1 })
                        : willLoop
                          ? t(live === "remove" ? "decktabs.cueLoopRemove" : "decktabs.cueLoopSave", { n: slot + 1 })
                          : t(isSet ? "deckui.cueJump" : "deckui.cueSet", { n: slot + 1 });
                    const loopNote = loopText !== null ? beatsText("decktabs.cueLoop", loopText) : null;
                    const hint = t(isSet ? "decktabs.cuePadHint" : "decktabs.cueSetPadHint");
                    return (
                        <button
                            key={slot}
                            type="button"
                            className="dk-pad dt-pad"
                            data-set={isSet}
                            data-clear={willClear ? "" : undefined}
                            data-loop={loop !== null ? "" : undefined}
                            data-loop-target={willLoop ? (live ?? undefined) : undefined}
                            style={{ ["--pad-color" as string]: `var(--cue-${slot + 1})` }}
                            onClick={(e) => onPad(slot, e.shiftKey, e.altKey)}
                            onKeyDown={(e) => {
                                // Alt+Enter = Alt+click (save the running loop here), spelled out:
                                // not every engine passes the modifier on to the click it makes of Enter.
                                if (e.key === "Enter" && e.altKey && !e.repeat) {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    onPad(slot, e.shiftKey, true);
                                    return;
                                }
                                if (!isSet || (e.key !== "Delete" && e.key !== "Backspace")) return;
                                // Keep the deck shortcuts (bound to bare keys) from firing too.
                                e.preventDefault();
                                e.stopPropagation();
                                clear(slot);
                            }}
                            disabled={!deck.loaded}
                            aria-label={loopNote ? `${action}. ${loopNote}` : action}
                            aria-describedby={`${ids}${isSet ? "set" : "empty"}`}
                            title={loopNote ? `${loopNote} · ${hint}` : hint}
                        >
                            <b>{slot + 1}</b>
                            {isSet && <span className="dk-num dt-pad-time">{fmtCueTime(at)}</span>}
                            {loopText !== null && (
                                <span className="dt-pad-loop" aria-hidden>
                                    <Repeat size={9} />
                                    <span className="dk-num">{loopText}</span>
                                </span>
                            )}
                            {/* Armed: the glyph of what the press will do (never the frame colour alone). */}
                            {willLoop && live === "save" && <Repeat size={11} aria-hidden className="dt-pad-loop-arm" />}
                            {willLoop && live === "remove" && <RepeatOff size={11} aria-hidden className="dt-pad-x" />}
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
            <div className="dt-cue-tools" data-rows={rows}>
                <button
                    type="button"
                    className="dk-btn dk-btn-icon dt-cue-loop"
                    aria-pressed={looping}
                    data-mode={live === "save" || live === "remove" ? live : (offer ?? undefined)}
                    aria-label={t(loopLabelKey)}
                    aria-describedby={offer === null ? `${ids}needs` : undefined}
                    title={t(offer === null ? "decktabs.cueLoopNeedsLoop" : loopLabelKey)}
                    {...soft(offer === null, () => {
                        if (offer !== null) toggleArm(offer);
                    })}
                >
                    {offer === "remove" ? <RepeatOff size={13} aria-hidden /> : <Repeat size={13} aria-hidden />}
                </button>
                <button
                    type="button"
                    className="dk-btn dk-btn-icon dt-cue-clear"
                    aria-pressed={clearing}
                    aria-label={t("decktabs.cueClearMode")}
                    title={t("decktabs.cueClearMode")}
                    {...soft(!anySet, () => toggleArm("clear"))}
                >
                    <Eraser size={13} aria-hidden />
                </button>
            </div>
            {/* Armed / no longer armed, said to screen readers as it happens (the text is the live region's content). */}
            <span role="status" className="sr-only" data-pad-status="">
                {status}
            </span>
        </div>
    );
}
export const HotCuePads = memo(HotCuePadsImpl, deckPropsEqual<DeckState, HotCuePadsProps>(["trackId", "loaded", "hotCues", "hotCueLoops", "loopActive"]));

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
    const beatsText = useBeatsText();
    const grid = useLoopGrid(deck);
    const canBeat = deck.loaded && deck.bpm > 0;
    const running = deck.loopActive ? matchLoopSize(loopBeats(grid, deck.loopStart, deck.loopEnd)) : null;
    const sizes: readonly number[] = short ? SHORT_LOOPS : mid ? MID_LOOPS : LOOP_SIZES;
    return (
        <div role="group" aria-label={t("deckui.loops")} className={cn("dt-loop-row", className)} style={{ ["--dt-n" as string]: sizes.length + (short ? 1 : 0) }}>
            {sizes.map((beats) => {
                const label = beatsLabel(beats);
                const name = beatsText("decktabs.beatLoop", label);
                return (
                    <button
                        key={beats}
                        type="button"
                        className="dk-cell"
                        aria-pressed={running === beats}
                        onClick={() => void engine.beatloop(deckId, beats)}
                        disabled={!canBeat}
                        aria-label={name}
                        title={name}
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
    const beatsText = useBeatsText();
    const grid = useLoopGrid(deck);
    const beats = loopBeats(grid, deck.loopStart, deck.loopEnd);
    const length = beats !== null ? loopLabel(beats) : fmtLoopTime(Math.max(0, deck.loopEnd - deck.loopStart));
    const noLoop = !deck.loaded || !deck.loopActive;
    // Without a grid the length is a time ("0:02.0"), not a beat count.
    const state = !deck.loopActive ? t("decktabs.loopOffState") : beats !== null ? beatsText("decktabs.loopOnState", length) : t("decktabs.loopOnTime", { n: length });
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
