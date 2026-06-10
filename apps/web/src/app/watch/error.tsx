"use client";

import { useEffect } from "react";
import Link from "next/link";

export default function WatchError({
    error,
    reset,
}: {
    error: Error & { digest?: string };
    reset: () => void;
}) {
    useEffect(() => {
        console.error("[/watch] render failed:", error);
    }, [error]);

    return (
        <main style={{ padding: "4rem 2rem", maxWidth: 720, margin: "0 auto", color: "var(--watch-fg, #e5e7eb)" }}>
            <h1 style={{ fontSize: "1.75rem", fontWeight: 800, marginBottom: ".5rem" }}>
                Watch s-a oprit din randare
            </h1>
            <p style={{ color: "var(--watch-fg-dim, #9ca3af)", lineHeight: 1.5, marginBottom: "1.5rem" }}>
                Ceva a eșuat pe server (probabil o interogare către baza de date sau către un serviciu extern).
                Detaliile complete sunt în log-urile Vercel pentru codul <code>{error.digest ?? "n/a"}</code>.
            </p>
            <div style={{ display: "flex", gap: ".75rem", flexWrap: "wrap" }}>
                <button
                    type="button"
                    onClick={() => reset()}
                    style={{
                        padding: ".6rem 1.1rem",
                        borderRadius: 8,
                        border: "1px solid var(--watch-border, #334155)",
                        background: "var(--watch-accent, #6366f1)",
                        color: "#fff",
                        fontWeight: 600,
                        cursor: "pointer",
                    }}
                >
                    Reîncearcă
                </button>
                <Link
                    href="/"
                    style={{
                        padding: ".6rem 1.1rem",
                        borderRadius: 8,
                        border: "1px solid var(--watch-border, #334155)",
                        color: "var(--watch-fg, #e5e7eb)",
                        textDecoration: "none",
                    }}
                >
                    Înapoi la home
                </Link>
            </div>
        </main>
    );
}
