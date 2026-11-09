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

const fieldStyle: React.CSSProperties = {
    background: "var(--bg-elev-2)",
    color: "var(--fg)",
    border: "1px solid var(--border)",
    borderRadius: 6,
    padding: "3px 4px",
    fontSize: 10,
    fontWeight: 700,
};

/**
 * SYNC: tap = one-shot phase sync to the master clock; long-press or
 * Shift+click / Shift+Enter = toggle continuous sync lock.
 */
function SyncButton({ deckId, deck, accent }: { deckId: DeckId; deck: DeckState; accent: string }) {
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
            style={{ padding: "6px 10px" }}
        >
            {locked ? <Link2 size={12} aria-hidden /> : <RefreshCw size={12} aria-hidden />}
            {t("deck.sync")}
            {locked && <span style={{ fontSize: 8 }}>{t("deck.syncLocked")}</span>}
        </ToggleChip>
    );
}

/**
 * Decks 1.x performance controls under the transport: SYNC / MASTER / QUANTIZE /
 * SLIP / REVERSE, beat jump and the KEY section (shift, key match, Camelot).
 */
export function DeckPerformance({ deckId, deck, accent }: { deckId: DeckId; deck: DeckState; accent: string }) {
    const t = useT();
    const id = deckId.toUpperCase();
    const perf = usePerfStore((s) => s.decks[deckId]);
    const isMaster = usePerfStore((s) => s.clock?.source === deckId);
    const masterSource = usePerfStore((s) => s.clock?.source ?? null);
    const setQuantize = usePerfStore((s) => s.setQuantize);
    const setSlip = usePerfStore((s) => s.setSlip);
    const setReverse = usePerfStore((s) => s.setReverse);
    const setJumpSize = usePerfStore((s) => s.setJumpSize);
    const beatJump = usePerfStore((s) => s.beatJump);
    const setKeyShift = usePerfStore((s) => s.setKeyShift);
    const keyMatch = usePerfStore((s) => s.keyMatch);
    const trackKey = useMixerStore((s) => s.deckKeys[deckId]);
    const masterKey = useMixerStore((s) =>
        masterSource && masterSource !== "internal" && masterSource !== deckId ? s.deckKeys[masterSource] : null,
    );

    // Keep the engine's remembered key in step with the library metadata so
    // KEY MATCH works for any deck pair.
    useEffect(() => {
        void engine.setDeckKey(deckId, trackKey ? { keyName: trackKey } : null).catch(() => undefined);
    }, [deckId, trackKey]);

    const shift = Math.round(perf.keyShift);
    const playingKey = trackKey ? (shiftCamelot(trackKey, shift) ?? trackKey) : null;
    const disabled = !deck.loaded;

    return (
        <div style={{ display: "grid", gap: 6 }}>
            <div role="group" aria-label={t("deck.perfGroup", { id })} style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center" }}>
                <SyncButton deckId={deckId} deck={deck} accent={accent} />
                <ToggleChip
                    pressed={perf.quantize}
                    accent={accent}
                    onClick={() => setQuantize(deckId, !perf.quantize)}
                    aria-label={t("deck.quantizeAria", { id })}
                    title={t("deck.quantizeHint")}
                >
                    {t("deck.quantize")}
                </ToggleChip>
                <ToggleChip
                    pressed={perf.slip}
                    accent={accent}
                    onClick={() => setSlip(deckId, !perf.slip)}
                    aria-label={t("deck.slipAria", { id })}
                    title={t("deck.slipHint")}
                >
                    {t("deck.slip")}
                </ToggleChip>
                <ToggleChip
                    pressed={perf.reverse}
                    accent={accent}
                    disabled={disabled}
                    onClick={() => setReverse(deckId, !perf.reverse)}
                    aria-label={t("deck.reverseAria", { id })}
                    title={t("deck.reverseHint")}
                >
                    {t("deck.reverse")}
                </ToggleChip>
                <span
                    role="img"
                    aria-label={t(isMaster ? "deck.masterOn" : "deck.masterOff", { id })}
                    title={t("deck.masterHint")}
                    style={{
                        marginLeft: "auto",
                        fontSize: 9,
                        fontWeight: 800,
                        letterSpacing: "0.08em",
                        padding: "3px 6px",
                        borderRadius: 6,
                        border: `1px solid ${isMaster ? accent : "var(--border)"}`,
                        color: isMaster ? "var(--fg)" : "var(--fg-dim)",
                        opacity: isMaster ? 1 : 0.5,
                    }}
                >
                    {t("deck.master")}
                </span>
            </div>

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <div role="group" aria-label={t("deck.beatJump")} style={{ display: "flex", gap: 3, alignItems: "center" }}>
                    <ToggleChip
                        size="xs"
                        disabled={disabled}
                        onClick={() => beatJump(deckId, -1)}
                        aria-label={t("deck.jumpBack", { n: perf.jumpSize })}
                    >
                        <ChevronLeft size={12} aria-hidden />
                    </ToggleChip>
                    <select
                        value={perf.jumpSize}
                        onChange={(e) => setJumpSize(deckId, Number(e.target.value))}
                        aria-label={t("deck.jumpSize")}
                        className="mono"
                        style={fieldStyle}
                    >
                        {BEAT_JUMP_SIZES.map((n) => (
                            <option key={n} value={n}>
                                {n}
                            </option>
                        ))}
                    </select>
                    <ToggleChip
                        size="xs"
                        disabled={disabled}
                        onClick={() => beatJump(deckId, 1)}
                        aria-label={t("deck.jumpForward", { n: perf.jumpSize })}
                    >
                        <ChevronRight size={12} aria-hidden />
                    </ToggleChip>
                </div>

                <div
                    role="group"
                    aria-label={t("deck.keySection")}
                    style={{ display: "flex", gap: 3, alignItems: "center", marginLeft: "auto" }}
                >
                    <span
                        className="mono"
                        title={t("deck.trackKeyHint")}
                        aria-label={playingKey ? t("deck.trackKey", { key: playingKey }) : t("deck.unknownKey")}
                        role="img"
                        style={{ fontSize: 11, fontWeight: 700, minWidth: 26, textAlign: "center" }}
                    >
                        {playingKey ?? "—"}
                    </span>
                    <ToggleChip
                        size="xs"
                        onClick={() => setKeyShift(deckId, shift - 1)}
                        disabled={shift <= -12}
                        aria-label={t("deck.keyDown")}
                    >
                        <Minus size={11} aria-hidden />
                    </ToggleChip>
                    <button
                        type="button"
                        className="mono"
                        onClick={() => setKeyShift(deckId, 0)}
                        aria-label={t("deck.keyShift", { n: formatSemitones(shift) })}
                        title={t("deck.keyReset")}
                        style={{ fontSize: 10, fontWeight: 700, minWidth: 22, borderRadius: 4 }}
                    >
                        {formatSemitones(shift)}
                    </button>
                    <ToggleChip
                        size="xs"
                        onClick={() => setKeyShift(deckId, shift + 1)}
                        disabled={shift >= 12}
                        aria-label={t("deck.keyUp")}
                    >
                        <Plus size={11} aria-hidden />
                    </ToggleChip>
                    <ToggleChip
                        size="xs"
                        disabled={disabled || isMaster}
                        onClick={() => void keyMatch(deckId, trackKey, masterKey)}
                        title={t("deck.keyMatchHint")}
                    >
                        {t("deck.keyMatch")}
                    </ToggleChip>
                </div>
            </div>
        </div>
    );
}
