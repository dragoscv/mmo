"use client";

import { useState, useTransition } from "react";
import { importLocalVideoLibrary } from "@/actions/video";

export function ImportLibraryButton() {
    const [pending, startTransition] = useTransition();
    const [msg, setMsg] = useState<string | null>(null);

    return (
        <div style={{ display: "flex", gap: ".75rem", alignItems: "center" }}>
            {msg && <span style={{ color: "var(--watch-fg-dim)", fontSize: ".85rem" }}>{msg}</span>}
            <button
                className="watch-cta watch-cta--accent"
                disabled={pending}
                onClick={() => {
                    setMsg(null);
                    startTransition(async () => {
                        const r = await importLocalVideoLibrary();
                        if ("error" in r) setMsg(`Eroare: ${r.error}`);
                        else setMsg(`+${r.moviesAdded} filme, +${r.showsAdded} seriale, ${r.filesIndexed} fișiere scanate`);
                    });
                }}
            >
                {pending ? "Se scanează…" : "Scanează biblioteca"}
            </button>
        </div>
    );
}
