import { engine } from "@/bridge/engine";
import { NUM_PADS, useSamplerStore } from "@/state/sampler-store";

/** Filename → display stem (drop directory + extension). */
function stem(path: string): string {
    const base = path.split(/[\\/]/).pop() ?? path;
    const dot = base.lastIndexOf(".");
    return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * One-shot sampler: an 8-pad bank. Click a loaded pad to trigger it from the
 * start (re-trigger restarts). Load samples via the pad's ⊕ button, toggle
 * loop, set per-pad gain, or clear. Pads mix straight into the master bus.
 */
export function SamplerPanel({ accent }: { accent: string }) {
    const pads = useSamplerStore((s) => s.pads);
    const setPad = useSamplerStore((s) => s.setPad);

    const loadPad = async (idx: number) => {
        const path = await engine.pickAudioFile();
        if (!path) return;
        await engine.samplerLoad(idx, path);
        setPad(idx, { loaded: true, label: stem(path), path });
        // Push the current gain so the engine matches the UI.
        const g = pads[idx]?.gain ?? 0.85;
        void engine.samplerSetGain(idx, g);
    };

    const trigger = (idx: number) => {
        if (pads[idx]?.loaded) void engine.samplerTrigger(idx);
    };

    const clear = (idx: number) => {
        void engine.samplerClear(idx);
        setPad(idx, { loaded: false, label: null, path: null });
    };

    const toggleLoop = (idx: number) => {
        const next = !(pads[idx]?.looping ?? false);
        setPad(idx, { looping: next });
        void engine.samplerSetLooping(idx, next);
    };

    const setGain = (idx: number, v: number) => {
        setPad(idx, { gain: v });
        void engine.samplerSetGain(idx, v);
    };

    return (
        <div style={{ display: "grid", gap: 8 }}>
            <span style={{ fontSize: 10, color: "var(--fg-dim)", letterSpacing: "0.12em" }}>SAMPLER</span>
            <div style={{ display: "grid", gridTemplateColumns: `repeat(${NUM_PADS / 2}, 1fr)`, gap: 8 }}>
                {Array.from({ length: NUM_PADS }, (_, idx) => {
                    const pad = pads[idx];
                    const loaded = pad?.loaded ?? false;
                    const looping = pad?.looping ?? false;
                    const gain = pad?.gain ?? 0.85;
                    return (
                        <div
                            key={idx}
                            style={{
                                display: "grid",
                                gap: 4,
                                padding: 8,
                                borderRadius: 10,
                                background: "var(--bg-elev-1)",
                                border: `1px solid ${loaded ? accent : "var(--border)"}`,
                                transition: "border-color 150ms ease",
                            }}
                        >
                            <button
                                onClick={() => trigger(idx)}
                                disabled={!loaded}
                                title={loaded ? `Trigger ${pad?.label}` : "Empty pad — load a sample"}
                                style={{
                                    height: 44,
                                    borderRadius: 8,
                                    fontSize: 11,
                                    fontWeight: 700,
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                    whiteSpace: "nowrap",
                                    background: loaded ? accent : "var(--bg-elev-2)",
                                    color: loaded ? "#000" : "var(--fg-dim)",
                                    cursor: loaded ? "pointer" : "default",
                                }}
                            >
                                {loaded ? pad?.label : `PAD ${idx + 1}`}
                            </button>

                            <input
                                type="range"
                                min={0}
                                max={1.5}
                                step={0.01}
                                value={gain}
                                title="Pad gain"
                                disabled={!loaded}
                                onChange={(e) => setGain(idx, Number(e.target.value))}
                                style={{ width: "100%", accentColor: accent }}
                            />

                            <div style={{ display: "flex", gap: 3, justifyContent: "space-between" }}>
                                <button
                                    onClick={() => void loadPad(idx)}
                                    title="Load a sample into this pad"
                                    style={{
                                        flex: 1,
                                        padding: "3px 0",
                                        borderRadius: 5,
                                        fontSize: 9,
                                        fontWeight: 700,
                                        background: "var(--bg-elev-2)",
                                        color: "var(--fg-dim)",
                                    }}
                                >
                                    ⊕
                                </button>
                                <button
                                    onClick={() => toggleLoop(idx)}
                                    disabled={!loaded}
                                    title="Toggle loop"
                                    style={{
                                        flex: 1,
                                        padding: "3px 0",
                                        borderRadius: 5,
                                        fontSize: 9,
                                        fontWeight: 700,
                                        background: looping ? accent : "var(--bg-elev-2)",
                                        color: looping ? "#000" : "var(--fg-dim)",
                                    }}
                                >
                                    ↻
                                </button>
                                <button
                                    onClick={() => clear(idx)}
                                    disabled={!loaded}
                                    title="Clear pad"
                                    style={{
                                        flex: 1,
                                        padding: "3px 0",
                                        borderRadius: 5,
                                        fontSize: 9,
                                        fontWeight: 700,
                                        background: "var(--bg-elev-2)",
                                        color: "var(--fg-dim)",
                                    }}
                                >
                                    ✕
                                </button>
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
