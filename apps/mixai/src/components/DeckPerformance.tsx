import { memo, useEffect, useMemo, useRef } from "react";
import { ChevronLeft, ChevronRight, Link2, Minus, Plus, RefreshCw } from "lucide-react";
import { cn } from "@mmo/ui";
import { engine } from "@/bridge/engine";
import type { DeckId } from "@/bridge/types";
import { useMixerStore } from "@/state/mixer-store";
import { usePerfStore } from "@/state/perf-store";
import { useT } from "@/i18n";
import { BEAT_JUMP_SIZES, formatSemitones, shiftCamelot } from "@/lib/perf";
import { KeyChip } from "./KeyChip";
import { ToggleChip } from "./ToggleChip";
import { oppositeDeck } from "./deck/format";
import { useDeckValue } from "./deck/use-deck";

/** Hold time that turns a SYNC tap into a sync-lock toggle. */
const LONG_PRESS_MS = 450;

/**
 * Track key (from the library), the master deck's key, the playing key after key shift and
 * the key the deck's chip is compared with. Also keeps the engine's remembered key in step
 * with the library metadata so KEY MATCH works for any deck pair. Call it exactly once per
 * mounted deck (Deck.tsx does), whatever the tier.
 */
export function useDeckKey(deckId: DeckId) {
    const perfShift = usePerfStore((s) => s.decks[deckId].keyShift);
    const masterSource = usePerfStore((s) => s.clock?.source ?? null);
    const trackKey = useMixerStore((s) => s.deckKeys[deckId]);
    const masterKey = useMixerStore((s) =>
        masterSource && masterSource !== "internal" && masterSource !== deckId ? s.deckKeys[masterSource] : null,
    );
    // The chip compares with the master deck when that is another deck, else with the
    // opposite deck (A↔B, C↔D); always with the key that deck is PLAYING (its shift applied).
    const other: DeckId = masterSource && masterSource !== "internal" && masterSource !== deckId ? masterSource : oppositeDeck(deckId);
    const otherKey = useMixerStore((s) => (s.deck(other).loaded ? s.deckKeys[other] : null));
    const otherShift = usePerfStore((s) => Math.round(s.decks[other].keyShift));
    useEffect(() => {
        void engine.setDeckKey(deckId, trackKey ? { keyName: trackKey } : null).catch(() => undefined);
    }, [deckId, trackKey]);
    const shift = Math.round(perfShift);
    const playingKey = trackKey ? (shiftCamelot(trackKey, shift) ?? trackKey) : null;
    const againstKey = otherKey ? (shiftCamelot(otherKey, otherShift) ?? otherKey) : null;
    // One object per set of values: the memoised controls that take it do not re-render for nothing.
    return useMemo(() => ({ trackKey: trackKey ?? null, masterKey: masterKey ?? null, shift, playingKey, againstKey }), [trackKey, masterKey, shift, playingKey, againstKey]);
}

export type DeckKeyInfo = ReturnType<typeof useDeckKey>;

/**
 * SYNC: tap = one-shot phase sync to the master clock; long-press or
 * Shift+click / Shift+Enter = toggle continuous sync lock.
 */
export const SyncButton = memo(function SyncButton({ deckId, accent, className, style }: { deckId: DeckId; accent: string; className?: string; style?: React.CSSProperties }) {
    const t = useT();
    const loaded = useDeckValue(deckId, (d) => d.loaded);
    const locked = usePerfStore((s) => s.decks[deckId].syncLock);
    const phaseSync = usePerfStore((s) => s.phaseSync);
    const setSyncLock = usePerfStore((s) => s.setSyncLock);
    const timer = useRef<number | null>(null);
    const longFired = useRef(false);

    const clear = () => {
        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = null;
    };
    useEffect(() => clear, []);

    return (
        <ToggleChip
            pressed={locked}
            accent={accent}
            disabled={!loaded}
            className={className}
            aria-label={t(locked ? "deck.syncLockedAria" : "deck.syncAria", { id: deckId.toUpperCase() })}
            title={t("deck.syncHint")}
            onPointerDown={(e) => {
                if (e.button !== 0) return;
                longFired.current = false;
                clear();
                timer.current = window.setTimeout(() => {
                    longFired.current = true;
                    setSyncLock(deckId, !usePerfStore.getState().decks[deckId].syncLock);
                }, LONG_PRESS_MS);
            }}
            onPointerUp={clear}
            onPointerLeave={clear}
            onPointerCancel={clear}
            onKeyDown={(e) => {
                if (e.shiftKey && (e.key === "Enter" || e.key === " ")) {
                    e.preventDefault();
                    e.stopPropagation();
                    setSyncLock(deckId, !locked);
                }
            }}
            onClick={(e) => {
                if (longFired.current) {
                    longFired.current = false;
                    return;
                }
                if (e.shiftKey) setSyncLock(deckId, !locked);
                else phaseSync(deckId);
            }}
            style={style}
        >
            {locked ? <Link2 size={12} aria-hidden /> : <RefreshCw size={12} aria-hidden />}
            {t("deck.sync")}
            {locked && <span className="deck-sync-lock">{t("deck.syncLocked")}</span>}
        </ToggleChip>
    );
});

