import { X } from "lucide-react";
import type { MidiPreset } from "@/bridge/types";
import { useT } from "@/i18n";
import { actionLabel } from "@/lib/midi-preset";

export function BindingsTable({
    preset,
    onDelete,
}: {
    preset: MidiPreset;
    onDelete?: (index: number) => void;
}) {
    const t = useT();
    return (
        <div style={{ display: "grid", gap: 2 }}>
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
