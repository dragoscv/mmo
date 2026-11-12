import { memo, useId, useRef } from "react";
import { AlertTriangle, SlidersHorizontal, VolumeX } from "lucide-react";
import { engine } from "@/bridge/engine";
import { setStemMute, setStemMuteFx, setStemXf } from "@/bridge/stems";
import type { DeckId, DeckState } from "@/bridge/types";
import { useMixerStore } from "@/state/mixer-store";
import { useT, type MessageKey } from "@/i18n";
import { cn } from "@mmo/ui";
import { MorePopover } from "./panel-ui";
import { RadioCells } from "./deck-tabs/RadioCells";
import { useBeatsText } from "./deck-tabs/beats-text";
import { soft } from "./deck-tabs/soft-disabled";
import { separateStems, useStemJobs } from "./deck-tabs/stem-jobs";
import {
    MUTE_FX_BEATS,
    MUTE_FX_DEFAULT_BEATS,
    XF_MAGNET,
    XF_SLIDER_MAX,
    XF_SLIDER_STEP,
    beatsLabel,
    deckPropsEqual,
    isLibraryTrackId,
    muteFxChoice,
    soloIndex,
    stemChanges,
    stemGains,
    stemMuted,
    stemXfValues,
    xfFromSlider,
    xfReadout,
    xfThumb,
    xfToSlider,
} from "./deck-tabs/tab-math";
import { useFitLevel } from "./deck-tabs/use-fit";

/** Stem layer order matches the Rust engine: vocals, drums, bass, melody. */
const STEMS: readonly { idx: number; label: MessageKey; title: MessageKey }[] = [
    { idx: 0, label: "deckui.stemVoxShort", title: "deckui.stemVox" },
    { idx: 1, label: "deckui.stemDrmShort", title: "deckui.stemDrm" },
    { idx: 2, label: "deckui.stemBasShort", title: "deckui.stemBas" },
    { idx: 3, label: "deckui.stemMelShort", title: "deckui.stemMel" },
];

/** Highest stem gain the level control reaches (1 = unity). */
const GAIN_MAX = 1.2;

interface StemControlsProps {
    deckId: DeckId;
    deck: DeckState;
    /** Deck colour; the look takes it from `--deck`, kept for callers. */
    accent: string;
    className?: string;
}

/**
 * Live per-stem control: mute / solo / level / stem crossfader for vocals, drums, bass and
 * melody, stems on/off and the mute FX. Gains are smoothed in the audio engine, so toggles are
 * click-free. Solo is derived from the gains (one audible stem), so it survives a tab switch.
 *
 * The mute button carries the stem's name; a muted stem is dimmed, struck through and gets a
 * "muted" icon (never the ON accent). With MUTE FX on, a muted stem leaves an echo tail (the
 * echo time is in the popover next to the toggle). The echo time is in beats, so on a track
 * without a tempo the engine mutes plainly: MUTE FX is then shown unavailable (dimmed, not
 * pressed, with the reason as its description), whatever the stored setting is.
 *
 * The stem crossfader is a small second crossfader per stem: at the centre the stem follows the
 * deck; moved towards the crossfader side the deck is NOT on, that stem fades out (so two decks
 * can swap, say, their drums while everything else stays). A deck on THRU has no side: its stem
 * crossfaders do nothing, which each of them says with a THRU tag instead of the A / B ends, a
 * dashed track and its description (the position can still be set for later).
 *
 * The body takes the roomiest form that fits: 0 = mute + solo over the level over the stem
 * crossfader; 1 = the four stacked (narrow and tall); 2 = mute + solo over the level; 3 = mute,
 * solo and level stacked; 4 = one row of mute + solo; 5 = one row of mute. What a form drops is
 * in the "more" popover (2–3: the stem crossfaders; 4: the levels and the mute FX echo time
 * too; 5: the solos too).
 * Without separated stems the tab offers to separate the track and shows the job's progress.
 */
function StemControlsImpl(props: StemControlsProps) {
    if (!props.deck.hasStems) return <StemsEmpty deckId={props.deckId} deck={props.deck} className={props.className} />;
    return <StemsLive {...props} />;
}

interface StemXfProps {
    /** Full name of the stem ("Vocals"). */
    name: string;
    /** Position −1 (side A) .. +1 (side B); 0 = centre. */
    value: number;
    disabled: boolean;
    /** The deck is on THRU: the engine ignores the stem crossfader. */
    thru: boolean;
    /** Id of the element that describes the control (what it does, or why it does nothing now). */
    describedBy: string;
    onChange: (value: number) => void;
}

