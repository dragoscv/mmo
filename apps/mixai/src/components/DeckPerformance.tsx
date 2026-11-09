import { useEffect, useRef } from "react";
import { ChevronLeft, ChevronRight, Link2, Minus, Plus, RefreshCw } from "lucide-react";
import { engine } from "@/bridge/engine";
import type { DeckId, DeckState } from "@/bridge/types";
import { useMixerStore } from "@/state/mixer-store";
import { usePerfStore } from "@/state/perf-store";
import { useT } from "@/i18n";
import { BEAT_JUMP_SIZES, formatSemitones, shiftCamelot } from "@/lib/perf";
import { ToggleChip } from "./ToggleChip";

/** Hold time that turns a SYNC tap into a sync-lock toggle. */
const LONG_PRESS_MS = 450;

export const fieldStyle: React.CSSProperties = {
    background: "var(--bg-elev-2)",
    color: "var(--fg)",
    border: "1px solid var(--border)",
    borderRadius: 6,
    padding: "0 4px",
    minHeight: 24,
    fontSize: 10,
    fontWeight: 700,
};

/**
 * Track key (from the library), the master deck's key and the playing key
 * after key shift. Also keeps the engine's remembered key in step with the
 * library metadata so KEY MATCH works for any deck pair. Call it exactly once
 * per mounted deck (Deck.tsx does), whatever the tier.
 */
export function useDeckKey(deckId: DeckId) {
    const perfShift = usePerfStore((s) => s.decks[deckId].keyShift);
    const masterSource = usePerfStore((s) => s.clock?.source ?? null);
    const trackKey = useMixerStore((s) => s.deckKeys[deckId]);
    const masterKey = useMixerStore((s) =>
        masterSource && masterSource !== "internal" && masterSource !== deckId ? s.deckKeys[masterSource] : null,
    );
    useEffect(() => {
        void engine.setDeckKey(deckId, trackKey ? { keyName: trackKey } : null).catch(() => undefined);
    }, [deckId, trackKey]);
    const shift = Math.round(perfShift);
    const playingKey = trackKey ? (shiftCamelot(trackKey, shift) ?? trackKey) : null;
    return { trackKey: trackKey ?? null, masterKey: masterKey ?? null, shift, playingKey };
}

/**
 * SYNC: tap = one-shot phase sync to the master clock; long-press or
 * Shift+click / Shift+Enter = toggle continuous sync lock.
 */
export function SyncButton({ deckId, deck, accent, style }: { deckId: DeckId; deck: DeckState; accent: string; style?: React.CSSProperties }) {
    const t = useT();
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
            disabled={!deck.loaded}
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
            {locked && <span style={{ fontSize: 8 }}>{t("deck.syncLocked")}</span>}
        </ToggleChip>
    );
}

/** MASTER badge: shows (not sets) whether this deck drives the master clock. Text + border, never colour only. */
export function MasterBadge({ deckId, accent }: { deckId: DeckId; accent: string }) {
    const t = useT();
    const isMaster = usePerfStore((s) => s.clock?.source === deckId);
    return (
        <span
            role="img"
            aria-label={t(isMaster ? "deck.masterOn" : "deck.masterOff", { id: deckId.toUpperCase() })}
            title={t("deck.masterHint")}
            className="inline-flex min-h-6 shrink-0 items-center justify-center rounded-md px-1.5"
            style={{
                fontSize: 9,
                fontWeight: 800,
                letterSpacing: "0.08em",
                border: `1px ${isMaster ? "solid" : "dashed"} ${isMaster ? accent : "var(--border)"}`,
                color: isMaster ? "var(--fg)" : "var(--fg-dim)",
                opacity: isMaster ? 1 : 0.6,
            }}
        >
            {t("deck.master")}
        </span>
    );
}

/** QUANT / SLIP / REV toggles. */
export function ModeToggles({ deckId, deck, accent }: { deckId: DeckId; deck: DeckState; accent: string }) {
    const t = useT();
    const id = deckId.toUpperCase();
    const perf = usePerfStore((s) => s.decks[deckId]);
    const setQuantize = usePerfStore((s) => s.setQuantize);
    const setSlip = usePerfStore((s) => s.setSlip);
    const setReverse = usePerfStore((s) => s.setReverse);
    return (
        <>
            <ToggleChip pressed={perf.quantize} accent={accent} onClick={() => setQuantize(deckId, !perf.quantize)} aria-label={t("deck.quantizeAria", { id })} title={t("deck.quantizeHint")}>
                {t("deck.quantize")}
            </ToggleChip>
            <ToggleChip pressed={perf.slip} accent={accent} onClick={() => setSlip(deckId, !perf.slip)} aria-label={t("deck.slipAria", { id })} title={t("deck.slipHint")}>
                {t("deck.slip")}
            </ToggleChip>
            <ToggleChip
                pressed={perf.reverse}
                accent={accent}
                disabled={!deck.loaded}
                onClick={() => setReverse(deckId, !perf.reverse)}
                aria-label={t("deck.reverseAria", { id })}
                title={t("deck.reverseHint")}
            >
                {t("deck.reverse")}
            </ToggleChip>
        </>
    );
}

