"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { importLocalVideoLibrary } from "@/actions/video";

export function ImportLibraryButton() {
    const t = useTranslations("watch.import");
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
                        if ("error" in r) setMsg(t("error", { error: r.error }));
                        else setMsg(t("done", { movies: r.moviesAdded, shows: r.showsAdded, files: r.filesIndexed }));
                    });
                }}
            >
                {pending ? t("scanning") : t("scan")}
            </button>
        </div>
    );
}
