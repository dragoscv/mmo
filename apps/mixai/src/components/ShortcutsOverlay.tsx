/**
 * Keyboard shortcuts cheat-sheet. Toggled with `?` (or the TopBar button).
 * Doubles as the keybind editor: each row shows the *effective* key (default
 * or user override) and can be clicked to capture a new key. Overrides live in
 * the keybind store (persisted + profile-synced).
 */

import { useEffect, useState } from "react";
import { useUiStore } from "@/state/ui-store";
import { SHORTCUT_GROUPS, codeLabel, shortcutId } from "@/lib/shortcuts";
import { useKeybindStore } from "@/state/keybind-store";

export function ShortcutsOverlay() {
    const open = useUiStore((s) => s.shortcutsOpen);
    const setOpen = useUiStore((s) => s.setShortcutsOpen);
    const overrides = useKeybindStore((s) => s.overrides);
    const rebind = useKeybindStore((s) => s.rebind);
    const reset = useKeybindStore((s) => s.reset);
    const resetAll = useKeybindStore((s) => s.resetAll);
    const [capturing, setCapturing] = useState<string | null>(null);

    // While capturing, the next key press (sans modifiers) becomes the binding.
    useEffect(() => {
        if (!capturing) return;
        const onKey = (e: KeyboardEvent) => {
            e.preventDefault();
            e.stopPropagation();
            if (e.key === "Escape") {
                setCapturing(null);
                return;
            }
            if (e.key === "Control" || e.key === "Alt" || e.key === "Shift" || e.key === "Meta") return;
            rebind(capturing, e.code);
            setCapturing(null);
        };
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
    }, [capturing, rebind]);

    if (!open) return null;

    return (
        <div
            onClick={() => {
                setCapturing(null);
                setOpen(false);
            }}
            style={{
                position: "fixed",
                inset: 0,
                background: "rgba(0,0,0,0.5)",
                display: "grid",
                placeItems: "center",
                zIndex: 60,
            }}
        >
            <div
                className="panel"
                onClick={(e) => e.stopPropagation()}
                style={{ padding: 20, width: 620, maxHeight: "80vh", overflowY: "auto", display: "grid", gap: 16 }}
            >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <h2 style={{ fontSize: 18 }}>Keyboard shortcuts</h2>
                    <div style={{ display: "flex", gap: 8 }}>
                        <button
                            onClick={() => {
                                setCapturing(null);
                                resetAll();
                            }}
                            style={{
                                fontSize: 12,
                                fontWeight: 700,
                                padding: "6px 12px",
                                borderRadius: 8,
                                background: "transparent",
                                color: "var(--fg-dim)",
                                border: "1px solid var(--border)",
                            }}
                            title="Restore all default keys"
                        >
                            Reset all
                        </button>
                        <button
                            onClick={() => setOpen(false)}
                            style={{
                                fontSize: 12,
                                fontWeight: 700,
                                padding: "6px 12px",
                                borderRadius: 8,
                                background: "var(--bg-elev-2)",
                                color: "var(--fg)",
                                border: "1px solid var(--border)",
                            }}
                        >
                            Close
                        </button>
                    </div>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16 }}>
                    {SHORTCUT_GROUPS.map((group) => (
                        <div key={group.title} style={{ display: "grid", gap: 6, alignContent: "start" }}>
                            <span
                                style={{
                                    fontSize: 10,
                                    fontWeight: 700,
                                    textTransform: "uppercase",
                                    letterSpacing: "0.16em",
                                    color: "var(--fg-dim)",
                                }}
                            >
                                {group.title}
                            </span>
                            {group.items.map((s) => {
                                const id = shortcutId(s);
                                const overridden = id in overrides;
                                const effectiveCode = overrides[id] ?? s.code;
                                const isCapturing = capturing === id;
                                return (
                                    <div
                                        key={id}
                                        style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}
                                    >
                                        <button
                                            onClick={() => setCapturing(isCapturing ? null : id)}
                                            title={isCapturing ? "Press a key…" : "Click to rebind"}
                                            style={{
                                                minWidth: 30,
                                                textAlign: "center",
                                                padding: "2px 6px",
                                                borderRadius: 6,
                                                cursor: "pointer",
                                                background: isCapturing ? "var(--accent)" : "var(--bg-elev-2)",
                                                color: isCapturing ? "#000" : "var(--fg)",
                                                border: `1px solid ${overridden ? "var(--accent)" : "var(--border)"}`,
                                                fontFamily: "var(--font-mono, monospace)",
                                                fontSize: 11,
                                                fontWeight: 700,
                                            }}
                                        >
                                            {isCapturing ? "…" : codeLabel(effectiveCode)}
                                        </button>
                                        <span style={{ color: "var(--fg-dim)", flex: 1 }}>{s.label}</span>
                                        {overridden && !isCapturing && (
                                            <button
                                                onClick={() => reset(id)}
                                                title="Reset to default"
                                                style={{
                                                    fontSize: 10,
                                                    color: "var(--fg-dim)",
                                                    background: "transparent",
                                                    border: "none",
                                                    cursor: "pointer",
                                                    padding: 0,
                                                }}
                                            >
                                                ↺
                                            </button>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    ))}
                </div>

                <p style={{ fontSize: 11, color: "var(--fg-dim)" }}>
                    Click any key to rebind it, then press the new key (Esc to cancel). Shortcuts
                    are ignored while typing in a text field. Press{" "}
                    <kbd
                        style={{
                            padding: "1px 5px",
                            borderRadius: 5,
                            background: "var(--bg-elev-2)",
                            border: "1px solid var(--border)",
                        }}
                    >
                        ?
                    </kbd>{" "}
                    any time to toggle this panel.
                </p>
            </div>
        </div>
    );
}
