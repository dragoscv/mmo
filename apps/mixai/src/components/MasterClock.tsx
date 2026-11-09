import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { Settings2 } from "lucide-react";
import type { ClockSource } from "@/bridge/types";
import { useMixerStore } from "@/state/mixer-store";
import { usePerfStore } from "@/state/perf-store";
import { useClockPoll } from "@/lib/use-clock-poll";
import { beatInBar } from "@/lib/perf";
import { usePanelTier } from "@/layout/panel-tier";
import { useT } from "@/i18n";
import { cn } from "@mmo/ui";
import { MorePopover, tierLayout, useMotionOK } from "./panel-ui";

const SOURCES: readonly ClockSource[] = ["auto", "internal", "a", "b", "c", "d"];

const field: React.CSSProperties = {
    background: "var(--bg-elev-2)",
    color: "var(--fg)",
    border: "1px solid var(--border)",
    borderRadius: 6,
    padding: "0 6px",
    minHeight: 24,
    fontSize: 11,
    fontWeight: 700,
};

/** Source select + internal BPM field (inline in full tier, in a popover otherwise). */
function ClockSourceControls({ deckCount }: { deckCount: 2 | 4 }) {
    const t = useT();
    const source = usePerfStore((s) => s.clockSource);
    const internalBpm = usePerfStore((s) => s.internalBpm);
    const setClockSource = usePerfStore((s) => s.setClockSource);
    const setInternalBpm = usePerfStore((s) => s.setInternalBpm);
    const [bpmDraft, setBpmDraft] = useState(internalBpm.toFixed(1));
    useEffect(() => setBpmDraft(internalBpm.toFixed(1)), [internalBpm]);
    const sources = SOURCES.filter((s) => deckCount === 4 || (s !== "c" && s !== "d"));

    const commitBpm = () => {
        const v = Number(bpmDraft.replace(",", "."));
        if (Number.isFinite(v) && v >= 20 && v <= 300) setInternalBpm(v);
        else setBpmDraft(internalBpm.toFixed(1));
    };

    return (
        <>
            <label className="inline-flex min-w-0 items-center gap-1 text-[10px]">
                <span className="sr-only">{t("clock.source")}</span>
                <select value={source} onChange={(e) => setClockSource(e.target.value as ClockSource)} style={field} className="min-w-0">
                    {sources.map((s) => (
                        <option key={s} value={s}>
                            {s === "auto" ? t("clock.auto") : s === "internal" ? t("clock.internal") : t("clock.deck", { id: s.toUpperCase() })}
                        </option>
                    ))}
                </select>
            </label>
            {source === "internal" && (
                <label className="inline-flex shrink-0 items-center gap-1 text-[10px]">
                    <span className="sr-only">{t("clock.bpmField")}</span>
                    <input
                        type="number"
                        inputMode="decimal"
                        min={20}
                        max={300}
                        step={0.1}
                        value={bpmDraft}
                        onChange={(e) => setBpmDraft(e.target.value)}
                        onBlur={commitBpm}
                        onKeyDown={(e) => {
                            if (e.key === "Enter") commitBpm();
                        }}
                        className="mono w-16"
                        style={{ ...field, fontWeight: 400 }}
                    />
                    <span aria-hidden className="text-[var(--fg-dim)] @max-[340px]:hidden">BPM</span>
                </label>
            )}
        </>
    );
}

/**
 * Master clock: source selector (auto / internal + bpm / deck A–D), live bpm
 * and a beat/bar phase indicator. Owns the ≤30 Hz `engine_clock_state` poll
 * in every tier. The phase sweep is decorative and disappears under reduced
 * motion (the discrete beat cells still show the position) — see `.mixai-phase`.
 *  - full: title, source select (+ internal BPM), live BPM, beat cells, phase
 *  - compact: live BPM + beat cells; source in a popover
 *  - icon: live BPM text; source in a popover
 */