/**
 * MASTER badge: shows (not sets) whether this deck drives the master clock. Never colour
 * only: the master deck gets a filled chip, the others a dashed outline, and the accessible
 * name spells it out.
 */
export const MasterBadge = memo(function MasterBadge({ deckId }: { deckId: DeckId; accent?: string }) {
    const t = useT();
    const isMaster = usePerfStore((s) => s.clock?.source === deckId);
    return (
        <span
            role="img"
            aria-label={t(isMaster ? "deck.masterOn" : "deck.masterOff", { id: deckId.toUpperCase() })}
            title={t("deck.masterHint")}
            className="deck-master"
            data-on={isMaster ? "true" : "false"}
        >
            {t("deck.master")}
        </span>
    );
});

/**
 * QUANT / SLIP / REV toggles. QUANT is a setting (ON = the accent); SLIP and REV change what
 * the transport plays, so their ON state is the deck colour, like PLAY.
 */
export const ModeToggles = memo(function ModeToggles({ deckId, accent, className }: { deckId: DeckId; accent: string; className?: string }) {
    const t = useT();
    const loaded = useDeckValue(deckId, (d) => d.loaded);
    const id = deckId.toUpperCase();
    const perf = usePerfStore((s) => s.decks[deckId]);
    const setQuantize = usePerfStore((s) => s.setQuantize);
    const setSlip = usePerfStore((s) => s.setSlip);
    const setReverse = usePerfStore((s) => s.setReverse);
    return (
        <>
            <ToggleChip
                pressed={perf.quantize}
                accent={accent}
                className={className}
                onClick={() => setQuantize(deckId, !perf.quantize)}
                aria-label={t("deck.quantizeAria", { id })}
                title={t("deck.quantizeHint")}
            >
                {t("deck.quantize")}
            </ToggleChip>
            <ToggleChip
                pressed={perf.slip}
                accent={accent}
                className={className}
                data-tone="deck"
                onClick={() => setSlip(deckId, !perf.slip)}
                aria-label={t("deck.slipAria", { id })}
                title={t("deck.slipHint")}
            >
                {t("deck.slip")}
            </ToggleChip>
            <ToggleChip
                pressed={perf.reverse}
                accent={accent}
                className={className}
                data-tone="deck"
                disabled={!loaded}
                onClick={() => setReverse(deckId, !perf.reverse)}
                aria-label={t("deck.reverseAria", { id })}
                title={t("deck.reverseHint")}
            >
                {t("deck.reverse")}
            </ToggleChip>
        </>
    );
});

/**
 * Beat jump: back / size / forward. `cells` shows every size as a cell (the chosen one
 * outlined); the default is a compact size picker between the two arrows.
 */
