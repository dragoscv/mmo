import { memo } from "react";
import { AlertTriangle, SlidersHorizontal, VolumeX } from "lucide-react";
import { engine } from "@/bridge/engine";
import type { DeckId, DeckState } from "@/bridge/types";
import { useMixerStore } from "@/state/mixer-store";
import { useT, type MessageKey } from "@/i18n";
import { cn } from "@mmo/ui";
import { MorePopover } from "./panel-ui";
import { soft } from "./deck-tabs/soft-disabled";
import { separateStems, useStemJobs } from "./deck-tabs/stem-jobs";
import { deckPropsEqual, isLibraryTrackId, soloIndex, stemGains, stemMuted } from "./deck-tabs/tab-math";
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
 * Live per-stem control: mute / solo / level for vocals, drums, bass and melody, and stems
 * on/off. Gains are smoothed in the audio engine, so toggles are click-free. Solo is derived
 * from the gains (one audible stem), so it survives a tab switch.
 *
 * The mute button carries the stem's name; a muted stem is dimmed, struck through and gets a
 * "muted" icon (never the ON accent, which only "stems on" uses). The body takes the roomiest
 * form that fits: 0 = mute + solo over the level; 1 = mute, solo and level stacked (narrow and
 * tall); 2 = one row of mute + solo, levels in a popover; 3 = one row of mute, solo and levels
 * in the popover.
 * Without separated stems the tab offers to separate the track and shows the job's progress.
 */
function StemControlsImpl(props: StemControlsProps) {
    if (!props.deck.hasStems) return <StemsEmpty deckId={props.deckId} deck={props.deck} className={props.className} />;
    return <StemsLive {...props} />;
}

function StemsLive({ deckId, deck, className }: StemControlsProps) {
    const t = useT();
    const patchDeck = useMixerStore((s) => s.patchDeck);
    const [ref, level] = useFitLevel<HTMLDivElement>(3);

    const gains = stemGains(deck.stemGains);
    const solo = soloIndex(gains);

    const apply = (next: number[]) => {
        patchDeck(deckId, { stemGains: next });
        for (const { idx } of STEMS) void engine.setStemGain(deckId, idx, next[idx] ?? 1);
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
    const toggleActive = () => {
        const next = !deck.stemsActive;
        patchDeck(deckId, { stemsActive: next });
        void engine.setStemsActive(deckId, next);
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

    return (
        <div ref={ref} className={cn("dt-stems", className)} data-level={level}>
            <div className="dt-stems-grid" data-on={deck.stemsActive}>
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
                            {level < 3 && soloBtn(idx, name)}
                            {level < 2 && levelRange(idx, name, g)}
                        </div>
                    );
                })}
                <button type="button" className="dk-btn dk-btn-xs dt-stems-toggle" onClick={toggleActive} aria-pressed={deck.stemsActive} title={t("deckui.stemsToggleHint")}>
                    <span>{t("deckui.stems")}</span>
                    <span>{deck.stemsActive ? t("deckui.on") : t("deckui.off")}</span>
                </button>
                {level >= 2 && (
                    <MorePopover label={t(level === 3 ? "decktabs.stemSoloLevels" : "decktabs.stemLevels")} icon={<SlidersHorizontal size={13} aria-hidden />} side="top">
                        <div className="dt-stems-pop" data-deck-scope="" style={{ ["--deck" as string]: `var(--deck-${deckId})` }}>
                            {STEMS.map(({ idx, label, title }) => {
                                const g = gains[idx] ?? 1;
                                const name = t(title);
                                return (
                                    <div key={idx} role="group" aria-label={name} className="dt-stems-pop-row" data-muted={stemMuted(g)}>
                                        <span className="dk-label dt-stem-name" title={name}>
                                            {t(label)}
                                        </span>
                                        {level === 3 && soloBtn(idx, name)}
                                        {levelRange(idx, name, g)}
                                    </div>
                                );
                            })}
                        </div>
                    </MorePopover>
                )}
            </div>
        </div>
    );
}
export const StemControls = memo(StemControlsImpl, deckPropsEqual<DeckState, StemControlsProps>(["trackId", "loaded", "hasStems", "stemsActive", "stemGains"]));

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
