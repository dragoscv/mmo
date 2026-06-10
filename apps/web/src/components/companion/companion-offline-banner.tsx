"use client";

import Link from "next/link";
import { useCompanionStatus } from "./companion-status-provider";

const DOWNLOAD_HREF = "/download";

/**
 * Compact banner shown when no local companion is reachable. Surfaces
 * actionable next steps (download, retry) instead of letting the page
 * silently render an empty state.
 *
 * Renders nothing while discovery is still in progress (status =
 * "unknown" | "discovering") so we don't flash an "offline" message on
 * cold start.
 */
export function CompanionOfflineBanner({ context = "watch" }: { context?: "watch" | "live" | "devices" | "generic" }) {
    const { status, refresh } = useCompanionStatus();
    if (status !== "offline") return null;

    const reason =
        context === "watch" ? "Fără companion local, redarea fișierelor de pe disc + sincronizarea bibliotecii sunt dezactivate."
        : context === "live" ? "Companion-ul oferă latența ultra-scăzută pentru voce live. Fără el, lucrăm pe Web Audio (latență mai mare)."
        : context === "devices" ? "Niciun companion detectat pe această mașină. Pornește aplicația desktop sau adaugă unul din altă rețea."
        : "Companion-ul desktop nu rulează pe mașina asta.";

    return (
        <div
            role="status"
            style={{
                margin: "1.5rem 1.5rem 0",
                padding: ".9rem 1rem",
                borderRadius: 10,
                background: "rgba(239, 68, 68, 0.08)",
                border: "1px solid rgba(239, 68, 68, 0.35)",
                color: "var(--watch-fg, #f1f5f9)",
                display: "flex",
                alignItems: "center",
                gap: ".75rem",
                flexWrap: "wrap",
                fontSize: ".9rem",
            }}
        >
            <span
                aria-hidden
                style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: "#ef4444",
                    boxShadow: "0 0 12px rgba(239,68,68,0.8)",
                    flexShrink: 0,
                }}
            />
            <div style={{ flex: 1, minWidth: 220 }}>
                <strong style={{ display: "block" }}>Companion offline</strong>
                <span style={{ color: "var(--watch-fg-dim, #cbd5e1)" }}>{reason}</span>
            </div>
            <div style={{ display: "flex", gap: ".5rem", flexWrap: "wrap" }}>
                <button
                    type="button"
                    onClick={() => { void refresh(); }}
                    style={{
                        padding: ".4rem .8rem",
                        borderRadius: 6,
                        border: "1px solid rgba(255,255,255,0.2)",
                        background: "transparent",
                        color: "inherit",
                        fontWeight: 600,
                        cursor: "pointer",
                    }}
                >
                    Reîncearcă
                </button>
                <Link
                    href={DOWNLOAD_HREF}
                    style={{
                        padding: ".4rem .8rem",
                        borderRadius: 6,
                        background: "#a855f7",
                        color: "#fff",
                        fontWeight: 600,
                        textDecoration: "none",
                    }}
                >
                    Descarcă companion
                </Link>
            </div>
        </div>
    );
}
