import { engine } from "@/bridge/engine";
import { useMixerStore } from "@/state/mixer-store";

export function Crossfader() {
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

    return (
        <div className="panel" style={{ padding: 14, display: "grid", gap: 12, alignContent: "center" }}>
            <div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--fg-dim)" }}>
                    <span style={{ color: "var(--accent-deck-a)" }}>A</span>
                    <span>CROSSFADER</span>
                    <span style={{ color: "var(--accent-deck-b)" }}>B</span>
                </div>
                <input
                    type="range"
                    min={-1}
                    max={1}
                    step={0.01}
                    value={crossfader}
                    onChange={(e) => setX(Number(e.target.value))}
                    onDoubleClick={() => setX(0)}
                    style={{ width: "100%" }}
                />
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 10, alignItems: "center" }}>
                <div>
                    <div style={{ fontSize: 10, color: "var(--fg-dim)" }}>MASTER</div>
                    <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.01}
                        value={masterVolume}
                        onChange={(e) => setMaster(Number(e.target.value))}
                        style={{ width: "100%" }}
                    />
                </div>
                <div style={{ width: 8, height: 40, background: "var(--bg-elev-2)", borderRadius: 4, overflow: "hidden", position: "relative" }}>
                    <div
                        style={{
                            position: "absolute",
                            bottom: 0,
                            left: 0,
                            right: 0,
                            height: `${Math.min(1, masterVu) * 100}%`,
                            background: "linear-gradient(0deg, var(--good), var(--danger))",
                        }}
                    />
                </div>
            </div>
        </div>
    );
}
