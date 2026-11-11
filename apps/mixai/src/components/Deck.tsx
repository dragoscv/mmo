import { memo, useId, useMemo } from "react";
import { motion } from "motion/react";
import { AlertTriangle, Grid3x3, Layers, Lock, LockOpen, Minus, Pause, Play, Plus, Repeat, RotateCcw, SlidersHorizontal, Sparkles, Target } from "lucide-react";
import { cn } from "@mmo/ui";
import { engine } from "@/bridge/engine";
import type { DeckId, DeckState } from "@/bridge/types";
import { useMixerStore } from "@/state/mixer-store";
import { usePerfStore } from "@/state/perf-store";
import { usePanelTier } from "@/layout/panel-tier";
import { useT } from "@/i18n";
import { remainWarn, remainingSec, splitTime, type RemainWarn } from "@/lib/deck-time";
import { useClockPoll } from "@/lib/use-clock-poll";
import { usePlatter } from "@/look/look";
import { useShellPrefs } from "@/shell/shell-prefs";
import { Waveform } from "./Waveform";
import { BeatJump, DeckPerformance, KeyControls, MasterBadge, ModeToggles, SyncButton, useDeckKey, type DeckKeyInfo } from "./DeckPerformance";
import { DeckTabBody } from "./DeckTabBody";
import { KeyChip } from "./KeyChip";
import { MorePopover, iconBtn, tierLayout, useElementSize, useMotionOK } from "./panel-ui";
import { cuePointFor, useDeckUi, type DeckTab } from "./deck-ui-store";
import {
    PLATTER_DEG_PER_SEC,
    TEMPO_MAX,
    TEMPO_MIN,
    TEMPO_STEP,
    WIDE_MIN_W,
    clampTempo,
    deckArrangement,
    formatClock,
    formatTempo,
    playingBpm,
    progressOf,
    splitBpm,
    tempoPosition,
    tempoShifted,
} from "./deck/format";
import { deckNow, useDeckSteady, useDeckValue } from "./deck/use-deck";

/** The main cue counts as "at the cue point" within this many seconds. */
const AT_CUE_SEC = 0.02;

/*
 * Render cost. A playing deck gets a new snapshot ~30 times a second (position, vu). Nothing
 * here selects the whole deck: the root and every control select the few values they show
 * (`useDeckValue`), so only the time readouts (and the optional platter) render while a track
 * plays, at the rate their TEXT changes (tenths of a second). Handlers read the deck when they
 * fire (`deckNow`), so they need no fresh props either.
 */

/* ── actions (read the state at the moment they fire) ──────────────────── */

function patchDeck(deckId: DeckId, patch: Partial<DeckState>): void {
    useMixerStore.getState().patchDeck(deckId, patch);
}

function togglePlay(deckId: DeckId): void {
    const next = !deckNow(deckId).playing;
    patchDeck(deckId, { playing: next });
    if (next) void engine.play(deckId);
    else void engine.pause(deckId);
}

// CDJ-style CUE: while playing → stop and return to the cue point; while
// paused → store the current position as the cue point (Shift: return).
function cueAction(deckId: DeckId, shift: boolean): void {
    const deck = deckNow(deckId);
    if (!deck.loaded) return;
    const ui = useDeckUi.getState();
    // The cue point of THIS track (start of the track until one is set), never past its end.
    const cuePoint = cuePointFor(ui, deckId, deck.trackId, deck.duration);
    if (deck.playing || shift) {
        if (deck.playing) {
            patchDeck(deckId, { playing: false });
            void engine.pause(deckId);
        }
        patchDeck(deckId, { position: cuePoint });
        void engine.seek(deckId, cuePoint);
    } else {
        ui.setCuePoint(deckId, deck.position, deck.trackId);
    }
}

function setTempo(deckId: DeckId, v: number): void {
    const next = clampTempo(v);
    patchDeck(deckId, { tempo: next });
    void engine.setTempo(deckId, next);
}

function toggleKeyLock(deckId: DeckId): void {
    const next = !deckNow(deckId).keyLock;
    patchDeck(deckId, { keyLock: next });
    void engine.setKeyLock(deckId, next);
}

type Lay = ReturnType<typeof tierLayout>;

interface DeckProps {
    deckId: DeckId;
}

