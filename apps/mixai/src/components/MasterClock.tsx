import { useEffect, useState } from "react";
import type { ClockSource } from "@/bridge/types";
import { useMixerStore } from "@/state/mixer-store";
import { usePerfStore } from "@/state/perf-store";
import { useClockPoll } from "@/lib/use-clock-poll";
import { beatInBar } from "@/lib/perf";
import { useT } from "@/i18n";

const SOURCES: readonly ClockSource[] = ["auto", "internal", "a", "b", "c", "d"];

/**
 * Master clock: source selector (auto / internal + bpm / deck A–D), live bpm
 * and a beat/bar phase indicator. Owns the ≤30 Hz `engine_clock_state` poll.
 * The phase sweep is decorative and disappears under reduced motion (the
 * discrete beat cells still show the position) — see `.mixai-phase` in CSS.
 */
export function MasterClock({ deckCount }: { deckCount: 2 | 4 }) {
    useClockPoll();
    const t = useT();
    const native = useMixerStore((s) => s.native);
    const clock = usePerfStore((s) => s.clock);
    const source = usePerfStore((s) => s.clockSource);
    const internalBpm = usePerfStore((s) => s.internalBpm);
    const setClockSource = usePerfStore((s) => s.setClockSource);
    const setInternalBpm = usePerfStore((s) => s.setInternalBpm);
    const [bpmDraft, setBpmDraft] = useState(internalBpm.toFixed(1));

    useEffect(() => setBpmDraft(internalBpm.toFixed(1)), [internalBpm]);

    const sources = SOURCES.filter((s) => deckCount === 4 || (s !== "c" && s !== "d"));
    const bpb = clock?.beatsPerBar && clock.beatsPerBar > 0 ? clock.beatsPerBar : 4;
    const beat = beatInBar(clock);
    const phase = clock ? Math.max(0, Math.min(1, clock.beatPhase)) : 0;
    const liveBpm = clock && clock.bpm > 0 ? clock.bpm.toFixed(1) : "--";
    const drivenBy = clock?.source ? (clock.source === "internal" ? t("clock.internal") : clock.source.toUpperCase()) : "—";

    const commitBpm = () => {
        const v = Number(bpmDraft.replace(",", "."));
        if (Number.isFinite(v) && v >= 20 && v <= 300) setInternalBpm(v);
        else setBpmDraft(internalBpm.toFixed(1));
    };

    return (
        <section className="panel" aria-label={t("clock.title")} style={{ padding: "8px 12px", display: "grid", gap: 6 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span style={{ fontSize: 10, color: "var(--fg-dim)", letterSpacing: "0.12em" }}>{t("clock.title")}</span>
                <label style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10 }}>
                    <span className="sr-only">{t("clock.source")}</span>
                    <select
                        value={source}
                        onChange={(e) => setClockSource(e.target.value as ClockSource)}
                        style={{
                            background: "var(--bg-elev-2)",
                            color: "var(--fg)",
                            border: "1px solid var(--border)",
                            borderRadius: 6,
                            padding: "3px 6px",
                            fontSize: 11,
                            fontWeight: 700,
                        }}
                    >
                        {sources.map((s) => (
                            <option key={s} value={s}>
                                {s === "auto" ? t("clock.auto") : s === "internal" ? t("clock.internal") : t("clock.deck", { id: s.toUpperCase() })}
                            </option>
                        ))}
                    </select>
                </label>
                {source === "internal" && (
                    <label style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10 }}>
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
                            className="mono"
                            style={{
                                width: 64,
                                background: "var(--bg-elev-2)",
                                color: "var(--fg)",
                                border: "1px solid var(--border)",
                                borderRadius: 6,
                                padding: "3px 6px",
                                fontSize: 11,
                            }}
                        />
                        <span aria-hidden style={{ color: "var(--fg-dim)" }}>BPM</span>
                    </label>
                )}
                <span
                    className="mono"
                    aria-live="off"
                    title={t("clock.liveHint", { source: drivenBy })}
                    style={{ marginLeft: "auto", fontSize: 16, fontWeight: 800 }}
                >
                    {liveBpm}
                    <span style={{ fontSize: 9, color: "var(--fg-dim)", marginLeft: 3 }}>BPM · {drivenBy}</span>
                </span>
            </div>

            <div
                role="img"
                aria-label={
                    native && beat !== null
                        ? t("clock.phaseAria", { beat: beat + 1, bar: bpb })
                        : t("clock.offline")
                }
                style={{ display: "grid", gap: 3 }}
            >
                <div style={{ display: "grid", gridTemplateColumns: `repeat(${bpb}, 1fr)`, gap: 3 }}>
                    {Array.from({ length: bpb }, (_, i) => (
                        <span
                            key={i}
                            data-on={beat === i ? "true" : "false"}
                            data-downbeat={i === 0 ? "true" : "false"}
                            className="mixai-beat-cell"
                        />
                    ))}
                </div>
                <div className="mixai-phase" aria-hidden>
                    <span style={{ transform: `scaleX(${phase})` }} />
                </div>
            </div>
            {!native && <p style={{ fontSize: 10, color: "var(--fg-dim)", margin: 0 }}>{t("clock.offline")}</p>}
        </section>
    );
}
