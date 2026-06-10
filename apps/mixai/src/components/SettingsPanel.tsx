import { useEffect, useState } from "react";
import { engine } from "@/bridge/engine";
import type { AudioDevice } from "@/bridge/types";
import { subscribeMidiLearn, type MidiLearnEvent } from "@/bridge/events";
import { subscribeHidInput } from "@/bridge/events";
import { useUiStore } from "@/state/ui-store";
import { THEMES, EDITABLE_TOKENS, exportTheme, isCustomThemeId } from "@/themes/themes";
import { useCompanionStore } from "@/state/companion-store";
import type { CompanionStatus, DeckId, HidDeviceInfo, HidInputEvent, MidiAction, MidiPreset } from "@/bridge/types";
import {
    exportPreset,
    importPreset,
    actionLabel,
    ALL_ACTIONS,
    controlTypeFromStatus,
    upsertMapping,
    removeMapping,
} from "@/lib/midi-preset";
import { DEVICE_PRESETS } from "@/lib/device-presets";
import { exportProfile, importProfile } from "@/lib/profile";
import { PluginManager } from "@/plugins/host";
import { usePluginStore } from "@/plugins/plugin-store";
import { useHidStore } from "@/state/hid-store";
import { useKeybindStore } from "@/state/keybind-store";
import {
    ALL_HID_ACTIONS,
    hidActionLabel,
    exportHidPreset,
    importHidPreset,
    type HidAction,
} from "@/lib/hid-mapping";
import { HID_DEVICE_PRESETS, presetForDevice } from "@/lib/hid-device-presets";
import { resetHidFeedback } from "@/lib/hid-feedback";

export function SettingsPanel() {
    const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
    const [devices, setDevices] = useState<AudioDevice[]>([]);

    useEffect(() => {
        void (async () => {
            const d = await engine.listAudioDevices();
            if (d) setDevices(d);
        })();
    }, []);

    return (
        <div
            onClick={() => setSettingsOpen(false)}
            style={{
                position: "fixed",
                inset: 0,
                background: "rgba(0,0,0,0.5)",
                display: "grid",
                placeItems: "center",
                zIndex: 50,
            }}
        >
            <div
                className="panel"
                onClick={(e) => e.stopPropagation()}
                style={{ padding: 20, width: 520, maxHeight: "80vh", overflowY: "auto", display: "grid", gap: 18 }}
            >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <h2 style={{ fontSize: 18 }}>Settings</h2>
                    <button onClick={() => setSettingsOpen(false)} style={{ fontSize: 20, color: "var(--fg-dim)" }}>
                        ✕
                    </button>
                </div>

                <Section title="Theme">
                    <ThemeSection />
                </Section>

                <Section title="Audio output (master)">
                    <DeviceSelect
                        devices={devices}
                        onChange={(id) => void engine.setOutputDevice(id)}
                    />
                </Section>

                <Section title="Headphone cue output">
                    <DeviceSelect devices={devices} onChange={(id) => void engine.setCueDevice(id)} />
                </Section>

                <Section title="MIDI controllers">
                    <MidiSection />
                </Section>

                <Section title="HID controllers">
                    <HidSection />
                </Section>

                <Section title="muzicai.ro library">
                    <CompanionSection />
                </Section>

                <Section title="Profile backup">
                    <ProfileSection />
                </Section>

                <Section title="Plugins">
                    <PluginManager />
                </Section>

                <p style={{ fontSize: 11, color: "var(--fg-dim)" }}>
                    Settings will sync to your muzicai.ro account and restore on any device.
                </p>
            </div>
        </div>
    );
}