/**
 * One stem's crossfader: A on the left, B on the right, a tick at the centre. A pointer drag
 * snaps to the centre when it ends near it (detent); arrow keys step 5 % and pass through the
 * centre; a double click returns to it. On THRU the ends give way to a THRU tag.
 */
function StemXf({ name, value, disabled, thru, describedBy, onChange }: StemXfProps) {
    const t = useT();
    const dragging = useRef(false);
    const { side, pct } = xfReadout(value);
    const text = side ? t("decktabs.stemXfSide", { side: t(side === "a" ? "decktabs.stemXfA" : "decktabs.stemXfB"), pct }) : t("decktabs.stemXfCentre");
    const at = xfThumb(value) * 100;
    const stop = () => {
        dragging.current = false;
    };
    return (
        <div className="dt-xf" data-thru={thru ? "" : undefined} title={t(thru ? "decktabs.stemXfThru" : "decktabs.stemXfHint")}>
            {!thru && (
                <span className="dk-label" aria-hidden>
                    {t("decktabs.stemXfA")}
                </span>
            )}
            <input
                type="range"
                className="dt-range dt-xf-range"
                min={-XF_SLIDER_MAX}
                max={XF_SLIDER_MAX}
                step={XF_SLIDER_STEP}
                value={xfToSlider(value)}
                aria-label={t("decktabs.stemXfAria", { stem: name })}
                aria-valuetext={text}
                aria-describedby={describedBy}
                disabled={disabled}
                onPointerDown={() => {
                    dragging.current = true;
                }}
                onPointerUp={stop}
                onPointerCancel={stop}
                onBlur={stop}
                onKeyDown={stop}
                onChange={(e) => onChange(xfFromSlider(Number(e.target.value), dragging.current ? XF_MAGNET : 0))}
                onDoubleClick={() => onChange(0)}
                style={{ ["--lo" as string]: `${Math.min(50, at)}%`, ["--hi" as string]: `${Math.max(50, at)}%` }}
            />
            <span className={thru ? "dk-label dt-xf-thru" : "dk-label"} aria-hidden>
                {t(thru ? "decktabs.stemXfThruShort" : "decktabs.stemXfB")}
            </span>
        </div>
    );
}

