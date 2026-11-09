import { useEffect, useState } from "react";
import { Check, RefreshCw } from "lucide-react";
import { engine } from "@/bridge/engine";
import { subscribeMidiLearn, type MidiLearnEvent } from "@/bridge/events";
import type { DeckId, MidiAction, MidiPreset } from "@/bridge/types";
import { useT } from "@/i18n";
import { exportPreset, importPreset, actionLabel, ALL_ACTIONS, controlTypeFromStatus, upsertMapping, removeMapping } from "@/lib/midi-preset";
import { DEVICE_PRESETS } from "@/lib/device-presets";
import { BindingsTable } from "./BindingsTable";
import { midiBtn, selStyle } from "./shared";

export function MidiSection() {
    const t = useT();
    const [inputs, setInputs] = useState<string[]>([]);
    const [connected, setConnected] = useState<string | null>(null);
    const [learn, setLearn] = useState(false);
    const [lastLearn, setLastLearn] = useState<MidiLearnEvent | null>(null);
    const [preset, setPreset] = useState<MidiPreset | null>(null);
    const [importText, setImportText] = useState("");
    const [importError, setImportError] = useState(false);
    const [copied, setCopied] = useState(false);
    /** Action/deck selected in the bind editor for the captured control. */
    const [bindAction, setBindAction] = useState<MidiAction>("play");
    const [bindDeck, setBindDeck] = useState<DeckId | "">("a");

    const refresh = async () => {
        const list = await engine.listMidiInputs();
        setInputs(list ?? []);
    };

    const loadPreset = async () => {
        const p = await engine.midiGetPreset();
        if (p) setPreset(p);
    };

    useEffect(() => {
        void refresh();
        void loadPreset();
        let unlisten: (() => void) | undefined;
        void subscribeMidiLearn((e) => setLastLearn(e)).then((u) => (unlisten = u));
        return () => unlisten?.();
    }, []);

    const connect = async (name: string) => {
        const port = await engine.midiConnect(name);
        setConnected(port ?? name);
        // The native side may auto-pick a device preset on connect.
        void loadPreset();
    };

    const disconnect = async () => {
        await engine.midiDisconnect();
        setConnected(null);
    };

    const toggleLearn = async () => {
        const next = !learn;
        setLearn(next);
        if (next) setLastLearn(null);
        await engine.midiSetLearn(next);
    };

    /** Persist a preset change to the engine (live) and reflect it locally. */
    const persistPreset = async (next: MidiPreset) => {
        setPreset(next);
        await engine.midiSetPreset(next);
    };

    /** Bind the most-recently-touched control to the chosen action/deck. */
    const bindLearned = async () => {
        if (!lastLearn) return;
        const base: MidiPreset = preset ?? { name: "Custom mapping", mappings: [] };
        const next = upsertMapping(base, {
            status: lastLearn.status,
            midino: lastLearn.midino,
            action: bindAction,
            deck: bindDeck === "" ? null : bindDeck,
            type: controlTypeFromStatus(lastLearn.status),
        });
        await persistPreset(next);
        setLastLearn(null);
    };

    const deleteBinding = async (index: number) => {
        if (!preset) return;
        await persistPreset(removeMapping(preset, index));
    };

    /** Apply a built-in device preset by name. */
    const applyDevicePreset = async (name: string) => {
        const dev = DEVICE_PRESETS.find((p) => p.name === name);
        if (dev) await persistPreset({ name: dev.name, mappings: dev.mappings });
    };

    const copyShare = async () => {
        if (!preset) return;
        try {
            await navigator.clipboard.writeText(exportPreset(preset));
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch {
            /* clipboard may be blocked; non-fatal */
        }
    };

    const doImport = async () => {
        const parsed = importPreset(importText.trim());
        if (!parsed) {
            setImportError(true);
            return;
        }
        await engine.midiSetPreset(parsed);
        setPreset(parsed);
        setImportText("");
        setImportError(false);
    };

    return (
        <div style={{ display: "grid", gap: 10 }}>
            {inputs.length === 0 ? (
                <p style={{ fontSize: 12, color: "var(--fg-dim)" }}>
                    No MIDI inputs found. Connect a controller (DDJ-FLX4 auto-maps) and refresh.
                </p>
            ) : (
                <div style={{ display: "grid", gap: 6 }}>
                    {inputs.map((name) => (
                        <div
                            key={name}
                            style={{
                                display: "flex",
                                justifyContent: "space-between",
                                alignItems: "center",
                                padding: "8px 10px",
                                borderRadius: 8,
                                background: "var(--bg-elev)",
                                fontSize: 13,
                            }}
                        >
                            <span>{name}</span>
                            {connected === name ? (
                                <button onClick={() => void disconnect()} style={midiBtn(true)}>
                                    <Check size={12} aria-hidden /> Connected
                                </button>
                            ) : (
                                <button onClick={() => void connect(name)} style={midiBtn(false)}>
                                    Connect
                                </button>
                            )}
                        </div>
                    ))}
                </div>
            )}

            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <label style={{ fontSize: 12, color: "var(--fg-dim)" }}>Device preset</label>
                <select
                    value={preset && DEVICE_PRESETS.some((p) => p.name === preset.name) ? preset.name : ""}
                    onChange={(e) => void applyDevicePreset(e.target.value)}
                    style={selStyle}
                >
                    <option value="" disabled>
                        Choose a controller…
                    </option>
                    {DEVICE_PRESETS.map((p) => (
                        <option key={p.name} value={p.name}>
                            {p.name}
                        </option>
                    ))}
                </select>
            </div>

            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <button onClick={() => void refresh()} style={midiBtn(false)}>
                    <RefreshCw size={12} aria-hidden /> {t("settings.refresh")}
                </button>
                <button onClick={() => void toggleLearn()} style={midiBtn(learn)}>
                    {learn ? "Learn… (touch a control)" : "MIDI Learn"}
                </button>
            </div>

            {learn && (
                <div
                    style={{
                        display: "grid",
                        gap: 8,
                        padding: 10,
                        borderRadius: 10,
                        border: "1px dashed var(--accent)",
                        background: "var(--bg-elev)",
                    }}
                >
                    {lastLearn ? (
                        <>
                            <span className="mono" style={{ fontSize: 11, color: "var(--fg-dim)" }}>
                                Captured: {controlTypeFromStatus(lastLearn.status) === "cc" ? "CC" : "Note"}{" "}
                                {lastLearn.midino} · 0x{lastLearn.status.toString(16)} · val {lastLearn.value}
                            </span>
                            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                                <select
                                    value={bindAction}
                                    onChange={(e) => setBindAction(e.target.value as MidiAction)}
                                    style={selStyle}
                                >
                                    {ALL_ACTIONS.map((a) => (
                                        <option key={a} value={a}>
                                            {actionLabel(a)}
                                        </option>
                                    ))}
                                </select>
                                <select
                                    value={bindDeck}
                                    onChange={(e) => setBindDeck(e.target.value as DeckId | "")}
                                    style={selStyle}
                                >
                                    <option value="a">Deck A</option>
                                    <option value="b">Deck B</option>
                                    <option value="c">Deck C</option>
                                    <option value="d">Deck D</option>
                                    <option value="">Master / global</option>
                                </select>
                                <button onClick={() => void bindLearned()} style={midiBtn(true)}>
                                    Bind
                                </button>
                            </div>
                        </>
                    ) : (
                        <span style={{ fontSize: 11, color: "var(--fg-dim)" }}>
                            Touch a control on your device to capture it…
                        </span>
                    )}
                </div>
            )}

            {preset && (
                <div
                    style={{
                        display: "grid",
                        gap: 8,
                        padding: 12,
                        borderRadius: 12,
                        border: "1px solid var(--border)",
                        background: "var(--bg-elev)",
                    }}
                >
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ fontSize: 12, fontWeight: 700, marginRight: "auto" }}>
                            {preset.name}
                        </span>
                        <span className="mono" style={{ fontSize: 11, color: "var(--fg-dim)" }}>
                            {preset.mappings.length} bindings
                        </span>
                        <button onClick={() => void copyShare()} style={midiBtn(false)}>
                            {copied ? <><Check size={11} aria-hidden /> Copied</> : "Share"}
                        </button>
                    </div>
                    <BindingsTable preset={preset} onDelete={(i) => void deleteBinding(i)} />
                    <div style={{ display: "flex", gap: 8 }}>
                        <input
                            value={importText}
                            onChange={(e) => {
                                setImportText(e.target.value);
                                setImportError(false);
                            }}
                            placeholder="Paste a shared mapping code…"
                            style={{
                                flex: 1,
                                fontSize: 11,
                                padding: "6px 8px",
                                borderRadius: 8,
                                background: "var(--bg-elev-2)",
                                border: `1px solid ${importError ? "var(--danger)" : "var(--border)"}`,
                                color: "var(--fg)",
                            }}
                        />
                        <button
                            onClick={() => void doImport()}
                            disabled={!importText.trim()}
                            style={midiBtn(false)}
                        >
                            Import
                        </button>
                    </div>
                    {importError && (
                        <span style={{ fontSize: 11, color: "var(--danger)" }}>
                            That doesn't look like a valid mapping code.
                        </span>
                    )}
                </div>
            )}
        </div>
    );
}