export const BeatJump = memo(function BeatJump({ deckId, cells = false, label = false }: { deckId: DeckId; cells?: boolean; label?: boolean }) {
    const t = useT();
    const loaded = useDeckValue(deckId, (d) => d.loaded);
    const jumpSize = usePerfStore((s) => s.decks[deckId].jumpSize);
    const setJumpSize = usePerfStore((s) => s.setJumpSize);
    const beatJump = usePerfStore((s) => s.beatJump);
    const disabled = !loaded;
    return (
        <div role="group" aria-label={t("deck.beatJump")} className="deck-group">
            {label && (
                <span aria-hidden className="dk-label">
                    {t("deckui.jumpLabel")}
                </span>
            )}
            <button type="button" className="dk-cell deck-cell-btn" disabled={disabled} onClick={() => beatJump(deckId, -1)} aria-label={t("deck.jumpBack", { n: jumpSize })}>
                <ChevronLeft size={13} aria-hidden />
            </button>
            {cells ? (
                BEAT_JUMP_SIZES.map((n) => (
                    <button
                        key={n}
                        type="button"
                        className="dk-cell deck-cell-btn"
                        aria-pressed={jumpSize === n}
                        aria-label={t("deckui.jumpSizeN", { n })}
                        onClick={() => setJumpSize(deckId, n)}
                    >
                        {n}
                    </button>
                ))
            ) : (
                <select value={jumpSize} onChange={(e) => setJumpSize(deckId, Number(e.target.value))} aria-label={t("deck.jumpSize")} className="dk-cell deck-select">
                    {BEAT_JUMP_SIZES.map((n) => (
                        <option key={n} value={n}>
                            {n}
                        </option>
                    ))}
                </select>
            )}
            <button type="button" className="dk-cell deck-cell-btn" disabled={disabled} onClick={() => beatJump(deckId, 1)} aria-label={t("deck.jumpForward", { n: jumpSize })}>
                <ChevronRight size={13} aria-hidden />
            </button>
        </div>
    );
});

/** KEY section: playing key (optional), shift − / reset / +, key match. */
export const KeyControls = memo(function KeyControls({
    deckId,
    keyInfo,
    showKey = true,
    label = false,
}: {
    deckId: DeckId;
    keyInfo: DeckKeyInfo;
    showKey?: boolean;
    label?: boolean;
}) {
    const t = useT();
    const loaded = useDeckValue(deckId, (d) => d.loaded);
    const isMaster = usePerfStore((s) => s.clock?.source === deckId);
    const setKeyShift = usePerfStore((s) => s.setKeyShift);
    const keyMatch = usePerfStore((s) => s.keyMatch);
    const { shift, playingKey, trackKey, masterKey, againstKey } = keyInfo;
    return (
        <div role="group" aria-label={t("deck.keySection")} className="deck-group">
            {label && (
                <span aria-hidden className="dk-label">
                    {t("deck.key")}
                </span>
            )}
            {showKey && <KeyChip keyName={playingKey} against={againstKey} />}
            <button type="button" className="dk-cell deck-cell-btn" onClick={() => setKeyShift(deckId, shift - 1)} disabled={shift <= -12} aria-label={t("deck.keyDown")}>
                <Minus size={12} aria-hidden />
            </button>
            <button
                type="button"
                className="dk-cell deck-cell-btn deck-cell-value"
                data-on={shift !== 0 ? "true" : undefined}
                onClick={() => setKeyShift(deckId, 0)}
                aria-label={t("deck.keyShift", { n: formatSemitones(shift) })}
                title={t("deck.keyReset")}
            >
                {formatSemitones(shift)}
            </button>
            <button type="button" className="dk-cell deck-cell-btn" onClick={() => setKeyShift(deckId, shift + 1)} disabled={shift >= 12} aria-label={t("deck.keyUp")}>
                <Plus size={12} aria-hidden />
            </button>
            <ToggleChip size="xs" className="deck-match" disabled={!loaded || isMaster} onClick={() => void keyMatch(deckId, trackKey, masterKey)} title={t("deck.keyMatchHint")}>
                {t("deck.keyMatch")}
            </ToggleChip>
        </div>
    );
});

/**
 * Decks 1.x performance controls (stacked form, used inside popovers of the smaller tiers):
 * SYNC / QUANT / SLIP / REV / MASTER, beat jump and KEY.
 */
export function DeckPerformance({
    deckId,
    accent,
    keyInfo,
    className,
}: {
    deckId: DeckId;
    accent: string;
    keyInfo: DeckKeyInfo;
    className?: string;
}) {
    const t = useT();
    return (
        <div className={cn("deck-perf", className)}>
            <div role="group" aria-label={t("deck.perfGroup", { id: deckId.toUpperCase() })} className="deck-perf-row">
                <SyncButton deckId={deckId} accent={accent} />
                <ModeToggles deckId={deckId} accent={accent} />
                <MasterBadge deckId={deckId} />
            </div>
            <BeatJump deckId={deckId} cells label />
            <KeyControls deckId={deckId} keyInfo={keyInfo} label />
        </div>
    );
}