/** What every tier needs from the root. All of it changes rarely (never at snapshot rate). */
interface TierProps extends DeckProps {
    /** The deck colour as a CSS value (`var(--deck-a)`). */
    accent: string;
    keyInfo: DeckKeyInfo;
    warn: RemainWarn;
    lay: Lay;
}

/**
 * One deck, rendered for the tier the layout solver gave it (full / compact / icon). The root
 * always fills its box and never scrolls: every row has a fixed height and only the tab body
 * flexes (row budget: deck.css). Controls a smaller tier hides stay reachable through popovers.
 * Touch mode (44 px targets) steps down to a smaller arrangement when the box is too low for
 * the tier's rows (`deckArrangement`).
 */
export function Deck({ deckId }: DeckProps) {
    const t = useT();
    const tier = usePanelTier();
    const motionOK = useMotionOK();
    // Master badge, sync-lock state and the playing tempo come from the engine clock.
    useClockPoll();
    const playing = useDeckValue(deckId, (d) => d.playing);
    const warn = useDeckValue(deckId, remainWarn);
    const keyInfo = useDeckKey(deckId);
    const platter = usePlatter();
    // Touch mode makes every target 44 px: the wide arrangement (a cell per jump size) cannot fit.
    const touch = useShellPrefs((s) => s.touch);
    const [rootRef, size] = useElementSize<HTMLElement>();

    // Deck colours are fixed per deck (D9) and never follow the theme accent.
    const accent = `var(--deck-${deckId})`;
    const id = deckId.toUpperCase();
    const lay = useMemo(() => tierLayout(motionOK, tier, `deck-${deckId}`), [motionOK, tier, deckId]);
    const arrangement = deckArrangement(tier, touch, size.h);
    const common: TierProps = { deckId, accent, keyInfo, warn, lay };

    return (
        <section
            ref={rootRef}
            aria-label={t("deck.title", { id })}
            className="panel deck-card deck-tier h-full w-full min-h-0 min-w-0 overflow-hidden"
            data-playing={playing ? "true" : "false"}
            data-tier={tier}
            data-arrangement={arrangement}
            data-warn={warn === "none" ? undefined : warn}
            style={{ ["--deck" as string]: accent }}
        >
            {arrangement === "full" && <DeckFull {...common} wide={size.w >= WIDE_MIN_W && !touch} platter={platter} motionOK={motionOK} />}
            {(arrangement === "compact" || arrangement === "bare") && <DeckCompact {...common} bare={arrangement === "bare"} />}
            {arrangement === "icon" && <DeckIcon {...common} touch={touch} />}
            {/* Said once when the warning starts: the text stays the same while it lasts. */}
            <span className="sr-only" aria-live="polite">
                {warn === "none" ? "" : t("deckui.endingAnnounce", { id })}
            </span>
        </section>
    );
}

/* ── shared pieces ─────────────────────────────────────────────────────── */

function DeckBadge({ deckId }: DeckProps) {
    return (
        <span aria-hidden className="deck-badge">
            {deckId.toUpperCase()}
        </span>
    );
}

const DeckTitle = memo(function DeckTitle({ deckId, withArtist = false }: DeckProps & { withArtist?: boolean }) {
    const t = useT();
    const title = useDeckValue(deckId, (d) => d.title);
    const artist = useDeckValue(deckId, (d) => d.artist);
    const full = withArtist ? [title, artist].filter(Boolean).join(" \u2014 ") : (title ?? "");
    return (
        <span className="deck-title" data-empty={title ? undefined : "true"} title={full || undefined}>
            {title ?? t("deck.noTrack")}
        </span>
    );
});

const DeckArtist = memo(function DeckArtist({ deckId }: DeckProps) {
    const artist = useDeckValue(deckId, (d) => d.artist);
    return (
        <span className="deck-artist" title={artist ?? undefined}>
            {artist ?? ""}
        </span>
    );
});

