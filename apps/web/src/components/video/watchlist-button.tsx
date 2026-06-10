"use client";

import { useEffect, useState, useTransition } from "react";
import { Bookmark, BookmarkCheck } from "lucide-react";
import { addToWatchlist, removeFromWatchlist, isInWatchlist } from "@/actions/watchlist";

interface Props {
    kind: "movie" | "show";
    id: number;
    label?: boolean;
    className?: string;
}

export function WatchlistButton({ kind, id, label = true, className }: Props) {
    const [inList, setInList] = useState<boolean | null>(null);
    const [pending, startTransition] = useTransition();

    useEffect(() => {
        let cancelled = false;
        void isInWatchlist(kind, id).then(v => { if (!cancelled) setInList(v); });
        return () => { cancelled = true; };
    }, [kind, id]);

    const toggle = () => {
        if (inList == null) return;
        const next = !inList;
        setInList(next);
        startTransition(async () => {
            try {
                if (next) await addToWatchlist(kind, id);
                else await removeFromWatchlist(kind, id);
            } catch {
                setInList(!next);
            }
        });
    };

    return (
        <button
            type="button"
            onClick={toggle}
            disabled={pending || inList == null}
            className={className}
            title={inList ? "Remove from watchlist" : "Add to watchlist"}
            style={{
                display: "inline-flex", alignItems: "center", gap: 6,
                background: inList ? "rgba(255,210,80,0.2)" : "rgba(255,255,255,0.08)",
                border: `1px solid ${inList ? "rgba(255,210,80,0.5)" : "rgba(255,255,255,0.15)"}`,
                color: inList ? "rgb(255,220,120)" : "rgba(255,255,255,0.9)",
                borderRadius: 8, padding: "6px 12px",
                fontSize: 13, cursor: "pointer",
            }}
        >
            {inList ? <BookmarkCheck size={14} /> : <Bookmark size={14} />}
            {label && (inList ? "În watchlist" : "Watchlist")}
        </button>
    );
}
