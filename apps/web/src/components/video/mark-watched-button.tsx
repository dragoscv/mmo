"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Check } from "lucide-react";
import { markWatched } from "@/actions/video-playback";
import { toast } from "sonner";

export function MarkWatchedButton({ episodeId, movieId, watched }: {
    episodeId?: number;
    movieId?: number;
    watched?: boolean;
}) {
    const [done, setDone] = useState(!!watched);
    const [pending, start] = useTransition();
    const t = useTranslations("watch.actions");
    return (
        <button
            type="button"
            disabled={pending || done}
            onClick={() => start(async () => {
                const res = await markWatched({ episodeId, movieId });
                if ("ok" in res && res.ok) { setDone(true); toast.success(t("markedWatched")); }
                else toast.error(t("failed"));
            })}
            title={done ? t("watched") : t("markWatched")}
            className="watch-cta"
            style={{
                display: "inline-flex", alignItems: "center", gap: 4,
                opacity: done ? 0.6 : 1, cursor: done ? "default" : "pointer",
            }}
        >
            <Check size={14} />
            {done ? "✓" : ""}
        </button>
    );
}