/** BPM in two sizes ("129" + ".20") in the deck colour. */
const BpmValue = memo(function BpmValue({ deckId, className }: DeckProps & { className: string }) {
    // Two decimals: the readout shows no more, and a steadier value means fewer renders.
    const clockBpm = usePerfStore((s) => {
        const d = s.clock?.decks.find((x) => x.id === deckId);
        return d && d.bpm > 0 ? Math.round(d.bpm * 100) / 100 : null;
    });
    // Grid tempo × fader; 0 = no track or no grid (then the clock's figure does not count either).
    const own = useDeckValue(deckId, (d) => playingBpm(d, null));
    const bpm = splitBpm(own > 0 && clockBpm !== null ? clockBpm : own);
    return (
        <span className={cn("dk-num deck-bpm", className)}>
            {bpm ? (
                <>
                    {bpm.main}
                    <span className="dk-num-frac">.{bpm.frac}</span>
                </>
            ) : (
                "---"
            )}
        </span>
    );
});

/** "03:12.4" (or "03:12" without tenths); null = no track. A string, so it compares by value. */
function clockText(sec: number, tenths: boolean): string {
    const s = splitTime(sec);
    return tenths ? `${s.main}.${s.frac}` : s.main;
}

/** Remaining time ("−03:12.4"); `tenths` off = whole seconds (smaller tiers). */
const RemainValue = memo(function RemainValue({ deckId, className, tenths = true }: DeckProps & { className: string; tenths?: boolean }) {
    // Renders when the TEXT changes (10 times a second with tenths, once without), not per snapshot.
    const text = useDeckValue(deckId, (d) => (d.loaded ? clockText(remainingSec(d), tenths) : null));
    const warn = useDeckValue(deckId, remainWarn);
    if (text === null) return <span className={cn("dk-num deck-dim", className)}>--:--</span>;
    const [main, frac] = text.split(".");
    return (
        <span className={cn("dk-num dk-time", className)} data-warn={warn === "none" ? undefined : warn}>
            {"\u2212"}
            {main}
            {frac !== undefined && <span className="dk-num-frac">.{frac}</span>}
        </span>
    );
});

const ElapsedValue = memo(function ElapsedValue({ deckId }: DeckProps) {
    const text = useDeckValue(deckId, (d) => (d.loaded ? clockText(d.position, true) : null));
    if (text === null) return <span className="dk-num dk-num-sm deck-dim">--:--</span>;
    const [main, frac] = text.split(".");
    return (
        <span className="dk-num dk-num-sm deck-dim">
            {main}
            <span className="dk-num-frac">.{frac}</span>
        </span>
    );
});

const TempoPercent = memo(function TempoPercent({ deckId }: DeckProps) {
    const text = useDeckValue(deckId, (d) => formatTempo(d.tempo));
    const shifted = useDeckValue(deckId, (d) => tempoShifted(d.tempo));
    return <span className={cn("dk-num dk-num-md", !shifted && "deck-dim")}>{text}</span>;
});

/**
 * End-of-track chip (icon + word) of the full tier's title row. It sits where the artist name
 * gives way, so the readouts under it never move when the warning starts.
 */
function EndingChip() {
    const t = useT();
    return (
        <span aria-hidden className="dk-label deck-ending">
            <AlertTriangle size={10} aria-hidden />
            {t("deckui.ending")}
        </span>
    );
}

/** Header row 2 of the full tier: BPM, tempo %, remaining (primary) and elapsed time. */
const Readouts = memo(function Readouts({ deckId }: DeckProps) {
    const t = useT();
    return (
        <div role="group" aria-label={t("deckui.readoutsAria", { id: deckId.toUpperCase() })} className="deck-readouts">
            <span className="deck-readout" data-kind="bpm" title={t("deckui.bpmHint")}>
                <span aria-hidden className="dk-label">
                    {t("deckui.readBpm")}
                </span>
                <BpmValue deckId={deckId} className="dk-num-xl" />
                <span className="sr-only">{t("deckui.readBpm")}</span>
            </span>
            <span className="deck-readout" data-kind="tempo" title={t("deckui.tempoPctHint")}>
                <span aria-hidden className="dk-label">
                    {t("deck.tempo")}
                </span>
                <span className="sr-only">{t("deck.tempo")}</span>
                <TempoPercent deckId={deckId} />
            </span>
            <span className="deck-readout" data-kind="remain" title={t("deckui.remainHint")}>
                <span aria-hidden className="dk-label">
                    {t("deckui.readRemain")}
                </span>
                <span className="sr-only">{t("deckui.readRemain")}</span>
                <RemainValue deckId={deckId} className="dk-num-lg" />
            </span>
            <span className="deck-readout" data-kind="elapsed" title={t("deckui.elapsedHint")}>
                <span aria-hidden className="dk-label">
                    {t("deckui.readElapsed")}
                </span>
                <span className="sr-only">{t("deckui.readElapsed")}</span>
                <ElapsedValue deckId={deckId} />
            </span>
        </div>
    );
});