function StemsLive({ deckId, deck, className }: StemControlsProps) {
    const t = useT();
    const beatsText = useBeatsText();
    const ids = useId();
    const patchDeck = useMixerStore((s) => s.patchDeck);

    const gains = stemGains(deck.stemGains);
    const solo = soloIndex(gains);
    const xf = stemXfValues(deck.stemXf);
    const muteFx = deck.stemMuteFx ?? false;
    const muteFxBeats = deck.stemMuteFxBeats ?? MUTE_FX_DEFAULT_BEATS;
    const thru = deck.crossfaderAssign === "thru";
    /** The echo time is in beats: without a tempo the engine leaves no tail (a plain mute). */
    const noTempo = !(deck.bpm > 0);
    // A muted stem's button also carries the "muted" icon, a deck on THRU a THRU tag on every
    // stem crossfader: the content changed width, fit again.
    const [ref, level] = useFitLevel<HTMLDivElement>(5, `${gains.map((g) => (stemMuted(g) ? "m" : "-")).join("")}${thru ? "t" : ""}`);
    const xfNote = `${ids}xf`;
    const muteFxNote = `${ids}mutefx`;

    const apply = (next: number[]) => {
        const changes = stemChanges(gains, next);
        if (changes.length === 0) return;
        patchDeck(deckId, { stemGains: next });
        for (const c of changes) {
            if (c.kind === "gain") {
                void engine.setStemGain(deckId, c.idx, c.gain);
                continue;
            }
            // Mute / unmute go through the mute command (the mute FX leaves its echo tail there).
            // A shell built before that command existed still takes the plain gain.
            void setStemMute(deckId, c.idx, c.kind === "mute").then((ok) => {
                if (!ok) void engine.setStemGain(deckId, c.idx, c.gain);
            });
        }
    };
    const toggleMute = (idx: number) => {
        const next: number[] = [...gains];
        next[idx] = stemMuted(gains[idx] ?? 1) ? 1 : 0;
        apply(next);
    };
    const toggleSolo = (idx: number) => {
        if (solo === idx) {
            apply([1, 1, 1, 1]);
            return;
        }
        const next = [0, 0, 0, 0];
        next[idx] = 1;
        apply(next);
    };
    const setGain = (idx: number, v: number) => {
        const next: number[] = [...gains];
        next[idx] = v;
        patchDeck(deckId, { stemGains: next });
        void engine.setStemGain(deckId, idx, v);
    };
    const setXf = (idx: number, v: number) => {
        if (v === xf[idx]) return;
        const next: number[] = [...xf];
        next[idx] = v;
        patchDeck(deckId, { stemXf: next });
        void setStemXf(deckId, idx, v);
    };
    const toggleActive = () => {
        const next = !deck.stemsActive;
        patchDeck(deckId, { stemsActive: next });
        void engine.setStemsActive(deckId, next);
    };
    const toggleMuteFx = () => {
        const next = !muteFx;
        patchDeck(deckId, { stemMuteFx: next });
        void setStemMuteFx(deckId, next, muteFxBeats);
    };
    const setMuteFxBeats = (beats: number) => {
        patchDeck(deckId, { stemMuteFxBeats: beats });
        void setStemMuteFx(deckId, muteFx, beats);
    };

    const soloBtn = (idx: number, name: string) => (
        <button
            type="button"
            className="dk-btn dk-btn-xs dt-stem-s"
            data-tone="deck"
            onClick={() => toggleSolo(idx)}
            disabled={!deck.stemsActive}
            aria-pressed={solo === idx}
            aria-label={t("deckui.stemSolo", { stem: name })}
            title={t("deckui.stemSolo", { stem: name })}
        >
            {t("decktabs.stemSoloShort")}
        </button>
    );
    const levelRange = (idx: number, name: string, g: number) => (
        <input
            type="range"
            className="dt-range"
            min={0}
            max={GAIN_MAX}
            step={0.01}
            value={g}
            aria-label={t("deckui.stemGain", { stem: name })}
            aria-valuetext={`${Math.round(g * 100)} %`}
            disabled={!deck.stemsActive}
            onChange={(e) => setGain(idx, Number(e.target.value))}
            style={{ ["--v" as string]: `${Math.min(100, (g / GAIN_MAX) * 100)}%` }}
        />
    );
    const xfRange = (idx: number, name: string) => (
        <StemXf name={name} value={xf[idx] ?? 0} disabled={!deck.stemsActive} thru={thru} describedBy={xfNote} onChange={(v) => setXf(idx, v)} />
    );

    const beats = beatsLabel(muteFxBeats);
    // What the "more" popover holds at this level: the stem crossfaders, then the levels, then the solos.
    const popCols = level >= 5 ? "all" : level >= 4 ? "levels" : "xf";
    // One-row forms have no room for a second popover button: the echo time joins the "more" popover.
    const timeInPop = level >= 4;
    const muteFxTime = (
        <RadioCells<number>
            label={t("decktabs.muteFxTime")}
            value={muteFxChoice(muteFxBeats)}
            options={MUTE_FX_BEATS.map((v) => ({ value: v, label: beatsLabel(v), title: beatsText("decktabs.muteFxBeat", beatsLabel(v)) }))}
            onChange={setMuteFxBeats}
        />
    );
    const muteFxText = t(noTempo ? "decktabs.muteFxNoTempo" : "decktabs.muteFxHint");

    return (
        <div ref={ref} className={cn("dt-stems", className)} data-level={level}>
            {/* Descriptions of the controls below (a tooltip alone is out of reach of a keyboard or a touch screen). */}
            <span id={xfNote} hidden>
                {t(thru ? "decktabs.stemXfThru" : "decktabs.stemXfHint")}
            </span>
            <span id={muteFxNote} hidden>
                {muteFxText}
            </span>
            <div className="dt-stems-grid" data-on={deck.stemsActive}>
                <div className="dt-stems-cells">
                    {STEMS.map(({ idx, label, title }) => {
                        const g = gains[idx] ?? 1;
                        const muted = stemMuted(g);
                        const name = t(title);
                        return (
                            <div key={idx} role="group" aria-label={name} className="dt-stem" data-muted={muted}>
                                <button
                                    type="button"
                                    className="dk-btn dk-btn-xs dt-stem-m"
                                    onClick={() => toggleMute(idx)}
                                    disabled={!deck.stemsActive}
                                    aria-pressed={muted}
                                    aria-label={t("deckui.stemMute", { stem: name })}
                                    title={t("deckui.stemMute", { stem: name })}
                                >
                                    {muted && <VolumeX size={11} aria-hidden />}
                                    <span className="dt-stem-name">{t(label)}</span>
                                </button>
                                {level < 5 && soloBtn(idx, name)}
                                {level < 4 && levelRange(idx, name, g)}
                                {level < 2 && xfRange(idx, name)}
                            </div>
                        );
                    })}
                </div>
                <div className="dt-stems-side">
                    <button type="button" className="dk-btn dk-btn-xs dt-stems-toggle" onClick={toggleActive} aria-pressed={deck.stemsActive} title={t("deckui.stemsToggleHint")}>
                        <span>{t("deckui.stems")}</span>
                        <span>{deck.stemsActive ? t("deckui.on") : t("deckui.off")}</span>
                    </button>
                    {level >= 2 && (
                        <MorePopover label={t("decktabs.stemMore")} icon={<SlidersHorizontal size={13} aria-hidden />} side="top" className="dt-stems-more">
                            <div className="dt-stems-pop" data-cols={popCols} data-on={deck.stemsActive} data-deck-scope="" style={{ ["--deck" as string]: `var(--deck-${deckId})` }}>
                                <div className="dt-stems-pop-row dt-stems-pop-head" aria-hidden>
                                    <span />
                                    {level >= 5 && <span />}
                                    {level >= 4 && <span className="dk-label">{t("decktabs.stemLevel")}</span>}
                                    <span className="dk-label">{t("decktabs.stemXf")}</span>
                                </div>
                                {STEMS.map(({ idx, label, title }) => {
                                    const g = gains[idx] ?? 1;
                                    const name = t(title);
                                    return (
                                        <div key={idx} role="group" aria-label={name} className="dt-stems-pop-row" data-muted={stemMuted(g)}>
                                            <span className="dk-label dt-stem-name" title={name}>
                                                {t(label)}
                                            </span>
                                            {level >= 5 && soloBtn(idx, name)}
                                            {level >= 4 && levelRange(idx, name, g)}
                                            {xfRange(idx, name)}
                                        </div>
                                    );
                                })}
                                {timeInPop && (
                                    <div className="dt-stems-pop-time">
                                        <span className="dk-label">{t("decktabs.muteFxTime")}</span>
                                        {muteFxTime}
                                    </div>
                                )}
                            </div>
                        </MorePopover>
                    )}
                    <button
                        type="button"
                        className="dk-btn dk-btn-xs dt-mutefx"
                        aria-pressed={muteFx && !noTempo}
                        aria-describedby={muteFxNote}
                        title={muteFxText}
                        {...soft(noTempo, toggleMuteFx)}
                    >
                        {t("decktabs.muteFx")}
                    </button>
                    {!timeInPop && (
                        <MorePopover
                            label={beatsText("decktabs.muteFxBeat", beats)}
                            title={t("decktabs.muteFxTime")}
                            side="top"
                            triggerClassName="dk-btn dk-btn-xs dt-mutefx-time"
                            triggerContent={<span className="dk-num">{beats}</span>}
                        >
                            {muteFxTime}
                        </MorePopover>
                    )}
                </div>
            </div>
        </div>
    );
}
export const StemControls = memo(
    StemControlsImpl,
    deckPropsEqual<DeckState, StemControlsProps>(["trackId", "loaded", "bpm", "hasStems", "stemsActive", "stemGains", "stemXf", "stemMuteFx", "stemMuteFxBeats", "crossfaderAssign"]),
);

