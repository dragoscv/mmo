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
 * Headphone / booth routing (WP19-06): cue mix (cue ↔ master), headphone
 * level, split-mono, 4-channel mapping (only when the device has ≥4 outputs)
 * and booth level. Per-output latency offsets live in Settings.
 */
export function RoutingPanel() {
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
    const fourHint = canFour
        ? t("routing.fourChHint")
        : t("routing.fourChUnavailable", { n: channels ?? "?" });

    return (
        <section aria-label={t("routing.title")} style={{ display: "grid", gap: 8, borderTop: "1px solid var(--border)", paddingTop: 8 }}>
            <span style={{ fontSize: 10, color: "var(--fg-dim)", letterSpacing: "0.12em", textAlign: "center" }}>
                {t("routing.title")}
            </span>
            <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
                <Knob
                    size={40}
                    value={routing.cueMix}
                    min={0}
                    max={1}
                    center={0.5}
                    label={t("routing.cueMix")}
                    ariaLabel={t("routing.cueMixAria")}
                    format={(v) => `${pct(1 - v)}·${pct(v)}`}
                    onChange={(v) => patchRouting({ cueMix: v })}
                />
                <Knob
                    size={40}
                    value={routing.headphoneLevel}
                    min={0}
                    max={1.5}
                    center={0.7}
                    label={t("routing.phones")}
                    ariaLabel={t("routing.phonesAria")}
                    format={pct}
                    onChange={(v) => patchRouting({ headphoneLevel: v })}
                />
                <Knob
                    size={40}
                    value={routing.boothLevel}
                    min={0}
                    max={1.5}
                    center={0}
                    label={t("routing.booth")}
                    ariaLabel={t("routing.boothAria")}
                    format={(v) => (v <= 0.001 ? t("routing.off") : pct(v))}
                    onChange={(v) => patchRouting({ boothLevel: v })}
                />
            </div>
            <div style={{ display: "flex", gap: 4, justifyContent: "center", flexWrap: "wrap" }}>
                <ToggleChip
                    size="xs"
                    pressed={routing.splitMono}
                    onClick={() => patchRouting({ splitMono: !routing.splitMono })}
                    title={t("routing.splitMonoHint")}
                >
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