/** BPM + remaining on one line (compact header, icon tier). */
const MiniReadouts = memo(function MiniReadouts({ deckId, warn, className }: DeckProps & { warn: RemainWarn; className?: string }) {
    const t = useT();
    return (
        <span className={cn("deck-mini", className)}>
            <span title={t("deckui.bpmHint")}>
                <BpmValue deckId={deckId} className="deck-num-c" />
                <span className="sr-only">{t("deckui.readBpm")}</span>
            </span>
            {warn !== "none" && <AlertTriangle size={12} aria-hidden className="deck-warn-icon" />}
            <span title={t("deckui.remainHint")}>
                <span className="sr-only">{t("deckui.readRemain")}</span>
                <RemainValue deckId={deckId} className="deck-num-c" tenths={false} />
            </span>
        </span>
    );
});

/**
 * Optional virtual platter: the rim fills with the track progress and the marker turns at
 * 33⅓ rpm with the playhead. Decorative (the readouts carry the same information). With
 * reduced motion the marker does not spin: it points at the track progress instead.
 * (The one piece besides the time readouts that follows the position: it is its own leaf.)
 */
const Platter = memo(function Platter({ deckId, motionOK }: DeckProps & { motionOK: boolean }) {
    const position = useDeckValue(deckId, (d) => d.position);
    const duration = useDeckValue(deckId, (d) => d.duration);
    const playing = useDeckValue(deckId, (d) => d.playing);
    const progress = progressOf({ position, duration });
    // Not wrapped to 0..360: the marker must never unwind a full turn through the transition.
    const angle = motionOK ? position * PLATTER_DEG_PER_SEC : progress * 360;
    return (
        <span aria-hidden className="deck-platter" data-spin={playing && motionOK ? "true" : "false"}>
            <svg viewBox="0 0 100 100" focusable="false">
                <circle className="deck-platter-rim" cx="50" cy="50" r="46" />
                <circle className="deck-platter-arc" cx="50" cy="50" r="46" pathLength={100} strokeDasharray={`${(Math.round(progress * 1000) / 10).toFixed(1)} 100`} transform="rotate(-90 50 50)" />
            </svg>
            <span className="deck-platter-arm" style={{ transform: `rotate(${angle.toFixed(1)}deg)` }} />
            <span className="deck-platter-hub" />
        </span>
    );
});

const PlayButton = memo(function PlayButton({ deckId, iconSize = 14 }: DeckProps & { iconSize?: number }) {
    const t = useT();
    const loaded = useDeckValue(deckId, (d) => d.loaded);
    const playing = useDeckValue(deckId, (d) => d.playing);
    return (
        <button
            type="button"
            onClick={() => togglePlay(deckId)}
            disabled={!loaded}
            data-on={playing ? "true" : "false"}
            aria-label={t(playing ? "deck.pauseAria" : "deck.playAria", { id: deckId.toUpperCase() })}
            className="dk-btn dk-btn-play deck-play"
        >
            {playing ? <Pause size={iconSize} aria-hidden /> : <Play size={iconSize} aria-hidden />}
            <span className="deck-play-label">{playing ? t("deck.pause") : t("deck.play")}</span>
        </button>
    );
});

const CueButton = memo(function CueButton({ deckId }: DeckProps) {
    const t = useT();
    const loaded = useDeckValue(deckId, (d) => d.loaded);
    const trackId = useDeckValue(deckId, (d) => d.trackId);
    const duration = useDeckValue(deckId, (d) => d.duration);
    const cuePoint = useDeckUi((s) => cuePointFor(s, deckId, trackId, duration));
    // Paused exactly on the main cue point = CUE is lit.
    const atCue = useDeckValue(deckId, (d) => d.loaded && !d.playing && Math.abs(d.position - cuePoint) < AT_CUE_SEC);
    return (
        <button
            type="button"
            onClick={(e) => cueAction(deckId, e.shiftKey)}
            disabled={!loaded}
            data-on={atCue ? "true" : "false"}
            aria-label={t("deckui.cueAria", { id: deckId.toUpperCase() })}
            title={t("deckui.cueHint")}
            className="dk-btn dk-btn-cue deck-cue"
        >
            {t("deckui.cue")}
        </button>
    );
});

