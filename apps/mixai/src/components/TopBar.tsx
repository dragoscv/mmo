import { useMixerStore } from "@/state/mixer-store";
import { useUiStore } from "@/state/ui-store";
import { THEMES, type ThemeId } from "@/themes/themes";
import { engine } from "@/bridge/engine";
import { useEffect, useRef, useState } from "react";

export function TopBar() {
    const native = useMixerStore((s) => s.native);
    const latencyMs = useMixerStore((s) => s.latencyMs);
    const sampleRate = useMixerStore((s) => s.sampleRate);
    const theme = useUiStore((s) => s.theme);
    const setTheme = useUiStore((s) => s.setTheme);
    const deckCount = useUiStore((s) => s.deckCount);
    const setDeckCount = useUiStore((s) => s.setDeckCount);
    const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
    const setShortcutsOpen = useUiStore((s) => s.setShortcutsOpen);

    return (
        <div className="panel" style={{ padding: "8px 14px", display: "flex", alignItems: "center", gap: 14 }}>
            <strong style={{ fontSize: 18, letterSpacing: "0.18em", background: "linear-gradient(90deg,var(--accent),var(--accent-2))", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
                MIXAI
            </strong>

            <span
                style={{
                    fontSize: 10,
                    padding: "2px 8px",
                    borderRadius: 99,
                    background: native ? "var(--good)" : "var(--warn)",
                    color: "#000",
                    fontWeight: 700,
                }}
            >
                {native ? "AUDIO CORE" : "UI PREVIEW"}
            </span>

            {native && (
                <span className="mono" style={{ fontSize: 11, color: "var(--fg-dim)" }}>
                    {(sampleRate / 1000).toFixed(1)} kHz · {latencyMs.toFixed(1)} ms
                </span>
            )}

            <div style={{ flex: 1 }} />

            {native && <RecordButton />}

            <Segmented
                options={[
                    { id: "2", label: "2 DECK" },
                    { id: "4", label: "4 DECK" },
                ]}
                value={String(deckCount)}
                onChange={(v) => setDeckCount(v === "4" ? 4 : 2)}
            />

            <select
                value={theme}
                onChange={(e) => setTheme(e.target.value as ThemeId)}
                style={{
                    background: "var(--bg-elev-2)",
                    color: "var(--fg)",
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    padding: "6px 8px",
                    fontSize: 12,
                }}
            >
                {Object.values(THEMES).map((t) => (
                    <option key={t.id} value={t.id}>
                        {t.name}
                    </option>
                ))}
            </select>

            <button
                onClick={() => setShortcutsOpen(true)}
                title="Keyboard shortcuts (press ?)"
                style={{ padding: "6px 12px", borderRadius: 8, background: "var(--bg-elev-2)", fontSize: 12 }}
            >
                ⌨ Keys
            </button>

            <button
                onClick={() => setSettingsOpen(true)}
                style={{ padding: "6px 12px", borderRadius: 8, background: "var(--bg-elev-2)", fontSize: 12 }}
            >
                ⚙ Settings
            </button>
        </div>
    );
}

function RecordButton() {
    const [recording, setRecording] = useState(false);
    const [elapsed, setElapsed] = useState(0);
    const [busy, setBusy] = useState(false);
    const startedAt = useRef<number>(0);

    useEffect(() => {
        if (!recording) return;
        const id = setInterval(() => {
            setElapsed((Date.now() - startedAt.current) / 1000);
        }, 250);
        return () => clearInterval(id);
    }, [recording]);

    async function toggle() {
        if (busy) return;
        setBusy(true);
        try {
            if (recording) {
                await engine.stopRecording();
                setRecording(false);
                setElapsed(0);
            } else {
                const path = await engine.startRecording();
                if (path) {
                    startedAt.current = Date.now();
                    setElapsed(0);
                    setRecording(true);
                }
            }
        } finally {
            setBusy(false);
        }
    }

    const mm = Math.floor(elapsed / 60)
        .toString()
        .padStart(2, "0");
    const ss = Math.floor(elapsed % 60)
        .toString()
        .padStart(2, "0");

    return (
        <button
            onClick={toggle}
            disabled={busy}
            title={recording ? "Stop recording" : "Record master mix to WAV"}
            style={{
                display: "flex",
                alignItems: "center",
                gap: 7,
                padding: "6px 12px",
                borderRadius: 8,
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: "0.06em",
                background: recording ? "var(--danger, #e2354a)" : "var(--bg-elev-2)",
                color: recording ? "#fff" : "var(--fg-dim)",
                border: recording ? "1px solid transparent" : "1px solid var(--border)",
                cursor: busy ? "wait" : "pointer",
            }}
        >
            <span
                style={{
                    width: 9,
                    height: 9,
                    borderRadius: 99,
                    background: recording ? "#fff" : "var(--danger, #e2354a)",
                    boxShadow: recording ? "0 0 8px #fff" : "none",
                    animation: recording ? "mixai-rec-pulse 1s ease-in-out infinite" : "none",
                }}
            />
            {recording ? (
                <span className="mono">{`${mm}:${ss}`}</span>
            ) : (
                <span>REC</span>
            )}
        </button>
    );
}

function Segmented({
    options,
    value,
    onChange,
}: {
    options: { id: string; label: string }[];
    value: string;
    onChange: (v: string) => void;
}) {
    return (
        <div style={{ display: "flex", background: "var(--bg-elev-2)", borderRadius: 8, padding: 2 }}>
            {options.map((o) => (
                <button
                    key={o.id}
                    onClick={() => onChange(o.id)}
                    style={{
                        padding: "5px 10px",
                        borderRadius: 6,
                        fontSize: 11,
                        fontWeight: 700,
                        background: value === o.id ? "var(--accent)" : "transparent",
                        color: value === o.id ? "#000" : "var(--fg-dim)",
                    }}
                >
                    {o.label}
                </button>
            ))}
        </div>
    );
}
