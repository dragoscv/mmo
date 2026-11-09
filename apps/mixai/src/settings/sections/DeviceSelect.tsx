import type { AudioDevice } from "@/bridge/types";
import { useT } from "@/i18n";

export function DeviceSelect({
    devices,
    label,
    onChange,
}: {
    devices: AudioDevice[];
    /** Accessible name (the visible heading sits outside the select). */
    label: string;
    onChange: (id: string) => void;
}) {
    const t = useT();
    if (devices.length === 0) {
        return <p style={{ fontSize: 12, color: "var(--fg-dim)" }}>{t("settings.noDevices")}</p>;
    }
    return (
        <select
            aria-label={label}
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
