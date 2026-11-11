import type { CSSProperties } from "react";
import { SlidersHorizontal } from "lucide-react";
import { engine } from "@/bridge/engine";
import { useMixerStore } from "@/state/mixer-store";
import { usePanelTier } from "@/layout/panel-tier";
import { useT } from "@/i18n";
import { Fader } from "./Fader";
import { MorePopover } from "./panel-ui";
import { VuMeter } from "./mixer/VuMeter";
import { MasterKnob } from "./mixer/MasterKnob";
import { CurveSelect } from "./mixer/XfaderControls";
import { useMixerShown } from "./mixer/presence";

const pct = (v: number) => `${Math.round(v * 100)}%`;
const sideVar = (deck: "a" | "b") => ({ "--deck": `var(--deck-${deck})` }) as CSSProperties;

/**
 * Crossfader: a flat horizontal fader between A and B (deck colours) with a centre detent
 * (pointer snaps to it, double-click / Enter returns to it).
 *  - full: A · label · B, the fader, then the curve cells (linear / smooth / sharp)
 *  - compact: A, fader, B in one row; the curve cells in the options popover
 *  - icon: the same, tighter
 * The master level lives in the mixer's master column; this panel shows it only when no mixer
 * is on screen (full: inline, compact / icon: in the popover).
 */
export function Crossfader() {
    const t = useT();
    const tier = usePanelTier();
    const crossfader = useMixerStore((s) => s.crossfader);
    const mixerShown = useMixerShown();

    const setX = (v: number) => {
        useMixerStore.getState().patchMixer({ crossfader: v });
        void engine.setCrossfader(v);
    };
    const valueText = (v: number) => (Math.abs(v) < 0.005 ? t("deckui.xfaderCenter") : v < 0 ? t("deckui.xfaderToA", { n: pct(-v) }) : t("deckui.xfaderToB", { n: pct(v) }));

    const fader = <Fader orientation="horizontal" value={crossfader} min={-1} max={1} detent={0} resetTo={0} onChange={setX} ariaLabel={t("deckui.xfaderAria")} format={valueText} className="xf-fader" />;
    const a = (
        <span className="xf-side" style={sideVar("a")} aria-hidden>
            {t("mix.sideA")}
        </span>
    );
    const b = (
        <span className="xf-side" style={sideVar("b")} aria-hidden>
            {t("mix.sideB")}
        </span>
    );
    const master = (
        <div className="xf-master">
            <MasterKnob size={34} label showValue />
            <VuMeter source="master" label={t("deckui.masterVuAria")} orientation="horizontal" className="mx-detail-vu" />
        </div>
    );
    const options = (
        <MorePopover label={t("mix.xfaderMore")} title={t("deckui.xfader")} side="top" icon={<SlidersHorizontal size={13} aria-hidden />} contentClassName="mx-pop">
            <CurveSelect />
            {!mixerShown && master}
        </MorePopover>
    );

    return (
        <section aria-label={t("deckui.xfader")} data-tier={tier} className="panel xf-panel">
            {tier === "full" ? (
                <>
                    <div className="xf-top">
                        {a}
                        <span className="dk-label">{t("deckui.xfader")}</span>
                        {b}
                    </div>
                    <div className="xf-row">{fader}</div>
                    <div className="xf-row xf-extra">
                        <CurveSelect />
                        {!mixerShown && (
                            <>
                                <span className="dk-label">{t("mix.masterShort")}</span>
                                <MasterKnob size={24} />
                                <VuMeter source="master" label={t("deckui.masterVuAria")} orientation="horizontal" className="mx-detail-vu" />
                            </>
                        )}
                    </div>
                </>
            ) : (
                <div className="xf-row">
                    {a}
                    {fader}
                    {b}
                    {options}
                </div>
            )}
        </section>
    );
}
