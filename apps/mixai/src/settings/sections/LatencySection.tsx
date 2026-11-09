import { useEffect, useState } from "react";
import { useT } from "@/i18n";
import { usePerfStore } from "@/state/perf-store";
import { MAX_COMP_MS } from "@/lib/perf";
import type { RoutingConfig } from "@/bridge/types";

type LatencyKey = "masterLatencyMs" | "headphoneLatencyMs" | "boothLatencyMs";

/** Per-output latency compensation (ms), WP19-06 routing. */
export function LatencySection() {
    const t = useT();
    const routing = usePerfStore((s) => s.routing);
    const patchRouting = usePerfStore((s) => s.patchRouting);
    const loadRouting = usePerfStore((s) => s.loadRouting);
    useEffect(() => {
        void loadRouting();
    }, [loadRouting]);

    const rows: { key: LatencyKey; label: string }[] = [
        { key: "masterLatencyMs", label: t("settings.latencyMaster") },
        { key: "headphoneLatencyMs", label: t("settings.latencyPhones") },
        { key: "boothLatencyMs", label: t("settings.latencyBooth") },
    ];

    return (
        <div style={{ display: "grid", gap: 8 }}>
            {rows.map(({ key, label }) => (
                <LatencyField key={key} label={label} value={routing[key]} onCommit={(v) => patchRouting({ [key]: v } as Partial<RoutingConfig>)} />
            ))}
            <p style={{ fontSize: 11, color: "var(--fg-dim)", margin: 0 }}>{t("settings.latencyHint", { max: MAX_COMP_MS })}</p>
        </div>
    );
}

function LatencyField({ label, value, onCommit }: { label: string; value: number; onCommit: (v: number) => void }) {
    const [draft, setDraft] = useState(String(Math.round(value)));
    useEffect(() => setDraft(String(Math.round(value))), [value]);
    const commit = () => {
        const v = Number(draft.replace(",", "."));
        if (Number.isFinite(v)) onCommit(Math.max(0, Math.min(MAX_COMP_MS, v)));
        else setDraft(String(Math.round(value)));
    };
    return (
        <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, fontSize: 13 }}>
            <span>{label}</span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <input
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={MAX_COMP_MS}
                    step={1}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={commit}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") commit();
                    }}
                    className="mono"
                    style={{
                        width: 80,
                        background: "var(--bg-elev-2)",
                        color: "var(--fg)",
                        border: "1px solid var(--border)",
                        borderRadius: 8,
                        padding: "6px 8px",
                        fontSize: 13,
                    }}
                />
                <span aria-hidden style={{ color: "var(--fg-dim)", fontSize: 12 }}>ms</span>
            </span>
        </label>
    );
}
