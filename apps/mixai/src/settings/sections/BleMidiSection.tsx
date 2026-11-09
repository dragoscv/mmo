import { useEffect, useState } from "react";
import { Check, RefreshCw, X } from "lucide-react";
import { engine } from "@/bridge/engine";
import { subscribeBleMidi } from "@/bridge/events";
import type { BleMidiDevice, BleMidiStats } from "@/bridge/types";
import { useT } from "@/i18n";
import { midiBtn } from "./shared";

/** Direct Bluetooth LE MIDI controllers (no OS driver or pairing needed). */
export function BleMidiSection() {
    const t = useT();
    const [devices, setDevices] = useState<BleMidiDevice[]>([]);
    const [scanning, setScanning] = useState(false);
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [remembered, setRemembered] = useState<string | null>(null);
    const [connected, setConnected] = useState<string | null>(null);
    const [stats, setStats] = useState<BleMidiStats | null>(null);

    const loadStatus = async () => {
        const s = await engine.bleMidiStatus();
        if (!s) return;
        setRemembered(s[0]);
        setConnected(s[1] ? s[0] : null);
    };

    useEffect(() => {
        void loadStatus();
        let unlisten: (() => void) | undefined;
        void subscribeBleMidi(
            (s) => {
                setStats(s);
                setConnected(s.connected ? s.name : null);
            },
            (name) => {
                setConnected(name);
                setRemembered(name);
            },
        ).then((u) => (unlisten = u));
        return () => unlisten?.();
    }, []);

    const scan = async () => {
        setScanning(true);
        setError(null);
        try {
            setDevices((await engine.bleMidiScan(4)) ?? []);
        } catch (e) {
            setError(String(e));
        } finally {
            setScanning(false);
        }
    };

    const connect = async (name: string) => {
        setBusy(name);
        setError(null);
        try {
            const n = await engine.bleMidiConnect(name);
            setConnected(n ?? name);
            setRemembered(n ?? name);
        } catch (e) {
            setError(String(e));
        } finally {
            setBusy(null);
        }
    };

    const disconnect = async () => {
        await engine.bleMidiDisconnect(true);
        setConnected(null);
        setRemembered(null);
        setStats(null);
    };

    const names = Array.from(new Set([...(connected ? [connected] : []), ...devices.map((d) => d.name)]));

    return (
        <div style={{ display: "grid", gap: 10 }}>
            <p style={{ fontSize: 12, color: "var(--fg-dim)", margin: 0 }}>{t("settings.bleHint")}</p>
            {names.map((name) => {
                const dev = devices.find((d) => d.name === name);
                const isOn = connected === name;
                return (
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
                        <span>
                            {name}
                            {dev?.rssi != null && <span style={{ color: "var(--fg-dim)", fontSize: 11 }}> · {dev.rssi} dBm</span>}
                        </span>
                        {isOn ? (
                            <button onClick={() => void disconnect()} style={midiBtn(true)}>
                                <Check size={12} aria-hidden /> {t("settings.bleConnected")}
                            </button>
                        ) : (
                            <button onClick={() => void connect(name)} disabled={busy !== null} aria-busy={busy === name} style={midiBtn(false)}>
                                {busy === name ? t("settings.bleConnecting") : t("settings.bleConnect")}
                            </button>
                        )}
                    </div>
                );
            })}
            {!connected && remembered && (
                <p style={{ fontSize: 12, color: "var(--fg-dim)", margin: 0 }} role="status">
                    {t("settings.bleRemembered", { name: remembered })}
                </p>
            )}
            {!scanning && names.length === 0 && devices.length === 0 && error === null && (
                <p style={{ fontSize: 12, color: "var(--fg-dim)", margin: 0 }}>{t("settings.bleNone")}</p>
            )}
            {connected && stats && (
                <p style={{ fontSize: 11, color: "var(--fg-dim)", margin: 0 }} aria-live="polite">
                    {t("settings.bleStats", {
                        msgs: Math.round(stats.msgsPerSec),
                        gap: stats.gapP95Ms.toFixed(1),
                        rssi: stats.rssi ?? "—",
                    })}
                </p>
            )}
            {error && (
                <p style={{ fontSize: 12, color: "var(--destructive)", margin: 0 }} role="alert">
                    {error}
                </p>
            )}
            <div style={{ display: "flex", gap: 8 }}>
                <button onClick={() => void scan()} disabled={scanning} style={midiBtn(false)}>
                    <RefreshCw size={12} aria-hidden /> {scanning ? t("settings.bleScanning") : t("settings.bleScan")}
                </button>
                {connected && (
                    <button onClick={() => void disconnect()} style={midiBtn(false)}>
                        <X size={12} aria-hidden /> {t("settings.bleForget")}
                    </button>
                )}
            </div>
            <a href="https://aka.ms/midi" target="_blank" rel="noreferrer" style={{ fontSize: 11, color: "var(--fg-dim)", textDecoration: "underline" }}>
                {t("settings.bleOtherApps")}
            </a>
        </div>
    );
}