/** Beat jump: back / size / forward. */
export function BeatJump({ deckId, deck }: { deckId: DeckId; deck: DeckState }) {
    const t = useT();
    const jumpSize = usePerfStore((s) => s.decks[deckId].jumpSize);
    const setJumpSize = usePerfStore((s) => s.setJumpSize);
    const beatJump = usePerfStore((s) => s.beatJump);
    const disabled = !deck.loaded;
    return (
        <div role="group" aria-label={t("deck.beatJump")} className="flex min-w-0 items-center gap-0.5">
            <ToggleChip size="xs" disabled={disabled} onClick={() => beatJump(deckId, -1)} aria-label={t("deck.jumpBack", { n: jumpSize })}>
                <ChevronLeft size={12} aria-hidden />
            </ToggleChip>
            <select value={jumpSize} onChange={(e) => setJumpSize(deckId, Number(e.target.value))} aria-label={t("deck.jumpSize")} className="mono" style={fieldStyle}>
                {BEAT_JUMP_SIZES.map((n) => (
                    <option key={n} value={n}>
                        {n}
                    </option>
                ))}
            </select>
            <ToggleChip size="xs" disabled={disabled} onClick={() => beatJump(deckId, 1)} aria-label={t("deck.jumpForward", { n: jumpSize })}>
                <ChevronRight size={12} aria-hidden />
            </ToggleChip>
        </div>
    );
}

/** KEY section: playing key, shift −/reset/+, key match. */
export function KeyControls({
    deckId,
    deck,
    keyInfo,
    showKey = true,
}: {
    deckId: DeckId;
    deck: DeckState;
    keyInfo: ReturnType<typeof useDeckKey>;
    showKey?: boolean;
}) {
    const t = useT();
    const isMaster = usePerfStore((s) => s.clock?.source === deckId);
    const setKeyShift = usePerfStore((s) => s.setKeyShift);
    const keyMatch = usePerfStore((s) => s.keyMatch);
    const { shift, playingKey, trackKey, masterKey } = keyInfo;
    return (
        <div role="group" aria-label={t("deck.keySection")} className="flex min-w-0 items-center gap-0.5">
            {showKey && (
                <span
                    className="mono"
                    title={t("deck.trackKeyHint")}
                    aria-label={playingKey ? t("deck.trackKey", { key: playingKey }) : t("deck.unknownKey")}
                    role="img"
                    style={{ fontSize: 11, fontWeight: 700, minWidth: 26, textAlign: "center" }}
                >
                    {playingKey ?? "—"}
                </span>
            )}
            <ToggleChip size="xs" onClick={() => setKeyShift(deckId, shift - 1)} disabled={shift <= -12} aria-label={t("deck.keyDown")}>
                <Minus size={11} aria-hidden />
            </ToggleChip>
            <button
                type="button"
                className="mono min-h-6 min-w-6 rounded"
                onClick={() => setKeyShift(deckId, 0)}
                aria-label={t("deck.keyShift", { n: formatSemitones(shift) })}
                title={t("deck.keyReset")}
                style={{ fontSize: 10, fontWeight: 700 }}
            >
                {formatSemitones(shift)}
            </button>
            <ToggleChip size="xs" onClick={() => setKeyShift(deckId, shift + 1)} disabled={shift >= 12} aria-label={t("deck.keyUp")}>
                <Plus size={11} aria-hidden />
            </ToggleChip>
            <ToggleChip size="xs" disabled={!deck.loaded || isMaster} onClick={() => void keyMatch(deckId, trackKey, masterKey)} title={t("deck.keyMatchHint")}>
                {t("deck.keyMatch")}
            </ToggleChip>
        </div>
    );
}

/**
 * Decks 1.x performance controls (stacked form, used inside popovers of the
 * smaller tiers): SYNC / QUANT / SLIP / REV / MASTER, beat jump and KEY.
 */
export function DeckPerformance({
    deckId,
    deck,
    accent,
    keyInfo,
}: {
    deckId: DeckId;
    deck: DeckState;
    accent: string;
    keyInfo: ReturnType<typeof useDeckKey>;
}) {
    const t = useT();
    return (
        <div className="grid gap-1.5">
            <div role="group" aria-label={t("deck.perfGroup", { id: deckId.toUpperCase() })} className="flex flex-wrap items-center gap-1">
                <SyncButton deckId={deckId} deck={deck} accent={accent} />
                <ModeToggles deckId={deckId} deck={deck} accent={accent} />
                <MasterBadge deckId={deckId} accent={accent} />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
                <BeatJump deckId={deckId} deck={deck} />
                <KeyControls deckId={deckId} deck={deck} keyInfo={keyInfo} />
            </div>
        </div>
    );
}