export function MasterClock({ deckCount }: { deckCount: 2 | 4 }) {
    useClockPoll();
    const t = useT();
    const tier = usePanelTier();
    const lay = tierLayout(useMotionOK(), tier, "clock");
    const native = useMixerStore((s) => s.native);
    const clock = usePerfStore((s) => s.clock);

    const bpb = clock?.beatsPerBar && clock.beatsPerBar > 0 ? clock.beatsPerBar : 4;
    const beat = beatInBar(clock);
    const phase = clock ? Math.max(0, Math.min(1, clock.beatPhase)) : 0;
    const liveBpm = clock && clock.bpm > 0 ? clock.bpm.toFixed(1) : "--";
    const drivenBy = clock?.source ? (clock.source === "internal" ? t("clock.internal") : clock.source.toUpperCase()) : "—";
    const phaseLabel = native && beat !== null ? t("clock.phaseAria", { beat: beat + 1, bar: bpb }) : t("clock.offline");

    const bpmText = (big: boolean) => (
        <span className={cn("mono shrink-0 font-extrabold", big ? "text-[16px]" : "text-[13px]")} title={t("clock.liveHint", { source: drivenBy })}>
            {liveBpm}
            <span className="ml-0.5 text-[9px] font-normal text-[var(--fg-dim)] @max-[340px]:hidden">{tier === "full" ? `BPM · ${drivenBy}` : "BPM"}</span>
        </span>
    );

    const cells = (
        <div role="img" aria-label={phaseLabel} className="grid min-w-0 flex-1 gap-0.5">
            <div className="grid gap-0.5" style={{ gridTemplateColumns: `repeat(${bpb}, minmax(0, 1fr))` }}>
                {Array.from({ length: bpb }, (_, i) => (
                    <span key={i} data-on={beat === i ? "true" : "false"} data-downbeat={i === 0 ? "true" : "false"} className="mixai-beat-cell" />
                ))}
            </div>
            {tier === "full" && (
                <div className="mixai-phase" aria-hidden>
                    <span style={{ transform: `scaleX(${phase})` }} />
                </div>
            )}
        </div>
    );

    const sourcePopover = (
        <MorePopover label={t("clock.source")} icon={<Settings2 size={13} aria-hidden />} title={t("clock.title")} contentClassName="w-auto">
            <div className="flex flex-wrap items-center gap-2">
                <ClockSourceControls deckCount={deckCount} />
            </div>
            {!native && <p className="m-0 text-[10px] text-[var(--fg-dim)]">{t("clock.offline")}</p>}
        </MorePopover>
    );

    return (
        <section
            aria-label={t("clock.title")}
            data-tier={tier}
            title={!native ? t("clock.offline") : undefined}
            className={cn("panel @container h-full w-full min-h-0 min-w-0 overflow-hidden", tier === "full" ? "px-3 py-1.5" : tier === "compact" ? "px-2 py-1" : "px-1 py-0")}
        >
            {tier === "full" && (
                <div className="grid h-full min-h-0 content-center gap-1">
                    <motion.div {...lay("top")} className="flex min-w-0 items-center gap-2">
                        <span className="hidden shrink-0 text-[10px] tracking-[0.12em] text-[var(--fg-dim)] @min-[420px]:inline">{t("clock.title")}</span>
                        <ClockSourceControls deckCount={deckCount} />
                        <span className="ml-auto" />
                        {bpmText(true)}
                    </motion.div>
                    <motion.div {...lay("cells")} className="flex min-w-0 items-center">
                        {cells}
                    </motion.div>
                    {!native && <span className="sr-only">{t("clock.offline")}</span>}
                </div>
            )}
            {tier === "compact" && (
                <motion.div {...lay("top")} className="flex h-full min-h-0 min-w-0 items-center gap-2">
                    {bpmText(false)}
                    {cells}
                    {sourcePopover}
                </motion.div>
            )}
            {tier === "icon" && (
                <motion.div {...lay("top")} className="flex h-full min-h-0 min-w-0 items-center">
                    <MorePopover
                        label={`${t("clock.title")}: ${liveBpm} BPM · ${phaseLabel}`}
                        title={t("clock.title")}
                        contentClassName="w-auto"
                        triggerClassName="mono flex h-full min-h-6 w-full min-w-0 items-center justify-center rounded-md text-[13px] font-extrabold focus-visible:outline-2 focus-visible:outline-[var(--ring)]"
                        triggerContent={liveBpm}
                    >
                        <div className="flex flex-wrap items-center gap-2">
                            <ClockSourceControls deckCount={deckCount} />
                        </div>
                        <div className="w-40">{cells}</div>
                        {!native && <p className="m-0 text-[10px] text-[var(--fg-dim)]">{t("clock.offline")}</p>}
                    </MorePopover>
                </motion.div>
            )}
        </section>
    );
}
