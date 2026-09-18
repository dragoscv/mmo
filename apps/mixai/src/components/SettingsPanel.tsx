import { useEffect, useState } from "react";
import { Check, RefreshCw, SlidersHorizontal, X } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, ThemeSettings } from "@mmo/ui";
import { engine } from "@/bridge/engine";
import type { AudioDevice } from "@/bridge/types";
import { subscribeMidiLearn, type MidiLearnEvent } from "@/bridge/events";
import { subscribeHidInput } from "@/bridge/events";
import { useUiStore } from "@/state/ui-store";
import { useCompanionStore } from "@/state/companion-store";
import { useT } from "@/i18n";
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
import { buildProfileJson, applyProfileJson } from "@/lib/cloud-sync";
import { useHidStore } from "@/state/hid-store";
import { PluginManager } from "@/plugins/host";
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
    const t = useT();
    const open = useUiStore((s) => s.settingsOpen);
    const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
    const [devices, setDevices] = useState<AudioDevice[]>([]);

    useEffect(() => {
        void (async () => {
            const d = await engine.listAudioDevices();
            if (d) setDevices(d);
        })();
    }, []);

    return (
        <Sheet open={open} onOpenChange={setSettingsOpen}>
            <SheetContent side="right" className="w-full max-w-xl gap-5 sm:max-w-xl">
                <SheetHeader>
                    <SheetTitle>{t("settings.title")}</SheetTitle>
                    <SheetDescription>{t("settings.description")}</SheetDescription>
                </SheetHeader>

                <Section title={t("settings.appearance")}>
                    {/* mixai has no locale switch yet beyond the shared one; hide nothing else. */}
                    <ThemeSettings hide={["locale"]} className="[&_section]:p-4" />
                </Section>

                <Section title={t("settings.audioOut")}>
                    <DeviceSelect
                        devices={devices}
                        onChange={(id) => void engine.setOutputDevice(id)}
                    />
                </Section>

                <Section title={t("settings.cueOut")}>
                    <DeviceSelect devices={devices} onChange={(id) => void engine.setCueDevice(id)} />
                </Section>

                <Section title={t("settings.midi")}>
                    <MidiSection />
                </Section>

                <Section title={t("settings.hid")}>
                    <HidSection />
                </Section>

                <Section title={t("settings.library")}>
                    <CompanionSection />
                </Section>

                <Section title={t("settings.profile")}>
                    <ProfileSection />
                </Section>

                <Section title={t("settings.plugins")}>
                    <PluginManager />
                </Section>

                <p style={{ fontSize: 11, color: "var(--fg-dim)" }}>{t("settings.syncNote")}</p>
            </SheetContent>
        </Sheet>
    );
}

function DeviceSelect({
    devices,
    onChange,
}: {
    devices: AudioDevice[];
    onChange: (id: string) => void;
}) {
    const t = useT();
    if (devices.length === 0) {
        return <p style={{ fontSize: 12, color: "var(--fg-dim)" }}>{t("settings.noDevices")}</p>;
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

/** Compact, scrollable list of a preset's bindings. */
function BindingsTable({
    preset,
    onDelete,
}: {
    preset: MidiPreset;
    onDelete?: (index: number) => void;
}) {
    const t = useT();
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
                            title={t("settings.remove")}
                            aria-label={t("settings.remove")}
                            style={{
                                fontSize: 11,
                                lineHeight: 1,
                                padding: "2px 6px",
                                borderRadius: 6,
                                background: "transparent",
                                color: "var(--fg-dim)",
                                border: "1px solid var(--border)",
                                cursor: "pointer",
                                display: "inline-flex",
                            }}
                        >
                            <X size={11} aria-hidden />
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
    const cloudReady = useCompanionStore((s) => Boolean(s.deviceToken && s.userId));

    // Manual save/load + paste-restore all share the cloud-sync helpers so the
    // serialize/apply logic lives in exactly one place. The paste-restore path
    // (and "Load from cloud") DO restore the companion connection, unlike the
    // background auto-sync.
    const buildJson = buildProfileJson;
    const applyProfile = (raw: string): Promise<boolean> =>
        applyProfileJson(raw, { includeCompanion: true });

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
                    {copied ? <><Check size={11} aria-hidden /> Copied</> : "Export profile"}
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
                <span style={{ fontSize: 11, color: "var(--good)" }}><Check size={11} aria-hidden style={{ verticalAlign: "-2px" }} /> Profile restored</span>
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
                    {cloud === "saving" ? "Saving…" : cloud === "saved" ? <><Check size={11} aria-hidden /> Saved</> : "Save to cloud"}
                </button>
                <button
                    onClick={() => void doCloudLoad()}
                    disabled={!cloudReady || cloud === "saving" || cloud === "loading"}
                    style={midiBtn(false)}
                >
                    {cloud === "loading" ? "Loading…" : cloud === "loaded" ? <><Check size={11} aria-hidden /> Loaded</> : "Load from cloud"}
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
        color: active ? "var(--accent-fg)" : "var(--fg)",
        border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
    };
}

function HidSection() {
    const t = useT();
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
                                {d.isDjGear && (
                                    <span title={t("settings.knownGear")} style={{ display: "inline-flex" }}>
                                        <SlidersHorizontal size={13} aria-label={t("settings.knownGear")} />
                                    </span>
                                )}
                                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                    {d.label}
                                </span>
                                <span style={{ fontSize: 10, color: "var(--fg-dim)" }}>
                                    {`0x${d.vendorId.toString(16).padStart(4, "0")}:0x${d.productId.toString(16).padStart(4, "0")}`}
                                </span>
                            </span>
                            {connected === d.path ? (
                                <button onClick={() => void disconnect()} style={midiBtn(true)} disabled={busy}>
                                    <Check size={12} aria-hidden /> Connected
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
                    <RefreshCw size={12} aria-hidden /> {t("settings.refresh")}
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
                                    <button onClick={() => remove(i)} aria-label={t("settings.remove")} title={t("settings.remove")} style={{ color: "var(--fg-dim)", fontSize: 14, display: "inline-flex" }}>
                                        <X size={13} aria-hidden />
                                    </button>
                                </span>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <button onClick={() => void copyShare()} style={midiBtn(false)} disabled={preset.mappings.length === 0}>
                    {copied ? <><Check size={11} aria-hidden /> Copied</> : "Share mapping"}
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
    const t = useT();
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
                    <RefreshCw size={12} aria-hidden /> {t("settings.check")}
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
                placeholder="your mixai.ro user id"
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