const KeyLockButton = memo(function KeyLockButton({ deckId }: DeckProps) {
    const t = useT();
    const on = useDeckValue(deckId, (d) => d.keyLock);
    return (
        <button type="button" onClick={() => toggleKeyLock(deckId)} aria-pressed={on} aria-label={t("deck.keyLockAria", { id: deckId.toUpperCase() })} title={t("deck.keyLockHint")} className="dk-btn">
            {on ? <Lock size={12} aria-hidden /> : <LockOpen size={12} aria-hidden />}
            {t("deck.key")}
        </button>
    );
});

/**
 * Tempo: −  [flat fader with a centre detent]  +  and a reset. Drag or arrow keys on the
 * fader, 0.1 % per nudge, double click (or the reset control) returns to the original tempo.
 * `showValue` puts the value on the reset control (tiers whose header has no tempo readout).
 *
 * It selects the tempo only. That matters beyond the render cost: React rewrites the `name` and
 * `type` attributes of an <input> on every commit that re-renders it, so a fader that rendered
 * with each snapshot had its attributes rewritten ~30 times a second with unchanged values.
 */
const TempoFader = memo(function TempoFader({ deckId, label = false, showValue = false }: DeckProps & { label?: boolean; showValue?: boolean }) {
    const t = useT();
    const tempo = useDeckValue(deckId, (d) => d.tempo);
    const text = formatTempo(tempo);
    const aria = t("deck.tempoAria", { id: deckId.toUpperCase() });
    return (
        <div role="group" aria-label={aria} className="deck-tempo">
            {label && (
                <span aria-hidden className="dk-label">
                    {t("deck.tempo")}
                </span>
            )}
            <button type="button" className="dk-cell deck-cell-btn" aria-label={t("deckui.tempoDown")} onClick={() => setTempo(deckId, deckNow(deckId).tempo - TEMPO_STEP)} disabled={tempo <= TEMPO_MIN}>
                <Minus size={12} aria-hidden />
            </button>
            <span className="deck-tempo-track" style={{ ["--p" as string]: tempoPosition(tempo).toFixed(4) }}>
                <span aria-hidden className="deck-tempo-fill" />
                <input
                    type="range"
                    className="deck-tempo-range"
                    min={TEMPO_MIN}
                    max={TEMPO_MAX}
                    step={TEMPO_STEP}
                    value={tempo}
                    aria-label={aria}
                    aria-valuetext={text}
                    title={t("deckui.tempoHint")}
                    onChange={(e) => setTempo(deckId, Number(e.target.value))}
                    onDoubleClick={() => setTempo(deckId, 1)}
                />
            </span>
            <button type="button" className="dk-cell deck-cell-btn" aria-label={t("deckui.tempoUp")} onClick={() => setTempo(deckId, deckNow(deckId).tempo + TEMPO_STEP)} disabled={tempo >= TEMPO_MAX}>
                <Plus size={12} aria-hidden />
            </button>
            <button
                type="button"
                className={cn("dk-cell deck-cell-btn", showValue && "deck-cell-tempo")}
                aria-label={t("deckui.tempoReset", { value: text })}
                title={t("deckui.tempoResetHint")}
                onClick={() => setTempo(deckId, 1)}
                disabled={!showValue && !tempoShifted(tempo)}
            >
                {showValue ? text : <RotateCcw size={12} aria-hidden />}
            </button>
        </div>
    );
});

/** −  +1.2%  +  : tempo as a small numeric control (compact tier). Activating the value resets to 0 %. */
const TempoStepper = memo(function TempoStepper({ deckId }: DeckProps) {
    const t = useT();
    const tempo = useDeckValue(deckId, (d) => d.tempo);
    const text = formatTempo(tempo);
    return (
        <div role="group" aria-label={t("deck.tempoAria", { id: deckId.toUpperCase() })} className="deck-group">
            <button type="button" className="dk-cell deck-cell-btn" aria-label={t("deckui.tempoDown")} onClick={() => setTempo(deckId, deckNow(deckId).tempo - TEMPO_STEP)} disabled={tempo <= TEMPO_MIN}>
                <Minus size={12} aria-hidden />
            </button>
            <button type="button" className="dk-cell deck-cell-btn deck-cell-tempo" aria-label={t("deckui.tempoReset", { value: text })} title={t("deckui.tempoResetHint")} onClick={() => setTempo(deckId, 1)}>
                {text}
            </button>
            <button type="button" className="dk-cell deck-cell-btn" aria-label={t("deckui.tempoUp")} onClick={() => setTempo(deckId, deckNow(deckId).tempo + TEMPO_STEP)} disabled={tempo >= TEMPO_MAX}>
                <Plus size={12} aria-hidden />
            </button>
        </div>
    );
});

