import { useEffect, useState } from "react";
import { Check, RefreshCw, SlidersHorizontal, X } from "lucide-react";
import { engine } from "@/bridge/engine";
import { subscribeHidInput } from "@/bridge/events";
import type { DeckId, HidDeviceInfo, HidInputEvent } from "@/bridge/types";
import { useT } from "@/i18n";
import { useHidStore } from "@/state/hid-store";
import { ALL_HID_ACTIONS, hidActionLabel, exportHidPreset, importHidPreset, type HidAction } from "@/lib/hid-mapping";
import { HID_DEVICE_PRESETS, presetForDevice } from "@/lib/hid-device-presets";
import { resetHidFeedback } from "@/lib/hid-feedback";
import { midiBtn, selStyle } from "./shared";

export function HidSection() {
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
                    <div style={{ display: "grid", gap: 4 }}>
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
