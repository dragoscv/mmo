"use client";

/** Press `?` to toggle a keyboard-shortcuts cheat sheet overlay.
 *  Mounted once at the top of the layout. */

import { useEffect, useState } from "react";
import { X } from "lucide-react";

interface Shortcut { keys: string[]; label: string; section: string }

const SHORTCUTS: Shortcut[] = [
    { section: "Playback", keys: ["Space"], label: "Play / Pause" },
    { section: "Playback", keys: ["←"], label: "Înapoi 5s (audio) / 10s (video)" },
    { section: "Playback", keys: ["→"], label: "Înainte 5s (audio) / 10s (video)" },
    { section: "Playback", keys: ["J"], label: "Înapoi 10s" },
    { section: "Playback", keys: ["L"], label: "Înainte 10s" },
    { section: "Playback", keys: ["K"], label: "Pauză / Redă" },
    { section: "Playback", keys: ["M"], label: "Mute / Unmute" },
    { section: "Playback", keys: ["F"], label: "Fullscreen" },
    { section: "Playback", keys: ["P"], label: "Detach video (PiP)" },
    { section: "Playback", keys: ["N"], label: "Skip intro" },
    { section: "Navigation", keys: ["Shift", "N"], label: "Now Playing" },
    { section: "Navigation", keys: ["G", "L"], label: "Library" },
    { section: "Navigation", keys: ["G", "W"], label: "Watch" },
    { section: "Navigation", keys: ["G", "S"], label: "Stats" },
    { section: "Navigation", keys: ["/"], label: "Caută" },
    { section: "Help", keys: ["?"], label: "Acest cheatsheet" },
    { section: "Help", keys: ["Esc"], label: "Închide overlay-uri" },
];

export function ShortcutsOverlay() {
    const [open, setOpen] = useState(false);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const target = e.target as HTMLElement | null;
            if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
            if (e.key === "?" || (e.shiftKey && e.key === "/")) {
                e.preventDefault();
                setOpen((o) => !o);
            } else if (e.key === "Escape" && open) {
                setOpen(false);
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [open]);

    if (!open) return null;

    const sections = [...new Set(SHORTCUTS.map((s) => s.section))];

    return (
        <div
            onClick={() => setOpen(false)}
            style={{
                position: "fixed", inset: 0, zIndex: 9999,
                background: "rgba(0,0,0,0.75)", backdropFilter: "blur(8px)",
                display: "grid", placeItems: "center", padding: 24,
            }}
        >
            <div
                onClick={(e) => e.stopPropagation()}
                style={{
                    background: "linear-gradient(180deg, rgba(20,20,28,0.95), rgba(12,12,18,0.95))",
                    border: "1px solid rgba(255,255,255,0.08)",
                    borderRadius: 12, padding: 24, maxWidth: 720, width: "100%",
                    maxHeight: "80vh", overflowY: "auto", color: "white",
                    boxShadow: "0 24px 64px rgba(0,0,0,0.6)",
                }}
            >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
                    <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>Scurtături tastatură</h2>
                    <button onClick={() => setOpen(false)} style={{ background: "transparent", border: "none", color: "white", cursor: "pointer", padding: 4 }}>
                        <X size={18} />
                    </button>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 24 }}>
                    {sections.map((sec) => (
                        <div key={sec}>
                            <h3 style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: 1, color: "rgba(255,255,255,0.4)", margin: "0 0 8px 0" }}>
                                {sec}
                            </h3>
                            <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 6 }}>
                                {SHORTCUTS.filter((s) => s.section === sec).map((s, i) => (
                                    <li key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, fontSize: 13 }}>
                                        <span style={{ color: "rgba(255,255,255,0.75)" }}>{s.label}</span>
                                        <span style={{ display: "flex", gap: 4 }}>
                                            {s.keys.map((k, ki) => (
                                                <kbd key={ki} style={{
                                                    background: "rgba(255,255,255,0.08)",
                                                    border: "1px solid rgba(255,255,255,0.12)",
                                                    borderRadius: 4, padding: "2px 6px",
                                                    fontSize: 11, fontFamily: "ui-monospace, monospace",
                                                    minWidth: 20, textAlign: "center",
                                                }}>{k}</kbd>
                                            ))}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    ))}
                </div>
                <p style={{ fontSize: 11, color: "rgba(255,255,255,0.35)", marginTop: 16, marginBottom: 0 }}>
                    Apasă <kbd style={{ background: "rgba(255,255,255,0.08)", padding: "1px 5px", borderRadius: 3 }}>?</kbd> oricând pentru a deschide acest panou.
                </p>
            </div>
        </div>
    );
}