/**
 * Deck fields no tab body shows: the body keeps its deck object while only these change. The grid
 * editor reads the playhead in its handlers and selects its BPM text itself, so it is no exception.
 */
const BODY_IGNORES = ["position", "vu"] as const;

const TabBody = memo(function TabBody({ deckId, accent, tab, compact }: DeckProps & { accent: string; tab: DeckTab; compact?: boolean }) {
    const deck = useDeckSteady(deckId, BODY_IGNORES);
    return <DeckTabBody deckId={deckId} deck={deck} accent={accent} tab={tab} compact={compact} />;
});

const TABS: readonly {
    tab: DeckTab;
    label: "deckui.tabCues" | "deckui.tabLoops" | "deckui.tabFx" | "deckui.tabStems" | "deckui.tabGrid";
    Icon: typeof Target;
}[] = [
    { tab: "cues", label: "deckui.tabCues", Icon: Target },
    { tab: "loops", label: "deckui.tabLoops", Icon: Repeat },
    { tab: "fx", label: "deckui.tabFx", Icon: Sparkles },
    { tab: "stems", label: "deckui.tabStems", Icon: Layers },
    { tab: "grid", label: "deckui.tabGrid", Icon: Grid3x3 },
];

/**
 * Lower area: HOT CUE · LOOP · FX · STEMS · GRID as a tab list (arrow keys, Home, End move
 * and select) and the selected tab's body. Renders two rows of the caller's grid.
 */
const DeckTabs = memo(function DeckTabs({ deckId, accent, lay }: DeckProps & { accent: string; lay?: Lay }) {
    const t = useT();
    const base = useId();
    const tab = useDeckUi((s) => s.tab[deckId]);
    const setTab = useDeckUi((s) => s.setTab);
    const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        const at = TABS.findIndex((x) => x.tab === tab);
        const next =
            e.key === "ArrowRight" ? (at + 1) % TABS.length : e.key === "ArrowLeft" ? (at - 1 + TABS.length) % TABS.length : e.key === "Home" ? 0 : e.key === "End" ? TABS.length - 1 : -1;
        if (next < 0) return;
        e.preventDefault();
        e.stopPropagation();
        const target = TABS[next]!.tab;
        setTab(deckId, target);
        e.currentTarget.querySelector<HTMLElement>(`[data-tab="${target}"]`)?.focus();
    };
    return (
        <>
            <div role="tablist" aria-label={t("deckui.tabsAria", { id: deckId.toUpperCase() })} className="deck-tabs deck-row" onKeyDown={onKeyDown}>
                {TABS.map(({ tab: v, label }) => (
                    <button
                        key={v}
                        type="button"
                        role="tab"
                        id={`${base}-${v}`}
                        data-tab={v}
                        aria-selected={tab === v}
                        aria-controls={`${base}-panel`}
                        tabIndex={tab === v ? 0 : -1}
                        className="dk-tab"
                        onClick={() => setTab(deckId, v)}
                    >
                        {t(label)}
                    </button>
                ))}
            </div>
            <motion.div {...(lay ? lay("lower") : {})} role="tabpanel" id={`${base}-panel`} aria-labelledby={`${base}-${tab}`} className="deck-tabbody deck-row">
                <TabBody deckId={deckId} accent={accent} tab={tab} />
            </motion.div>
        </>
    );
});

