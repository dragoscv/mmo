import { useEffect } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@mmo/ui";
import { engine } from "@/bridge/engine";
import { usePerfStore } from "@/state/perf-store";
import { fourChannelAvailable } from "@/lib/perf";
import { useT } from "@/i18n";
import { Knob } from "./Knob";
import { ToggleChip } from "./ToggleChip";

const pct = (v: number) => `${Math.round(v * 100)}%`;

/**
 * Headphone / booth routing (WP19-06): cue mix (cue ↔ master), headphone level, booth level,
 * split-mono and the 4-channel mapping (only when the device has ≥ 4 outputs). Per-output
 * latency offsets live in Settings.
 *
 *  - `variant="full"`: the whole form (mixer "More" popover).
 *  - `variant="column"`: `count` knobs stacked, 26 px with legends: the mixer's master column
 *    (2 = cue mix + phones, 3 = + booth).
 *  - `variant="inline"`: the same knobs in a row.
 */
export function RoutingPanel({ variant = "full", count = 3 }: { variant?: "full" | "inline" | "column"; count?: 2 | 3 }) {
    const t = useT();
    const routing = usePerfStore((s) => s.routing);
    const channels = usePerfStore((s) => s.outputChannels);
    const patchRouting = usePerfStore((s) => s.patchRouting);
    const loadRouting = usePerfStore((s) => s.loadRouting);
    const setOutputDevices = usePerfStore((s) => s.setOutputDevices);

    useEffect(() => {
        void loadRouting();
        void engine.listAudioDevices().then((d) => {
            if (d) setOutputDevices(d);
        });
    }, [loadRouting, setOutputDevices]);

    const canFour = fourChannelAvailable(channels);
    const fourOn = routing.mode === "fourChannel" && canFour;
    const fourHint = canFour ? t("routing.fourChHint") : t("routing.fourChUnavailable", { n: channels ?? "?" });

    const knobs = (size: number, showValue: boolean, n: number) => (
        <>
            <Knob
                size={size}
                value={routing.cueMix}
                min={0}
                max={1}
                center={0.5}
                label={t("routing.cueMix")}
                ariaLabel={t("routing.cueMixAria")}
                format={(v) => t("mix.cueMixValue", { cue: pct(1 - v), master: pct(v) })}
                showValue={false}
                onChange={(v) => patchRouting({ cueMix: v })}
            />
            <Knob
                size={size}
                value={routing.headphoneLevel}
                min={0}
                max={1.5}
                center={0.7}
                bipolar={false}
                label={t("routing.phones")}
                ariaLabel={t("routing.phonesAria")}
                format={pct}
                showValue={showValue}
                onChange={(v) => patchRouting({ headphoneLevel: v })}
            />
            {n >= 3 && (
                <Knob
                    size={size}
                    value={routing.boothLevel}
                    min={0}
                    max={1.5}
                    center={0}
                    label={t("routing.booth")}
                    ariaLabel={t("routing.boothAria")}
                    format={(v) => (v <= 0.001 ? t("routing.off") : pct(v))}
                    showValue={showValue}
                    onChange={(v) => patchRouting({ boothLevel: v })}
                />
            )}
        </>
    );

    if (variant !== "full") {
        return (
            <div role="group" aria-label={t("routing.title")} className="mx-sends" data-dir={variant === "column" ? "column" : "row"}>
                {knobs(26, false, count)}
            </div>
        );
    }

    return (
        <section aria-label={t("routing.title")} className="mx-routing">
            <span className="dk-label">{t("routing.title")}</span>
            <div className="mx-routing-knobs">{knobs(34, true, 3)}</div>
            <div className="mx-routing-toggles">
                <ToggleChip size="xs" pressed={routing.splitMono} onClick={() => patchRouting({ splitMono: !routing.splitMono })} title={t("routing.splitMonoHint")}>
                    {t("routing.splitMono")}
                </ToggleChip>
                <Tooltip>
                    <TooltipTrigger
                        render={
                            <ToggleChip
                                size="xs"
                                pressed={fourOn}
                                aria-disabled={!canFour}
                                aria-label={`${t("routing.fourCh")} — ${fourHint}`}
                                onClick={() => {
                                    if (!canFour) return;
                                    patchRouting({ mode: fourOn ? "auto" : "fourChannel" });
                                }}
                            >
                                {t("routing.fourCh")}
                            </ToggleChip>
                        }
                    />
                    <TooltipContent>{fourHint}</TooltipContent>
                </Tooltip>
            </div>
        </section>
    );
}
