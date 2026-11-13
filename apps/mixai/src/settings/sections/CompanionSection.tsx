import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { engine } from "@/bridge/engine";
import type { CompanionStatus } from "@/bridge/types";
import { useT } from "@/i18n";
import { useCompanionStore } from "@/state/companion-store";
import { Field, midiBtn } from "./shared";

export function CompanionSection() {
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
                        ? `Online · ${status.hostname ?? "MixAI Server"} v${status.version ?? "?"}`
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
                label="Server URL"
                value={baseUrl}
                placeholder="http://127.0.0.1:17899"
                onChange={(v) => update({ baseUrl: v })}
            />
            <Field
                label="Device token"
                value={deviceToken}
                placeholder="from MixAI Server"
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
                Find the device token and user id in MixAI Server under its
                pairing/settings screen. These let MIXAI read your synced library.
            </p>
        </div>
    );
}