/** Everything a smaller tier hides, in one popover body (it carries the deck colour itself). */
function DeckMoreBody({ deckId, accent, keyInfo, withTabs, withWave }: DeckProps & { accent: string; keyInfo: DeckKeyInfo; withTabs?: boolean; withWave?: boolean }) {
    return (
        <div className="deck-more" data-deck-scope="" style={{ ["--deck" as string]: accent }}>
            {withWave && (
                <div className="deck-more-wave">
                    <Waveform deckId={deckId} accent={accent} />
                </div>
            )}
            <DeckPerformance deckId={deckId} accent={accent} keyInfo={keyInfo} />
            <div className="deck-more-row">
                <KeyLockButton deckId={deckId} />
                <TempoFader deckId={deckId} showValue />
            </div>
            {withTabs && (
                <div className="deck-more-tabs">
                    <DeckTabs deckId={deckId} accent={accent} />
                </div>
            )}
        </div>
    );
}

/** A tab body inside a popover (compact tier: FX, stems, grid; touch mode on a low deck: every tab). */
function TabPopover({ deckId, accent, tab, label, icon }: DeckProps & { accent: string; tab: DeckTab; label: string; icon: React.ReactNode }) {
    return (
        <MorePopover label={label} icon={icon} side="top">
            <div className="deck-pop" data-tab={tab} data-deck-scope="" style={{ ["--deck" as string]: accent }}>
                <div className="deck-tabbody">
                    <TabBody deckId={deckId} accent={accent} tab={tab} />
                </div>
            </div>
        </MorePopover>
    );
}

/* ── tiers ─────────────────────────────────────────────────────────────── */

function DeckFull({ deckId, accent, keyInfo, warn, lay, wide, platter, motionOK }: TierProps & { wide: boolean; platter: boolean; motionOK: boolean }) {
    const t = useT();
    return (
        <div className="deck-full">
            <motion.header {...lay("header")} className="deck-head deck-row" data-platter={platter ? "true" : undefined}>
                {platter && <Platter deckId={deckId} motionOK={motionOK} />}
                <div className="deck-head-top">
                    <DeckBadge deckId={deckId} />
                    <DeckTitle deckId={deckId} />
                    <DeckArtist deckId={deckId} />
                    {warn !== "none" && <EndingChip />}
                    <KeyChip keyName={keyInfo.playingKey} against={keyInfo.againstKey} />
                    <MasterBadge deckId={deckId} />
                </div>
                <Readouts deckId={deckId} />
            </motion.header>

            <motion.div {...lay("wave")} className="deck-row">
                <Waveform deckId={deckId} accent={accent} />
            </motion.div>

            <motion.div {...lay("transport")} role="group" aria-label={t("deck.perfGroup", { id: deckId.toUpperCase() })} className="deck-transport deck-row">
                <CueButton deckId={deckId} />
                <PlayButton deckId={deckId} />
                <SyncButton deckId={deckId} accent={accent} />
                <ModeToggles deckId={deckId} accent={accent} />
                <KeyLockButton deckId={deckId} />
                <span aria-hidden className="deck-spacer" />
                {wide && <KeyControls deckId={deckId} keyInfo={keyInfo} showKey={false} />}
            </motion.div>

            <div className="deck-util deck-row">
                <BeatJump deckId={deckId} cells={wide} label={wide} />
                {!wide && <KeyControls deckId={deckId} keyInfo={keyInfo} showKey={false} />}
                <TempoFader deckId={deckId} label={wide} />
            </div>

            <DeckTabs deckId={deckId} accent={accent} lay={lay} />
        </div>
    );
}

/**
 * Compact arrangement. `bare` (touch mode on a deck too low for a 44 px tab body): the lower
 * area is gone, every tab opens as a popover from the tab row and the overview takes the space.
 */
