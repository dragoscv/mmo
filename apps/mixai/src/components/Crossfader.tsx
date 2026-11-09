import { motion } from "motion/react";
import { engine } from "@/bridge/engine";
import { useMixerStore } from "@/state/mixer-store";
import { usePanelTier } from "@/layout/panel-tier";
import { useT } from "@/i18n";
import { cn } from "@mmo/ui";
import { Knob } from "./Knob";
import { MorePopover, tierLayout, useMotionOK } from "./panel-ui";

const pct = (v: number) => `${Math.round(v * 100)}%`;

/**
 * Crossfader + master volume.
 *  - full: A · label · B, crossfader, master slider + master VU
 *  - compact: crossfader + small master knob
 *  - icon: crossfader only (master volume in a popover)
 */
export function Crossfader() {
    const t = useT();
    const tier = usePanelTier();
    const lay = tierLayout(useMotionOK(), tier, "xfader");
    const crossfader = useMixerStore((s) => s.crossfader);
    const masterVolume = useMixerStore((s) => s.masterVolume);
    const masterVu = useMixerStore((s) => s.masterVu);
    const patchMixer = useMixerStore((s) => s.patchMixer);

    const setX = (v: number) => {
        patchMixer({ crossfader: v });
        void engine.setCrossfader(v);
    };
    const setMaster = (v: number) => {
        patchMixer({ masterVolume: v });
        void engine.setMasterVolume(v);
    };

    const fader = (
        <input
            type="range"
            min={-1}
            max={1}
            step={0.01}
            value={crossfader}
            aria-label={t("deckui.xfaderAria")}
            aria-valuetext={crossfader === 0 ? t("deckui.xfaderCenter") : crossfader < 0 ? t("deckui.xfaderToA", { n: pct(-crossfader) }) : t("deckui.xfaderToB", { n: pct(crossfader) })}
            onChange={(e) => setX(Number(e.target.value))}
            onDoubleClick={() => setX(0)}
            className="block min-h-6 w-full min-w-0"
        />
    );

    const masterKnob = (size: number) => (
        <Knob size={size} value={masterVolume} min={0} max={1} center={1} ariaLabel={t("deckui.masterAria")} format={pct} showValue={false} onChange={setMaster} />
    );

    const vuPct = Math.round(Math.min(1, Math.max(0, masterVu)) * 100);
    const vu = (
        <div role="meter" aria-label={t("deckui.masterVuAria")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={vuPct} className="relative h-full min-h-4 w-2 shrink-0 overflow-hidden rounded-sm bg-[var(--bg-elev-2)]">
            <div className="absolute inset-x-0 bottom-0" style={{ height: `${vuPct}%`, background: "linear-gradient(0deg, var(--good), var(--danger))" }} />
        </div>
    );

    return (
        <section
            aria-label={t("deckui.xfader")}
            data-tier={tier}
            className={cn("panel h-full w-full min-h-0 min-w-0 overflow-hidden", tier === "full" ? "px-3 py-2" : tier === "compact" ? "px-2 py-1.5" : "px-2 py-0.5")}
        >
            {tier === "full" && (
                <div className="grid h-full min-h-0 content-center gap-1.5">
                    <motion.div {...lay("fader")} className="grid gap-0.5">
                        <div className="flex justify-between text-[10px] text-[var(--fg-dim)]">
                            <span className="font-bold" style={{ color: "var(--accent-deck-a)" }}>A</span>
                            <span>{t("deckui.xfader")}</span>
                            <span className="font-bold" style={{ color: "var(--accent-deck-b)" }}>B</span>
                        </div>
                        {fader}
                    </motion.div>
                    <motion.div {...lay("master")} className="grid min-h-6 items-center gap-2" style={{ gridTemplateColumns: "auto minmax(0, 1fr) auto auto" }}>
                        <span className="text-[10px] text-[var(--fg-dim)]">{t("deckui.master")}</span>
                        <input
                            type="range"
                            min={0}
                            max={1}
                            step={0.01}
                            value={masterVolume}
                            aria-label={t("deckui.masterAria")}
                            aria-valuetext={pct(masterVolume)}
                            onChange={(e) => setMaster(Number(e.target.value))}
                            className="min-h-6 w-full min-w-0"
                        />
                        <span className="mono w-9 text-right text-[10px]">{pct(masterVolume)}</span>
                        <div className="h-6">{vu}</div>
                    </motion.div>
                </div>
            )}
            {tier === "compact" && (
                <motion.div {...lay("fader")} className="flex h-full min-h-0 items-center gap-2">
                    <span className="text-[10px] font-bold" style={{ color: "var(--accent-deck-a)" }} aria-hidden>A</span>
                    <div className="min-w-0 flex-1">{fader}</div>
                    <span className="text-[10px] font-bold" style={{ color: "var(--accent-deck-b)" }} aria-hidden>B</span>
                    {masterKnob(28)}
                    <div className="h-7">{vu}</div>
                </motion.div>
            )}
            {tier === "icon" && (
                <motion.div {...lay("fader")} className="flex h-full min-h-0 items-center gap-1">
                    <div className="min-w-0 flex-1">{fader}</div>
                    <MorePopover label={t("deckui.masterAria")} side="top" contentClassName="w-auto">
                        <div className="flex items-center gap-3">
                            <Knob size={40} value={masterVolume} min={0} max={1} center={1} label={t("deckui.master")} ariaLabel={t("deckui.masterAria")} format={pct} onChange={setMaster} />
                            <div className="h-12">{vu}</div>
                        </div>
                    </MorePopover>
                </motion.div>
            )}
        </section>
    );
}
