import { useAutoMixStore } from "@/state/auto-mix-store";

/**
 * Auto-mix control surface — the "AI DJ". Arms a frontend orchestrator that
 * beat-syncs the idle deck and crossfades into it a few seconds before the
 * on-air track ends. All knobs are live; "Mix now" forces the next blend.
 */
export function AutoMixPanel() {
    const enabled = useAutoMixStore((s) => s.enabled);
    const crossfadeSec = useAutoMixStore((s) => s.crossfadeSec);
    const leadSec = useAutoMixStore((s) => s.leadSec);
    const autoSync = useAutoMixStore((s) => s.autoSync);
    const autoQueue = useAutoMixStore((s) => s.autoQueue);
    const status = useAutoMixStore((s) => s.status);
    const mixing = useAutoMixStore((s) => s.mixing);
    const onAir = useAutoMixStore((s) => s.onAir);
    const setEnabled = useAutoMixStore((s) => s.setEnabled);
    const setCrossfadeSec = useAutoMixStore((s) => s.setCrossfadeSec);
    const setLeadSec = useAutoMixStore((s) => s.setLeadSec);
    const setAutoSync = useAutoMixStore((s) => s.setAutoSync);
    const setAutoQueue = useAutoMixStore((s) => s.setAutoQueue);
    const mixNow = useAutoMixStore((s) => s.mixNow);

    return (
        <div style={{ display: "grid", gap: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 10, color: "var(--fg-dim)", letterSpacing: "0.12em", marginRight: "auto" }}>
                    ✦ AUTO-MIX
                </span>
                <button
                    onClick={() => setEnabled(!enabled)}
                    style={{
                        fontSize: 11,
                        fontWeight: 800,
                        padding: "5px 14px",
                        borderRadius: 8,
                        letterSpacing: "0.06em",
                        background: enabled ? "var(--accent)" : "var(--bg-elev-2)",
                        color: enabled ? "#000" : "var(--fg-dim)",
                        border: "1px solid var(--border)",
                    }}
                >
                    {enabled ? "ON" : "OFF"}
                </button>
            </div>

            <div
                style={{
                    fontSize: 11,
                    color: enabled ? "var(--accent-2)" : "var(--fg-dim)",
                    minHeight: 16,
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                }}
            >
                {enabled && (
                    <span
                        style={{
                            width: 7,
                            height: 7,
                            borderRadius: "50%",
                            background: mixing ? "var(--warn)" : onAir === "a" ? "var(--accent-deck-a)" : "var(--accent-deck-b)",
                            boxShadow: "var(--glow) currentColor",
                        }}
                    />
                )}
                {status}
            </div>

            <Knob label="Crossfade" value={crossfadeSec} min={2} max={30} step={1} unit="s" onChange={setCrossfadeSec} />
            <Knob label="Lead-in" value={leadSec} min={4} max={40} step={1} unit="s" onChange={setLeadSec} />

            <div style={{ display: "flex", gap: 8 }}>
                <button
                    onClick={() => setAutoSync(!autoSync)}
                    title="Beat-sync the incoming deck before the blend"
                    style={{
                        flex: 1,
                        fontSize: 10,
                        fontWeight: 700,
                        padding: "6px 8px",
                        borderRadius: 7,
                        background: autoSync ? "var(--accent)" : "var(--bg-elev-2)",
                        color: autoSync ? "#000" : "var(--fg-dim)",
                        border: "1px solid var(--border)",
                    }}
                >
                    BEAT-SYNC {autoSync ? "ON" : "OFF"}
                </button>
                <button
                    onClick={() => setAutoQueue(!autoQueue)}
                    title="Auto-load the best harmonic match from the muzicai.ro library onto the idle deck"
                    style={{
                        flex: 1,
                        fontSize: 10,
                        fontWeight: 700,
                        padding: "6px 8px",
                        borderRadius: 7,
                        background: autoQueue ? "var(--accent)" : "var(--bg-elev-2)",
                        color: autoQueue ? "#000" : "var(--fg-dim)",
                        border: "1px solid var(--border)",
                    }}
                >
                    AUTO-QUEUE {autoQueue ? "ON" : "OFF"}
                </button>
                <button
                    onClick={mixNow}
                    disabled={!enabled || mixing}
                    title="Trigger the next transition immediately"
                    style={{
                        flex: 1,
                        fontSize: 10,
                        fontWeight: 700,
                        padding: "6px 8px",
                        borderRadius: 7,
                        background: "var(--bg-elev-2)",
                        color: !enabled || mixing ? "var(--fg-dim)" : "var(--fg)",
                        border: "1px solid var(--border)",
                        opacity: !enabled || mixing ? 0.5 : 1,
                    }}
                >
                    MIX NOW ►
                </button>
            </div>
        </div>
    );
}

function Knob({
    label,
    value,
    min,
    max,
    step,
    unit,
    onChange,
}: {
    label: string;
    value: number;
    min: number;
    max: number;
    step: number;
    unit: string;
    onChange: (v: number) => void;
}) {
    return (
        <label style={{ display: "grid", gap: 3 }}>
            <span style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--fg-dim)" }}>
                <span>{label}</span>
                <span className="mono" style={{ color: "var(--fg)" }}>
                    {value}
                    {unit}
                </span>
            </span>
            <input
                type="range"
                min={min}
                max={max}
                step={step}
                value={value}
                onChange={(e) => onChange(Number(e.target.value))}
                style={{ width: "100%" }}
            />
        </label>
    );
}