function DeckCompact({ deckId, accent, keyInfo, warn, lay, bare }: TierProps & { bare: boolean }) {
    const t = useT();
    const id = deckId.toUpperCase();
    const tab = useDeckUi((s) => s.tab[deckId]);
    const setTab = useDeckUi((s) => s.setTab);
    const inlineTab: DeckTab = tab === "loops" ? "loops" : "cues";
    return (
        <div className="deck-compact" data-bare={bare ? "true" : undefined}>
            <motion.header {...lay("header")} className="deck-chead deck-row">
                <DeckBadge deckId={deckId} />
                <DeckTitle deckId={deckId} withArtist />
                <KeyChip keyName={keyInfo.playingKey} against={keyInfo.againstKey} />
                <MiniReadouts deckId={deckId} warn={warn} />
            </motion.header>

            <motion.div {...lay("wave")} className="deck-row">
                <Waveform deckId={deckId} accent={accent} />
            </motion.div>

            <motion.div {...lay("transport")} role="group" aria-label={t("deck.perfGroup", { id })} className="deck-transport deck-row">
                <CueButton deckId={deckId} />
                <PlayButton deckId={deckId} />
                <SyncButton deckId={deckId} accent={accent} />
                <TempoStepper deckId={deckId} />
                <MorePopover label={t("deckui.moreDeck", { id })} className="deck-more-btn">
                    <DeckMoreBody deckId={deckId} accent={accent} keyInfo={keyInfo} />
                </MorePopover>
            </motion.div>

            <div role="toolbar" aria-label={t("deckui.tabsAria", { id })} className="deck-ctabs deck-row">
                {bare
                    ? TABS.map(({ tab: v, label, Icon }) => <TabPopover key={v} deckId={deckId} accent={accent} tab={v} label={t(label)} icon={<Icon size={13} aria-hidden />} />)
                    : TABS.slice(0, 2).map(({ tab: v, label, Icon }) => (
                          <button key={v} type="button" aria-pressed={inlineTab === v} aria-label={t(label)} title={t(label)} onClick={() => setTab(deckId, v)} className={iconBtn}>
                              <Icon size={13} aria-hidden />
                          </button>
                      ))}
                {!bare && TABS.slice(2).map(({ tab: v, label, Icon }) => <TabPopover key={v} deckId={deckId} accent={accent} tab={v} label={t(label)} icon={<Icon size={13} aria-hidden />} />)}
                {/* Not a <span>: a legacy rule in styles.css hides a trailing span of this toolbar. */}
                {!bare && (
                    <b aria-hidden className="dk-label deck-ctab-name">
                        {t(inlineTab === "loops" ? "deckui.tabLoops" : "deckui.tabCues")}
                    </b>
                )}
            </div>

            {!bare && (
                <motion.div {...lay("lower")} className="deck-tabbody deck-row">
                    <TabBody deckId={deckId} accent={accent} tab={inlineTab} compact />
                </motion.div>
            )}
        </div>
    );
}

/** Track progress of the icon tier: renders per 0.1 % of the track and per second (the spoken value). */
const IconProgress = memo(function IconProgress({ deckId }: DeckProps) {
    const t = useT();
    const permille = useDeckValue(deckId, (d) => Math.round(progressOf(d) * 1000));
    const valueText = useDeckValue(deckId, (d) => `${formatClock(d.position)} / ${formatClock(d.duration)}`);
    return (
        <div
            role="progressbar"
            aria-label={t("deckui.progress", { id: deckId.toUpperCase() })}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(permille / 10)}
            aria-valuetext={valueText}
            className="deck-progress"
        >
            <span style={{ transform: `scaleX(${(permille / 1000).toFixed(3)})` }} />
        </div>
    );
});

/**
 * Icon tier. In touch mode the More button (44 px) joins CUE and PLAY in the one 44 px row and
 * the readouts move up next to the title, so the 110 px minimum still holds.
 */
function DeckIcon({ deckId, accent, keyInfo, warn, lay, touch }: TierProps & { touch: boolean }) {
    const t = useT();
    const id = deckId.toUpperCase();
    const more = (
        <MorePopover label={t("deckui.moreDeck", { id })} icon={<SlidersHorizontal size={13} aria-hidden />} className={touch ? "deck-more-btn" : undefined}>
            <DeckMoreBody deckId={deckId} accent={accent} keyInfo={keyInfo} withTabs withWave />
        </MorePopover>
    );
    return (
        <div className="deck-icon" data-touch={touch ? "true" : undefined}>
            <motion.header {...lay("header")} className="deck-chead deck-row">
                <DeckBadge deckId={deckId} />
                <DeckTitle deckId={deckId} withArtist />
                {touch ? <MiniReadouts deckId={deckId} warn={warn} /> : more}
            </motion.header>
            {!touch && <MiniReadouts deckId={deckId} warn={warn} className="deck-icon-read deck-row" />}
            <motion.div {...lay("transport")} role="group" aria-label={t("deck.perfGroup", { id })} className="deck-transport deck-row">
                <CueButton deckId={deckId} />
                <PlayButton deckId={deckId} iconSize={16} />
                {touch && more}
            </motion.div>
            <IconProgress deckId={deckId} />
        </div>
    );
}
