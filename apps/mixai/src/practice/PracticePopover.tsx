/**
 * Body of the practice popover (opened from PracticeChip): the switch, the session score, the
 * four criteria as 5-cell meters, up to three tips and "Reset session".
 *
 * Nothing here uses the arrow keys; PracticeChip's popup consumes bare arrows so they never
 * reach the app's crossfader shortcuts.
 */
import { useLocale, useT, type MessageKey } from "@/i18n";
import { pluralCategory } from "@/library/track-view";
import { METER_CELLS, usePracticeStore } from "./practice-store";
import { CRITERIA, type Criterion, type TipId } from "./scoring";

const CRITERION_KEY: Record<Criterion, MessageKey> = {
    tempo: "practice.crit.tempo",
    phase: "practice.crit.phase",
    key: "practice.crit.key",
    level: "practice.crit.level",
};

const TIP_KEY: Record<TipId, MessageKey> = {
    tempo_drift: "practice.tip.tempo_drift",
    phase_off: "practice.tip.phase_off",
    key_clash: "practice.tip.key_clash",
    level_jump: "practice.tip.level_jump",
    good_blend: "practice.tip.good_blend",
};

const SLOTS = Array.from({ length: METER_CELLS }, (_, i) => i);

function mixTime(sec: number): string {
    const m = Math.floor(sec / 60);
    return `${m}:${String(sec % 60).padStart(2, "0")}`;
}

function CriterionRow({ id }: { id: Criterion }) {
    const t = useT();
    const lit = usePracticeStore((s) => s.cells[id]);
    const known = usePracticeStore((s) => s.known[id]);
    const name = t(CRITERION_KEY[id]);
    return (
        <li className="pr-row">
            <span className="dk-label">{name}</span>
            <span
                className="sb-cells pr-cells"
                role="meter"
                data-lit={known ? lit : 0}
                aria-label={name}
                aria-valuemin={0}
                aria-valuemax={METER_CELLS}
                aria-valuenow={known ? lit : 0}
                aria-valuetext={known ? t("practice.cellsOf", { n: lit, max: METER_CELLS }) : t("practice.noData")}
            >
                {SLOTS.map((i) => (
                    <i key={i} />
                ))}
            </span>
            <span className="dk-num dk-num-sm pr-row-num" aria-hidden>
                {known ? t("practice.cellsShort", { n: lit, max: METER_CELLS }) : t("practice.noScore")}
            </span>
        </li>
    );
}

export function PracticePopover() {
    const t = useT();
    const locale = useLocale();
    const on = usePracticeStore((s) => s.on);
    const score = usePracticeStore((s) => s.score);
    const tips = usePracticeStore((s) => s.tips);
    const mixSec = usePracticeStore((s) => s.mixSec);
    const blends = usePracticeStore((s) => s.blends);
    const mixing = usePracticeStore((s) => s.mixing);
    const toggle = usePracticeStore((s) => s.toggle);
    const reset = usePracticeStore((s) => s.reset);
    const hint = !on ? t("practice.hintOff") : score === null ? t("practice.hintWait") : mixing ? t("practice.hintMixing") : t("practice.hintPaused");
    return (
        <div className="pr-body">
            <div className="pr-head">
                {/* The sentence is real text for assistive technology; the big digits are its visual form. */}
                <p className="pr-score">
                    <span className="sr-only">{score === null ? t("practice.scoreNone") : t("practice.scoreAria", { score })}</span>
                    <span className="dk-num dk-num-xl" aria-hidden>
                        {score === null ? t("practice.noScore") : score}
                    </span>
                    <span className="dk-label" aria-hidden>
                        {t("practice.outOf")}
                    </span>
                </p>
                <button type="button" className="dk-btn" aria-pressed={on} onClick={toggle}>
                    {on ? t("practice.stop") : t("practice.start")}
                </button>
            </div>
            <p className="pr-hint">{hint}</p>
            <ul className="pr-rows" aria-label={t("practice.criteria")}>
                {CRITERIA.map((c) => (
                    <CriterionRow key={c} id={c} />
                ))}
            </ul>
            <div className="pr-tips">
                <span className="dk-label">{t("practice.tips")}</span>
                {tips.length === 0 ? (
                    <p className="pr-hint">{score === null ? t("practice.tipsWait") : t("practice.tipsNone")}</p>
                ) : (
                    <ul>
                        {tips.map((id) => (
                            <li key={id} data-kind={id === "good_blend" ? "good" : "fix"}>
                                <strong className="dk-label">{id === "good_blend" ? t("practice.tipGood") : t("practice.tipFix")}</strong>
                                <span>{t(TIP_KEY[id])}</span>
                            </li>
                        ))}
                    </ul>
                )}
            </div>
            <div className="pr-foot">
                <span className="dk-num dk-num-sm">
                    {t("practice.mixTime", { time: mixTime(mixSec) })} · {t(`practice.blendsN.${pluralCategory(blends, locale)}`, { n: blends })}
                </span>
                <button type="button" className="dk-btn dk-btn-xs" onClick={reset}>
                    {t("practice.reset")}
                </button>
            </div>
            <p className="pr-hint pr-note">{t("practice.heuristic")}</p>
        </div>
    );
}