/**
 * No stems on the deck: a short note, the "separate" action and its progress. Separation is a
 * companion job on a LIBRARY track, so a local file or a dev-loaded track only gets the note.
 */
function StemsEmpty({ deckId, deck, className }: { deckId: DeckId; deck: DeckState; className?: string }) {
    const t = useT();
    const job = useStemJobs((s) => (deck.trackId ? s.jobs[deck.trackId] : undefined));
    const inLibrary = isLibraryTrackId(deck.trackId);
    const running = job?.state === "running";
    const failed = job?.state === "error";
    const pct = Math.round((job?.progress ?? 0) * 100);
    if (deck.loaded && !inLibrary)
        return (
            <div className={cn("dt-stems-empty", className)}>
                <p className="dt-stems-msg">{t("decktabs.stemsNotLibrary")}</p>
            </div>
        );
    return (
        <div className={cn("dt-stems-empty", className)}>
            {running ? (
                <div className="dt-stems-job">
                    <span className="dk-label">{t("decktabs.stemsSeparating")}</span>
                    <span className="dk-num dk-num-sm">{pct} %</span>
                    <div role="progressbar" aria-label={t("decktabs.stemsProgressAria")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} className="dt-progress">
                        <span style={{ width: `${pct}%` }} />
                    </div>
                </div>
            ) : (
                <p className="dt-stems-msg" role={failed ? "alert" : undefined}>
                    {failed && <AlertTriangle size={12} aria-hidden className="dt-stems-warn" />}
                    {failed ? t(job?.reason === "notLibrary" ? "decktabs.stemsNotLibrary" : "decktabs.stemsFailed") : t("decktabs.stemsNone")}
                </p>
            )}
            <button type="button" className="dk-btn" title={t("decktabs.stemsSeparateAria")} {...soft(!deck.loaded || running, () => separateStems(deckId, deck.trackId))}>
                {t(failed ? "decktabs.stemsRetry" : "decktabs.stemsSeparate")}
            </button>
        </div>
    );
}
