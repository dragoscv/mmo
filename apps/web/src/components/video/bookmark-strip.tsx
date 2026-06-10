"use client";

import { useEffect, useState } from "react";
import { listBookmarks } from "@/actions/bookmarks";
import { usePlayer } from "@/components/player-context";
import { Bookmark } from "lucide-react";

interface BookmarkRow {
    id: number;
    timeSec: number;
    label: string | null;
}

function fmt(s: number) {
    const m = Math.floor(s / 60);
    const r = Math.floor(s % 60);
    return `${m}:${String(r).padStart(2, "0")}`;
}

export function BookmarkStrip() {
    const player = usePlayer();
    const v = player.currentVideo;
    const [items, setItems] = useState<BookmarkRow[]>([]);
    const movieId = v?.movieId ?? undefined;
    const episodeId = v?.episodeId ?? undefined;

    useEffect(() => {
        if (movieId == null && episodeId == null) { setItems([]); return; }
        let cancelled = false;
        void (async () => {
            const rows = await listBookmarks({ movieId: movieId ?? undefined, episodeId: episodeId ?? undefined });
            if (!cancelled) setItems(rows.map((b) => ({ id: b.id, timeSec: b.timeSec, label: b.label })));
        })();
        return () => { cancelled = true; };
    }, [movieId, episodeId]);

    if (!v || items.length === 0) return null;

    return (
        <div className="mt-2 flex gap-2 overflow-x-auto pb-1" role="list" aria-label="Bookmarks">
            {items.map((b) => (
                <button
                    key={b.id}
                    type="button"
                    onClick={() => player.seekVideo(b.timeSec)}
                    className="shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-white/5 hover:bg-white/10 text-xs text-white/80 transition-colors"
                    title={`Seek to ${fmt(b.timeSec)}${b.label ? ` — ${b.label}` : ""}`}
                >
                    <Bookmark className="h-3 w-3 text-amber-400" />
                    <span className="font-mono tabular-nums">{fmt(b.timeSec)}</span>
                    {b.label && <span className="truncate max-w-[140px]">{b.label}</span>}
                </button>
            ))}
        </div>
    );
}
