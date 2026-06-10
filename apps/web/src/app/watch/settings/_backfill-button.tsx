"use client";

import { useState, useTransition } from "react";
import { Sparkles, Loader2 } from "lucide-react";
import { backfillMissingTmdbMetadata } from "@/actions/video-backfill";

/** Manual backfill button. Lives on /watch/settings. */
export function BackfillButton() {
    const [pending, startTransition] = useTransition();
    const [last, setLast] = useState<string | null>(null);

    const trigger = () => {
        startTransition(async () => {
            const r = await backfillMissingTmdbMetadata(50);
            if (r.error) {
                setLast(`Error: ${r.error}`);
                return;
            }
            const total = r.moviesUpdated + r.showsUpdated;
            if (total === 0) {
                setLast("Everything already has metadata.");
            } else {
                setLast(`Updated ${r.moviesUpdated} films and ${r.showsUpdated} series.`);
            }
        });
    };

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem", alignItems: "flex-start" }}>
            <button
                type="button"
                className="watch-btn watch-btn-accent"
                onClick={trigger}
                disabled={pending}
            >
                {pending
                    ? <><Loader2 size={16} className="spin" /> Fetching…</>
                    : <><Sparkles size={16} /> Refresh missing metadata</>}
            </button>
            {last && <div style={{ fontSize: "0.82rem", color: "var(--watch-fg-dim)" }}>{last}</div>}
            <style>{`.spin{animation:spin 800ms linear infinite}`}</style>
        </div>
    );
}
