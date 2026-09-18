"use client";

/**
 * Mounts once under `ListenRows` and uploads the legacy localStorage play
 * history to `track_plays` (one-shot, flag-guarded). Renders nothing.
 */
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { recordTrackPlay } from "@/actions/track-plays";
import { migrateListenHistory } from "@/lib/listen-history-migration";

export function ListenHistoryMigrator() {
    const router = useRouter();
    useEffect(() => {
        let cancelled = false;
        void migrateListenHistory(recordTrackPlay).then((r) => {
            if (!cancelled && r.status === "done" && r.recorded > 0) router.refresh();
        });
        return () => { cancelled = true; };
    }, [router]);
    return null;
}