function DeviceSelect({
    devices,
    onChange,
}: {
    devices: AudioDevice[];
    onChange: (id: string) => void;
}) {
    if (devices.length === 0) {
        return <p style={{ fontSize: 12, color: "var(--fg-dim)" }}>No audio devices (run inside the app).</p>;
    }
    return (
        <select
            onChange={(e) => onChange(e.target.value)}
            style={{
                width: "100%",
                background: "var(--bg-elev-2)",
                color: "var(--fg)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                padding: "8px 10px",
                fontSize: 13,
            }}
        >
            {devices.map((d) => (
                <option key={d.id} value={d.id}>
                    {d.name} ({d.channels}ch){d.isDefault ? " · default" : ""}
                </option>
            ))}
        </select>
    );
}

function MidiSection() {
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
                                    Connected ✓
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
                    ↻ Refresh
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
                            {copied ? "Copied ✓" : "Share"}
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

/** Compact, scrollable list of a preset's bindings. */
function BindingsTable({
    preset,
    onDelete,
}: {
    preset: MidiPreset;
    onDelete?: (index: number) => void;
}) {
    return (
        <div style={{ maxHeight: 160, overflowY: "auto", display: "grid", gap: 2 }}>
            {preset.mappings.map((m, i) => (
                <div
                    key={`${m.status}-${m.midino}-${i}`}
                    style={{
                        display: "flex",
                        gap: 8,
                        alignItems: "center",
                        fontSize: 11,
                        padding: "3px 6px",
                        borderRadius: 6,
                        background: "var(--bg-elev-2)",
                    }}
                >
                    <span style={{ flex: 1, fontWeight: 600 }}>{actionLabel(m.action)}</span>
                    {m.deck && (
                        <span
                            className="mono"
                            style={{
                                fontSize: 10,
                                color: m.deck === "a" || m.deck === "c" ? "var(--accent-deck-a)" : "var(--accent-deck-b)",
                            }}
                        >
                            {m.deck.toUpperCase()}
                        </span>
                    )}
                    <span className="mono" style={{ fontSize: 10, color: "var(--fg-dim)" }}>
                        {m.type === "cc" ? "CC" : "Note"} {m.midino} · 0x{m.status.toString(16)}
                    </span>
                    {onDelete && (
                        <button
                            onClick={() => onDelete(i)}
                            title="Remove binding"
                            style={{
                                fontSize: 11,
                                lineHeight: 1,
                                padding: "2px 6px",
                                borderRadius: 6,
                                background: "transparent",
                                color: "var(--fg-dim)",
                                border: "1px solid var(--border)",
                                cursor: "pointer",
                            }}
                        >
                            ✕
                        </button>
                    )}
                </div>
            ))}
        </div>
    );
}

/** Export / import the full local profile (themes, layout, companion, MIDI). */
function ProfileSection() {
    const [copied, setCopied] = useState(false);
    const [importText, setImportText] = useState("");
    const [status, setStatus] = useState<"idle" | "ok" | "error">("idle");
    const [cloud, setCloud] = useState<"idle" | "saving" | "loading" | "saved" | "loaded" | "empty" | "error">("idle");
    const restoreProfile = useUiStore((s) => s.restoreProfile);
    const updateCompanion = useCompanionStore((s) => s.update);
    const cloudReady = useCompanionStore((s) => Boolean(s.deviceToken && s.userId));

    const buildJson = async (): Promise<string> => {
        const ui = useUiStore.getState();
        const comp = useCompanionStore.getState();
        const midiPreset = await engine.midiGetPreset();
        return exportProfile({
            theme: ui.theme,
            deckCount: ui.deckCount,
            customThemes: ui.customThemes,
            companion: {
                baseUrl: comp.baseUrl,
                deviceToken: comp.deviceToken,
                userId: comp.userId,
            },
            midiPreset: midiPreset ?? null,
            hidPreset: useHidStore.getState().preset,
            externalPlugins: usePluginStore.getState().externalSpecs,
            keybinds: useKeybindStore.getState().overrides,
        });
    };

    /** Apply a parsed profile patch to the live app. Shared by paste-restore
     *  and cloud-load. */
    const applyProfile = async (raw: string): Promise<boolean> => {
        const parsed = importProfile(raw.trim());
        if (!parsed) return false;
        restoreProfile({
            theme: parsed.theme as never,
            deckCount: parsed.deckCount,
            customThemes: parsed.customThemes,
        });
        if (parsed.companion) updateCompanion(parsed.companion);
        if (parsed.midiPreset) await engine.midiSetPreset(parsed.midiPreset);
        if (parsed.hidPreset) useHidStore.getState().setPreset(parsed.hidPreset);
        if (parsed.externalPlugins) {
            for (const spec of parsed.externalPlugins) {
                usePluginStore.getState().installExternal(JSON.stringify(spec));
            }
        }
        if (parsed.keybinds) useKeybindStore.getState().setOverrides(parsed.keybinds);
        return true;
    };

    const doExport = async () => {
        const json = await buildJson();
        try {
            await navigator.clipboard.writeText(json);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch {
            /* clipboard may be blocked; non-fatal */
        }
    };

    const doImport = async () => {
        const ok = await applyProfile(importText);
        if (!ok) {
            setStatus("error");
            return;
        }
        setImportText("");
        setStatus("ok");
        setTimeout(() => setStatus("idle"), 1500);
    };

    const doCloudSave = async () => {
        setCloud("saving");
        try {
            const json = await buildJson();
            await engine.companionPutProfile(json);
            setCloud("saved");
            setTimeout(() => setCloud("idle"), 1800);
        } catch {
            setCloud("error");
            setTimeout(() => setCloud("idle"), 2500);
        }
    };

    const doCloudLoad = async () => {
        setCloud("loading");
        try {
            const json = await engine.companionGetProfile();
            if (!json) {
                setCloud("empty");
                setTimeout(() => setCloud("idle"), 2500);
                return;
            }
            const ok = await applyProfile(json);
            setCloud(ok ? "loaded" : "error");
            setTimeout(() => setCloud("idle"), 1800);
        } catch {
            setCloud("error");
            setTimeout(() => setCloud("idle"), 2500);
        }
    };

    return (
        <div style={{ display: "grid", gap: 8 }}>
            <p style={{ fontSize: 12, color: "var(--fg-dim)" }}>
                Back up your themes, deck layout, library connection, MIDI + HID mappings,
                keyboard shortcuts and installed plugins to a single code — then restore
                everything on another machine.
            </p>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button onClick={() => void doExport()} style={midiBtn(false)}>
                    {copied ? "Copied ✓" : "Export profile"}
                </button>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
                <input
                    value={importText}
                    onChange={(e) => {
                        setImportText(e.target.value);
                        setStatus("idle");
                    }}
                    placeholder="Paste a profile backup code…"
                    style={{
                        flex: 1,
                        fontSize: 11,
                        padding: "6px 8px",
                        borderRadius: 8,
                        background: "var(--bg-elev-2)",
                        border: `1px solid ${status === "error" ? "var(--danger)" : "var(--border)"}`,
                        color: "var(--fg)",
                    }}
                />
                <button
                    onClick={() => void doImport()}
                    disabled={!importText.trim()}
                    style={midiBtn(false)}
                >
                    Restore
                </button>
            </div>
            {status === "error" && (
                <span style={{ fontSize: 11, color: "var(--danger)" }}>
                    That doesn't look like a valid profile backup.
                </span>
            )}
            {status === "ok" && (
                <span style={{ fontSize: 11, color: "var(--good)" }}>Profile restored ✓</span>
            )}
            <div style={{ height: 1, background: "var(--border)", margin: "4px 0" }} />
            <p style={{ fontSize: 12, color: "var(--fg-dim)" }}>
                Or sync to your account through the companion — sign in to your library
                (device token + user) in the Library tab first.
            </p>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button
                    onClick={() => void doCloudSave()}
                    disabled={!cloudReady || cloud === "saving" || cloud === "loading"}
                    style={midiBtn(false)}
                >
                    {cloud === "saving" ? "Saving…" : cloud === "saved" ? "Saved ✓" : "Save to cloud"}
                </button>
                <button
                    onClick={() => void doCloudLoad()}
                    disabled={!cloudReady || cloud === "saving" || cloud === "loading"}
                    style={midiBtn(false)}
                >
                    {cloud === "loading" ? "Loading…" : cloud === "loaded" ? "Loaded ✓" : "Load from cloud"}
                </button>
            </div>
            {!cloudReady && (
                <span style={{ fontSize: 11, color: "var(--fg-dim)" }}>
                    Connect the companion library to enable account sync.
                </span>
            )}
            {cloud === "empty" && (
                <span style={{ fontSize: 11, color: "var(--fg-dim)" }}>
                    No profile saved to your account yet — use “Save to cloud” first.
                </span>
            )}
            {cloud === "error" && (
                <span style={{ fontSize: 11, color: "var(--danger)" }}>
                    Couldn't reach your account. Check the companion connection.
                </span>
            )}
        </div>
    );
}

function midiBtn(active: boolean): React.CSSProperties {
    return {
        fontSize: 12,
        fontWeight: 700,
        padding: "6px 12px",
        borderRadius: 8,
        background: active ? "var(--accent)" : "var(--bg-elev-2)",
        color: active ? "#000" : "var(--fg)",
        border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
    };
}

function HidSection() {
    const [devices, setDevices] = useState<HidDeviceInfo[]>([]);
    const [connected, setConnected] = useState<string | null>(null);
    const [last, setLast] = useState<HidInputEvent | null>(null);
    const [busy, setBusy] = useState(false);
    const preset = useHidStore((s) => s.preset);
    const learning = useHidStore((s) => s.learning);
    const candidate = useHidStore((s) => s.candidate);
    const setLearning = useHidStore((s) => s.setLearning);
    const upsert = useHidStore((s) => s.upsert);
    const remove = useHidStore((s) => s.remove);
    const setPreset = useHidStore((s) => s.setPreset);
    const [bindAction, setBindAction] = useState<HidAction>("play");
    const [bindDeck, setBindDeck] = useState<DeckId | "">("a");
    const [importText, setImportText] = useState("");
    const [importError, setImportError] = useState(false);
    const [copied, setCopied] = useState(false);

    const refresh = async () => {
        const list = await engine.listHidDevices();
        setDevices(list ?? []);
        const open = await engine.hidOpenPath();
        setConnected(open);
    };

    useEffect(() => {
        void refresh();
        let unlisten: (() => void) | undefined;
        void subscribeHidInput((e) => setLast(e)).then((u) => (unlisten = u));
        return () => unlisten?.();
    }, []);

    const connect = async (path: string) => {
        setBusy(true);
        await engine.hidConnect(path);
        setConnected(path);
        resetHidFeedback();
        setBusy(false);
    };

    const disconnect = async () => {
        setBusy(true);
        await engine.hidDisconnect();
        setConnected(null);
        setLast(null);
        setLearning(false);
        resetHidFeedback();
        setBusy(false);
    };

    const bindCandidate = () => {
        if (!candidate) return;
        upsert({
            byteIndex: candidate.byteIndex,
            mask: candidate.mask || 0xff,
            type: candidate.type,
            action: bindAction,
            deck: bindDeck === "" ? null : bindDeck,
        });
        setLearning(false);
    };

    const copyShare = async () => {
        try {
            await navigator.clipboard.writeText(exportHidPreset(preset));
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch {
            // clipboard may be unavailable
        }
    };

    const doImport = () => {
        const p = importHidPreset(importText.trim());
        if (!p) {
            setImportError(true);
            return;
        }
        setPreset(p);
        resetHidFeedback();
        setImportText("");
        setImportError(false);
    };

    const applyDevicePreset = (name: string) => {
        const p = HID_DEVICE_PRESETS.find((x) => x.name === name);
        if (p) {
            setPreset(p);
            resetHidFeedback();
        }
    };

    /** The connected device's id, used to suggest a matching preset. */
    const connectedDevice = devices.find((d) => d.path === connected);
    const suggested = connectedDevice
        ? presetForDevice(connectedDevice.vendorId, connectedDevice.productId)
        : null;

    return (
        <div style={{ display: "grid", gap: 10 }}>
            <p style={{ fontSize: 11, color: "var(--fg-dim)" }}>
                Raw HID support for CDJs and HID-class controllers. Connect a device to
                stream its input reports — per-model jog/screen decoding lands in a later
                update.
            </p>

            {devices.length === 0 ? (
                <p style={{ fontSize: 12, color: "var(--fg-dim)" }}>No HID devices found.</p>
            ) : (
                <div style={{ display: "grid", gap: 6 }}>
                    {devices.map((d) => (
                        <div
                            key={d.path}
                            style={{
                                display: "flex",
                                justifyContent: "space-between",
                                alignItems: "center",
                                gap: 8,
                                padding: "8px 10px",
                                borderRadius: 8,
                                background: "var(--bg-elev)",
                                fontSize: 13,
                            }}
                        >
                            <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                                {d.isDjGear && <span title="Known DJ gear">🎚️</span>}
                                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                    {d.label}
                                </span>
                                <span style={{ fontSize: 10, color: "var(--fg-dim)" }}>
                                    {`0x${d.vendorId.toString(16).padStart(4, "0")}:0x${d.productId.toString(16).padStart(4, "0")}`}
                                </span>
                            </span>
                            {connected === d.path ? (
                                <button onClick={() => void disconnect()} style={midiBtn(true)} disabled={busy}>
                                    Connected ✓
                                </button>
                            ) : (
                                <button onClick={() => void connect(d.path)} style={midiBtn(false)} disabled={busy}>
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
                    value={HID_DEVICE_PRESETS.some((p) => p.name === preset.name) ? preset.name : ""}
                    onChange={(e) => applyDevicePreset(e.target.value)}
                    style={selStyle}
                >
                    <option value="" disabled>
                        Choose a device…
                    </option>
                    {HID_DEVICE_PRESETS.map((p) => (
                        <option key={p.name} value={p.name}>
                            {p.name}
                        </option>
                    ))}
                </select>
            </div>

            {suggested && preset.name !== suggested.name && (
                <button
                    onClick={() => {
                        setPreset(suggested);
                        resetHidFeedback();
                    }}
                    style={midiBtn(false)}
                >
                    Use suggested: {suggested.name}
                </button>
            )}

            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <button onClick={() => void refresh()} style={midiBtn(false)}>
                    ↻ Refresh
                </button>
                <button
                    onClick={() => setLearning(!learning)}
                    style={midiBtn(learning)}
                    disabled={!connected}
                >
                    {learning ? "Learn… (touch a control)" : "HID Learn"}
                </button>
            </div>

            {connected && !learning && (
                <div
                    style={{
                        display: "grid",
                        gap: 4,
                        padding: "8px 10px",
                        borderRadius: 8,
                        background: "var(--bg-elev)",
                    }}
                >
                    <span style={{ fontSize: 11, color: "var(--fg-dim)" }}>Last input report</span>
                    <code style={{ fontSize: 11, wordBreak: "break-all", color: "var(--fg)" }}>
                        {last ? last.hex : "— (touch a control)"}
                    </code>
                </div>
            )}

            {learning && (
                <div style={{ display: "grid", gap: 8, padding: "10px", borderRadius: 8, background: "var(--bg-elev)" }}>
                    {candidate ? (
                        <>
                            <span style={{ fontSize: 12, color: "var(--fg)" }}>
                                Captured {candidate.type} @ byte {candidate.byteIndex}
                                {candidate.type === "button"
                                    ? ` (bit 0x${candidate.mask.toString(16)})`
                                    : ` (value ${candidate.value})`}
                            </span>
                            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                                <select
                                    value={bindAction}
                                    onChange={(e) => setBindAction(e.target.value as HidAction)}
                                    style={selStyle}
                                >
                                    {ALL_HID_ACTIONS.map((a) => (
                                        <option key={a} value={a}>
                                            {hidActionLabel(a)}
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
                                    <option value="">Master</option>
                                </select>
                                <button onClick={bindCandidate} style={midiBtn(true)}>
                                    Bind
                                </button>
                            </div>
                        </>
                    ) : (
                        <span style={{ fontSize: 12, color: "var(--fg-dim)" }}>
                            Move a fader or press a pad on the connected device…
                        </span>
                    )}
                </div>
            )}

            {preset.mappings.length > 0 && (
                <div style={{ display: "grid", gap: 4 }}>
                    <span style={{ fontSize: 11, color: "var(--fg-dim)" }}>
                        {preset.mappings.length} binding{preset.mappings.length === 1 ? "" : "s"}
                    </span>
                    <div style={{ display: "grid", gap: 4, maxHeight: 160, overflowY: "auto" }}>
                        {preset.mappings.map((m, i) => (
                            <div
                                key={`${m.byteIndex}-${m.mask}-${i}`}
                                style={{
                                    display: "flex",
                                    justifyContent: "space-between",
                                    alignItems: "center",
                                    gap: 8,
                                    padding: "5px 8px",
                                    borderRadius: 6,
                                    background: "var(--bg-elev)",
                                    fontSize: 12,
                                }}
                            >
                                <span>
                                    {hidActionLabel(m.action)}
                                    {m.deck ? ` · ${m.deck.toUpperCase()}` : " · Master"}
                                </span>
                                <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                    <code style={{ fontSize: 10, color: "var(--fg-dim)" }}>
                                        {m.type === "button"
                                            ? `b${m.byteIndex}.0x${m.mask.toString(16)}`
                                            : `b${m.byteIndex}`}
                                    </code>
                                    <button onClick={() => remove(i)} style={{ color: "var(--fg-dim)", fontSize: 14 }}>
                                        ✕
                                    </button>
                                </span>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <button onClick={() => void copyShare()} style={midiBtn(false)} disabled={preset.mappings.length === 0}>
                    {copied ? "Copied ✓" : "Share mapping"}
                </button>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input
                    value={importText}
                    onChange={(e) => {
                        setImportText(e.target.value);
                        setImportError(false);
                    }}
                    placeholder="Paste a shared HID mapping…"
                    style={{ ...selStyle, flex: 1 }}
                />
                <button onClick={doImport} style={midiBtn(false)} disabled={!importText.trim()}>
                    Import
                </button>
            </div>
            {importError && (
                <span style={{ fontSize: 11, color: "var(--danger)" }}>
                    Couldn't parse that mapping.
                </span>
            )}
        </div>
    );
}

const selStyle: React.CSSProperties = {
    fontSize: 12,
    padding: "5px 8px",
    borderRadius: 8,
    background: "var(--bg-elev-2)",
    color: "var(--fg)",
    border: "1px solid var(--border)",
};

function CompanionSection() {
    const { baseUrl, deviceToken, userId, update } = useCompanionStore();
    const [status, setStatus] = useState<CompanionStatus | null>(null);
    const [checking, setChecking] = useState(false);

    const probe = async () => {
        setChecking(true);
        const st = await engine.companionStatus();
        setStatus(st);
        setChecking(false);
    };

    useEffect(() => {
        void probe();
    }, []);

    const dot = status?.online ? (status.authed ? "var(--good)" : "var(--warn)") : "var(--danger)";
    const label = !status
        ? "Unknown"
        : !status.online
          ? "Offline"
          : status.authed
            ? `Online · ${status.hostname ?? "companion"} v${status.version ?? "?"}`
            : "Online · not paired";

    return (
        <div style={{ display: "grid", gap: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
                <span style={{ width: 9, height: 9, borderRadius: 99, background: dot }} />
                <span style={{ color: "var(--fg-dim)" }}>{label}</span>
                <button onClick={() => void probe()} style={midiBtn(false)} disabled={checking}>
                    ↻ Check
                </button>
            </div>

            <Field
                label="Companion URL"
                value={baseUrl}
                placeholder="http://127.0.0.1:17899"
                onChange={(v) => update({ baseUrl: v })}
            />
            <Field
                label="Device token"
                value={deviceToken}
                placeholder="from the companion app"
                type="password"
                onChange={(v) => update({ deviceToken: v })}
            />
            <Field
                label="User id"
                value={userId}
                placeholder="your muzicai.ro user id"
                onChange={(v) => update({ userId: v })}
            />
            <p style={{ fontSize: 11, color: "var(--fg-dim)", lineHeight: 1.5 }}>
                Find the device token and user id in the MMO Companion app under its
                pairing/settings screen. These let MIXAI read your synced library.
            </p>
        </div>
    );
}

function Field({
    label,
    value,
    placeholder,
    type,
    onChange,
}: {
    label: string;
    value: string;
    placeholder?: string;
    type?: string;
    onChange: (v: string) => void;
}) {
    return (
        <label style={{ display: "grid", gap: 4 }}>
            <span style={{ fontSize: 11, color: "var(--fg-dim)" }}>{label}</span>
            <input
                type={type ?? "text"}
                value={value}
                placeholder={placeholder}
                onChange={(e) => onChange(e.target.value)}
                style={{
                    background: "var(--bg-elev-2)",
                    color: "var(--fg)",
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    padding: "8px 10px",
                    fontSize: 13,
                }}
            />
        </label>
    );
}

function ThemeSection() {
    const theme = useUiStore((s) => s.theme);
    const customThemes = useUiStore((s) => s.customThemes);
    const setTheme = useUiStore((s) => s.setTheme);
    const addCustomTheme = useUiStore((s) => s.addCustomTheme);
    const updateColor = useUiStore((s) => s.updateCustomThemeColor);
    const renameCustomTheme = useUiStore((s) => s.renameCustomTheme);
    const deleteCustomTheme = useUiStore((s) => s.deleteCustomTheme);
    const importThemeString = useUiStore((s) => s.importThemeString);
    const [importText, setImportText] = useState("");
    const [copied, setCopied] = useState(false);
    const [importError, setImportError] = useState(false);

    const active = customThemes.find((t) => t.id === theme);

    const pill = (id: string, name: string) => (
        <button
            key={id}
            onClick={() => setTheme(id as never)}
            style={{
                padding: "8px 12px",
                borderRadius: 10,
                border: `1px solid ${theme === id ? "var(--accent)" : "var(--border)"}`,
                background: theme === id ? "var(--bg-elev-2)" : "transparent",
                fontSize: 12,
                fontWeight: 600,
            }}
        >
            {name}
        </button>
    );

    const copyShare = async () => {
        if (!active) return;
        try {
            await navigator.clipboard.writeText(exportTheme(active));
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch {
            /* clipboard may be blocked; non-fatal */
        }
    };

    const doImport = () => {
        const ok = importThemeString(importText.trim());
        if (ok) {
            setImportText("");
            setImportError(false);
        } else {
            setImportError(true);
        }
    };

    return (
        <div style={{ display: "grid", gap: 10 }}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {Object.values(THEMES).map((t) => pill(t.id, t.name))}
                {customThemes.map((t) => pill(t.id, t.name))}
                <button
                    onClick={() => addCustomTheme("My Theme")}
                    title="Create a custom theme"
                    style={{
                        padding: "8px 12px",
                        borderRadius: 10,
                        border: "1px dashed var(--border)",
                        background: "transparent",
                        fontSize: 12,
                        fontWeight: 700,
                        color: "var(--fg-dim)",
                    }}
                >
                    + New
                </button>
            </div>

            {active && isCustomThemeId(active.id) && (
                <div
                    style={{
                        display: "grid",
                        gap: 10,
                        padding: 12,
                        borderRadius: 12,
                        border: "1px solid var(--border)",
                        background: "var(--bg-elev)",
                    }}
                >
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <input
                            value={active.name}
                            onChange={(e) => renameCustomTheme(active.id, e.target.value)}
                            style={{
                                flex: 1,
                                fontSize: 13,
                                fontWeight: 600,
                                padding: "6px 8px",
                                borderRadius: 8,
                                background: "var(--bg-elev-2)",
                                border: "1px solid var(--border)",
                                color: "var(--fg)",
                            }}
                        />
                        <button onClick={() => void copyShare()} style={smallBtn}>
                            {copied ? "Copied ✓" : "Share"}
                        </button>
                        <button
                            onClick={() => deleteCustomTheme(active.id)}
                            style={{ ...smallBtn, color: "var(--danger)" }}
                        >
                            Delete
                        </button>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 8 }}>
                        {EDITABLE_TOKENS.map(({ key, label }) => (
                            <label key={key} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11 }}>
                                <input
                                    type="color"
                                    value={toHex(active.tokens[key] ?? "#888888")}
                                    onChange={(e) => updateColor(active.id, key, e.target.value)}
                                    style={{ width: 28, height: 22, border: "none", background: "none", padding: 0 }}
                                />
                                <span style={{ color: "var(--fg-dim)" }}>{label}</span>
                            </label>
                        ))}
                    </div>
                </div>
            )}

            <div style={{ display: "flex", gap: 8 }}>
                <input
                    value={importText}
                    onChange={(e) => {
                        setImportText(e.target.value);
                        setImportError(false);
                    }}
                    placeholder="Paste a shared theme code…"
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
                <button onClick={doImport} disabled={!importText.trim()} style={smallBtn}>
                    Import
                </button>
            </div>
            {importError && (
                <span style={{ fontSize: 11, color: "var(--danger)" }}>That doesn't look like a valid theme code.</span>
            )}
        </div>
    );
}

/** Coerce any CSS color to a #rrggbb hex for the native color input. */
function toHex(color: string): string {
    const c = color.trim();
    if (/^#[0-9a-f]{6}$/i.test(c)) return c;
    if (/^#[0-9a-f]{3}$/i.test(c)) {
        return `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}`;
    }
    // rgb()/rgba() → hex (ignore alpha for the swatch).
    const m = /rgba?\(([^)]+)\)/i.exec(c);
    if (m) {
        const parts = m[1]!.split(",").map((p) => p.trim());
        const r = Math.max(0, Math.min(255, parseInt(parts[0] ?? "0", 10)));
        const g = Math.max(0, Math.min(255, parseInt(parts[1] ?? "0", 10)));
        const b = Math.max(0, Math.min(255, parseInt(parts[2] ?? "0", 10)));
        const hx = (n: number) => n.toString(16).padStart(2, "0");
        return `#${hx(r)}${hx(g)}${hx(b)}`;
    }
    return "#888888";
}

const smallBtn: React.CSSProperties = {
    fontSize: 11,
    fontWeight: 700,
    padding: "6px 10px",
    borderRadius: 8,
    background: "var(--bg-elev-2)",
    border: "1px solid var(--border)",
    color: "var(--fg)",
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <div style={{ display: "grid", gap: 8 }}>
            <h3 style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.1em", color: "var(--fg-dim)" }}>
                {title}
            </h3>
            {children}
        </div>
    );
}
