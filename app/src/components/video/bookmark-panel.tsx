"use client";

import { useEffect, useState, useTransition } from "react";
import { Bookmark, X } from "lucide-react";
import { toast } from "sonner";
import { addBookmark, listBookmarks, deleteBookmark } from "@/actions/bookmarks";
import type { VideoBookmarkRow } from "@/db/schema";

export interface BookmarkPanelProps {
    movieId?: number | null;
    episodeId?: number | null;
    fileId?: number;
    currentTime: number;
    onSeek: (time: number) => void;
}

const fmt = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
};

export function BookmarkPanel({ movieId, episodeId, fileId, currentTime, onSeek }: BookmarkPanelProps) {
    const [open, setOpen] = useState(false);
    const [items, setItems] = useState<VideoBookmarkRow[]>([]);
    const [pending, start] = useTransition();
    const target = movieId != null ? { movieId } : episodeId != null ? { episodeId } : null;

    useEffect(() => {
        if (!open || !target) return;
        listBookmarks(target).then((rows) => setItems(rows as VideoBookmarkRow[]));
    }, [open, movieId, episodeId]);

    if (!target) return null;

    const add = () => {
        start(async () => {
            const r = await addBookmark({
                movieId: movieId ?? undefined,
                episodeId: episodeId ?? undefined,
                fileId,
                timeSec: currentTime,
                label: fmt(currentTime),
            });
            if (r.ok) {
                toast.success(`Bookmark @ ${fmt(currentTime)}`);
                const rows = await listBookmarks(target);
                setItems(rows as VideoBookmarkRow[]);
            }
        });
    };

    const del = (id: number) => {
        start(async () => {
            await deleteBookmark(id);
            setItems((cur) => cur.filter((b) => b.id !== id));
        });
    };

    return (
        <>
            <button
                type="button"
                onClick={add}
                disabled={pending}
                title="Add bookmark at current time (B)"
                style={hostBtnStyle}
            >
                <Bookmark size={16} />
            </button>
            <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                title="Show bookmarks"
                style={hostBtnStyle}
            >
                <Bookmark size={16} fill={open ? "#fff" : "transparent"} />
            </button>

            {open && (
                <div style={{
                    position: "absolute", top: 56, right: 12, zIndex: 40,
                    background: "rgba(0,0,0,0.92)", borderRadius: 8,
                    border: "1px solid rgba(255,255,255,0.15)",
                    padding: 8, minWidth: 220, maxHeight: 320, overflowY: "auto",
                    backdropFilter: "blur(8px)",
                }}>
                    {items.length === 0 ? (
                        <p style={{ fontSize: 12, color: "rgba(255,255,255,0.5)", padding: 8 }}>No bookmarks yet</p>
                    ) : items.map((b) => (
                        <div key={b.id} style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 6px" }}>
                            <button
                                type="button"
                                onClick={() => onSeek(b.timeSec)}
                                style={{ flex: 1, textAlign: "left", background: "transparent", border: "none", color: "#fff", fontSize: 12, cursor: "pointer" }}
                            >
                                <span style={{ color: "rgba(255,255,255,0.6)", marginRight: 6, fontVariantNumeric: "tabular-nums" }}>{fmt(b.timeSec)}</span>
                                {b.label && b.label !== fmt(b.timeSec) ? b.label : ""}
                            </button>
                            <button
                                type="button"
                                onClick={() => del(b.id)}
                                style={{ background: "transparent", border: "none", color: "rgba(255,255,255,0.5)", cursor: "pointer", padding: 2 }}
                                title="Delete"
                            >
                                <X size={12} />
                            </button>
                        </div>
                    ))}
                </div>
            )}
        </>
    );
}

const hostBtnStyle: React.CSSProperties = {
    background: "rgba(0,0,0,0.7)",
    color: "#fff",
    border: "1px solid rgba(255,255,255,0.15)",
    borderRadius: 8,
    padding: "6px 8px",
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
};
