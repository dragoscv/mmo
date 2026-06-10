"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
    Disc3, Mic, Piano, Waves, Star, Trash2, Pencil, Download,
    Play, Pause, FolderOpen, Search, Filter, Music2, Clock, HardDrive,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useRenderCount } from "@/lib/dev-debugger";
import {
    deleteRecording, renameRecording, toggleRecordingFavorite, type RecordingSource,
} from "@/actions/recordings";
import type { Recording } from "@/db/schema";

const SOURCE_META: Record<RecordingSource, { label: string; icon: typeof Disc3; color: string; ring: string }> = {
    live: { label: "Live", icon: Mic, color: "text-rose-300", ring: "ring-rose-400/40 bg-rose-400/10" },
    mixer: { label: "Mixer", icon: Disc3, color: "text-violet-300", ring: "ring-violet-400/40 bg-violet-400/10" },
    daw: { label: "DAW", icon: Piano, color: "text-emerald-300", ring: "ring-emerald-400/40 bg-emerald-400/10" },
    editor: { label: "Editor", icon: Waves, color: "text-amber-300", ring: "ring-amber-400/40 bg-amber-400/10" },
};

function formatDuration(ms: number): string {
    const total = Math.floor(ms / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    return `${m}:${String(s).padStart(2, "0")}`;
}

function formatBytes(b: number): string {
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
    if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
    return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatRelative(input: string | Date | null): string {
    if (!input) return "—";
    const d = input instanceof Date
        ? input
        : new Date(input.includes("T") ? input : input.replace(" ", "T") + "Z");
    const now = Date.now();
    const diff = now - d.getTime();
    if (diff < 60_000) return "just now";
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} h ago`;
    if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} d ago`;
    return d.toLocaleDateString();
}

interface Props {
    initialRecordings: Recording[];
    folder: string;
}

export function RecordingsClient({ initialRecordings, folder }: Props) {
    useRenderCount("Page:/recordings");
    const [items, setItems] = useState<Recording[]>(initialRecordings);
    const [filter, setFilter] = useState<RecordingSource | "all">("all");
    const [favOnly, setFavOnly] = useState(false);
    const [search, setSearch] = useState("");
    const [playingId, setPlayingId] = useState<number | null>(null);
    const [editingId, setEditingId] = useState<number | null>(null);
    const [editName, setEditName] = useState("");
    const [, startTransition] = useTransition();

    // Highlight a recording when arriving via toast deeplink (#rec-123)
    useEffect(() => {
        if (typeof window === "undefined") return;
        const hash = window.location.hash;
        if (hash.startsWith("#rec-")) {
            const id = Number(hash.slice(5));
            if (Number.isFinite(id)) {
                setTimeout(() => {
                    const el = document.getElementById(`rec-${id}`);
                    el?.scrollIntoView({ behavior: "smooth", block: "center" });
                }, 100);
            }
        }
    }, []);

    const filtered = useMemo(() => {
        const q = search.trim().toLowerCase();
        return items.filter(r => {
            if (filter !== "all" && r.source !== filter) return false;
            if (favOnly && !r.isFavorite) return false;
            if (q && !r.name.toLowerCase().includes(q)) return false;
            return true;
        });
    }, [items, filter, favOnly, search]);

    const stats = useMemo(() => {
        const total = items.length;
        const totalMs = items.reduce((s, r) => s + r.durationMs, 0);
        const totalBytes = items.reduce((s, r) => s + r.sizeBytes, 0);
        return { total, totalMs, totalBytes };
    }, [items]);

    const handleDelete = (rec: Recording) => {
        if (!confirm(`Delete "${rec.name}"? This removes the file from disk too.`)) return;
        startTransition(async () => {
            const res = await deleteRecording(rec.id);
            if (res.success) {
                setItems(prev => prev.filter(r => r.id !== rec.id));
                if (playingId === rec.id) setPlayingId(null);
                toast.success("Recording deleted");
            } else {
                toast.error(res.error ?? "Delete failed");
            }
        });
    };

    const handleFavorite = (rec: Recording) => {
        startTransition(async () => {
            const res = await toggleRecordingFavorite(rec.id);
            if (res.success) {
                setItems(prev => prev.map(r => r.id === rec.id ? { ...r, isFavorite: res.isFavorite ?? !r.isFavorite } : r));
            }
        });
    };

    const startEdit = (rec: Recording) => {
        setEditingId(rec.id);
        setEditName(rec.name);
    };

    const commitEdit = (rec: Recording) => {
        const next = editName.trim();
        if (!next || next === rec.name) {
            setEditingId(null);
            return;
        }
        startTransition(async () => {
            const res = await renameRecording(rec.id, next);
            if (res.success) {
                setItems(prev => prev.map(r => r.id === rec.id ? { ...r, name: next } : r));
                toast.success("Renamed");
            } else {
                toast.error(res.error ?? "Rename failed");
            }
            setEditingId(null);
        });
    };

    const sourceCounts = useMemo(() => {
        const c: Record<RecordingSource | "all", number> = { all: items.length, live: 0, mixer: 0, daw: 0, editor: 0 };
        items.forEach(r => {
            const k = r.source as RecordingSource;
            if (k in c) c[k]++;
        });
        return c;
    }, [items]);

    return (
        <div className="min-h-screen bg-gradient-to-br from-background via-background to-violet-950/10">
            <div className="mx-auto max-w-7xl p-4 md:p-8 space-y-6">
                {/* Header */}
                <motion.div
                    initial={{ opacity: 0, y: -8 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between"
                >
                    <div>
                        <h1 className="text-3xl md:text-4xl font-bold tracking-tight bg-gradient-to-r from-violet-200 via-fuchsia-200 to-rose-200 bg-clip-text text-transparent">
                            Recordings
                        </h1>
                        <p className="text-sm text-muted-foreground mt-1">
                            All sessions captured from Live, Mixer, DAW, and Editor — auto-saved to your configured folder.
                        </p>
                    </div>
                    {folder && (
                        <a
                            href={`/settings`}
                            className="group inline-flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors px-3 py-2 rounded-lg bg-card/50 border border-border/50 hover:border-violet-400/40 max-w-md truncate"
                            title={folder}
                        >
                            <FolderOpen className="h-3.5 w-3.5 shrink-0 group-hover:text-violet-300" />
                            <span className="truncate font-mono">{folder}</span>
                        </a>
                    )}
                </motion.div>

                {/* Stats */}
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 0.05 }}
                    className="grid grid-cols-1 sm:grid-cols-3 gap-3"
                >
                    <StatCard icon={Music2} label="Total" value={String(stats.total)} accent="violet" />
                    <StatCard icon={Clock} label="Duration" value={formatDuration(stats.totalMs)} accent="fuchsia" />
                    <StatCard icon={HardDrive} label="Size" value={formatBytes(stats.totalBytes)} accent="rose" />
                </motion.div>

                {/* Filters */}
                <div className="flex flex-wrap items-center gap-2">
                    <div className="relative w-full sm:flex-1 sm:min-w-[200px]">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                        <input
                            value={search}
                            onChange={e => setSearch(e.target.value)}
                            placeholder="Search recordings…"
                            className="w-full pl-9 pr-3 py-2 rounded-lg bg-card/50 border border-border/50 focus:border-violet-400/60 focus:ring-2 focus:ring-violet-400/20 outline-none text-sm transition-all"
                        />
                    </div>
                    <FilterPill active={filter === "all"} onClick={() => setFilter("all")} count={sourceCounts.all}>
                        <Filter className="h-3.5 w-3.5" /> All
                    </FilterPill>
                    {(["live", "mixer", "daw", "editor"] as const).map(src => {
                        const meta = SOURCE_META[src];
                        const Icon = meta.icon;
                        return (
                            <FilterPill key={src} active={filter === src} onClick={() => setFilter(src)} count={sourceCounts[src]}>
                                <Icon className={cn("h-3.5 w-3.5", filter === src && meta.color)} /> {meta.label}
                            </FilterPill>
                        );
                    })}
                    <FilterPill active={favOnly} onClick={() => setFavOnly(v => !v)}>
                        <Star className={cn("h-3.5 w-3.5", favOnly && "fill-amber-300 text-amber-300")} /> Favorites
                    </FilterPill>
                </div>

                {/* List */}
                {filtered.length === 0 ? (
                    <motion.div
                        initial={{ opacity: 0, scale: 0.98 }}
                        animate={{ opacity: 1, scale: 1 }}
                        className="rounded-xl border border-dashed border-border/60 bg-card/30 p-16 text-center"
                    >
                        <Mic className="mx-auto h-10 w-10 text-muted-foreground/50 mb-3" />
                        <h3 className="text-base font-medium text-foreground/80">No recordings yet</h3>
                        <p className="text-sm text-muted-foreground mt-1">
                            Hit record on the Live, Mixer, DAW, or Editor pages and your sessions will land here automatically.
                        </p>
                    </motion.div>
                ) : (
                    <div className="space-y-2">
                        <AnimatePresence mode="popLayout">
                            {filtered.map((rec, idx) => (
                                <motion.div
                                    key={rec.id}
                                    id={`rec-${rec.id}`}
                                    layout
                                    initial={{ opacity: 0, y: 8 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    exit={{ opacity: 0, x: -20, transition: { duration: 0.15 } }}
                                    transition={{ delay: idx * 0.02, type: "spring", stiffness: 350, damping: 30 }}
                                >
                                    <RecordingRow
                                        rec={rec}
                                        isPlaying={playingId === rec.id}
                                        onTogglePlay={() => setPlayingId(p => (p === rec.id ? null : rec.id))}
                                        editing={editingId === rec.id}
                                        editName={editName}
                                        onEditChange={setEditName}
                                        onStartEdit={() => startEdit(rec)}
                                        onCommitEdit={() => commitEdit(rec)}
                                        onCancelEdit={() => setEditingId(null)}
                                        onDelete={() => handleDelete(rec)}
                                        onToggleFavorite={() => handleFavorite(rec)}
                                    />
                                </motion.div>
                            ))}
                        </AnimatePresence>
                    </div>
                )}
            </div>
        </div>
    );
}

function StatCard({ icon: Icon, label, value, accent }: {
    icon: typeof Music2;
    label: string;
    value: string;
    accent: "violet" | "fuchsia" | "rose";
}) {
    const colors = {
        violet: "from-violet-500/10 to-violet-500/0 text-violet-300",
        fuchsia: "from-fuchsia-500/10 to-fuchsia-500/0 text-fuchsia-300",
        rose: "from-rose-500/10 to-rose-500/0 text-rose-300",
    }[accent];
    return (
        <div className={cn("relative overflow-hidden rounded-xl border border-border/50 bg-gradient-to-br p-4", colors)}>
            <div className="flex items-center justify-between">
                <span className="text-xs uppercase tracking-wider text-muted-foreground">{label}</span>
                <Icon className="h-4 w-4 opacity-60" />
            </div>
            <div className="text-2xl font-bold mt-1 text-foreground">{value}</div>
        </div>
    );
}

function FilterPill({
    active, onClick, count, children,
}: { active: boolean; onClick: () => void; count?: number; children: React.ReactNode }) {
    return (
        <button
            onClick={onClick}
            className={cn(
                "inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium border transition-all",
                active
                    ? "bg-violet-500/15 border-violet-400/40 text-violet-100 shadow-sm shadow-violet-500/20"
                    : "bg-card/30 border-border/50 text-muted-foreground hover:text-foreground hover:border-border"
            )}
        >
            {children}
            {typeof count === "number" && (
                <span className={cn(
                    "ml-0.5 px-1.5 py-0.5 rounded text-[10px]",
                    active ? "bg-violet-400/20 text-violet-100" : "bg-muted/40 text-muted-foreground"
                )}>{count}</span>
            )}
        </button>
    );
}

function RecordingRow({
    rec, isPlaying, onTogglePlay, editing, editName, onEditChange,
    onStartEdit, onCommitEdit, onCancelEdit, onDelete, onToggleFavorite,
}: {
    rec: Recording;
    isPlaying: boolean;
    onTogglePlay: () => void;
    editing: boolean;
    editName: string;
    onEditChange: (s: string) => void;
    onStartEdit: () => void;
    onCommitEdit: () => void;
    onCancelEdit: () => void;
    onDelete: () => void;
    onToggleFavorite: () => void;
}) {
    const meta = SOURCE_META[rec.source as RecordingSource] ?? SOURCE_META.live;
    const Icon = meta.icon;
    const audioUrl = `/api/recordings/${rec.id}/audio`;

    return (
        <div className="group relative rounded-xl border border-border/50 bg-card/40 backdrop-blur-sm hover:border-violet-400/30 hover:bg-card/60 transition-all">
            <div className="flex items-center gap-3 p-3">
                {/* Source badge */}
                <div className={cn(
                    "h-10 w-10 rounded-lg flex items-center justify-center ring-1",
                    meta.ring
                )}>
                    <Icon className={cn("h-5 w-5", meta.color)} />
                </div>

                {/* Play button */}
                <button
                    onClick={onTogglePlay}
                    className={cn(
                        "h-10 w-10 rounded-full flex items-center justify-center transition-all shrink-0",
                        isPlaying
                            ? "bg-violet-500 text-white shadow-lg shadow-violet-500/40"
                            : "bg-muted/50 hover:bg-muted text-foreground"
                    )}
                    aria-label={isPlaying ? "Pause" : "Play"}
                >
                    {isPlaying ? <Pause className="h-4 w-4" fill="currentColor" /> : <Play className="h-4 w-4 ml-0.5" fill="currentColor" />}
                </button>

                {/* Name + meta */}
                <div className="flex-1 min-w-0">
                    {editing ? (
                        <input
                            autoFocus
                            value={editName}
                            onChange={e => onEditChange(e.target.value)}
                            onBlur={onCommitEdit}
                            onKeyDown={e => {
                                if (e.key === "Enter") onCommitEdit();
                                if (e.key === "Escape") onCancelEdit();
                            }}
                            className="w-full px-2 py-1 rounded bg-background border border-violet-400/60 outline-none text-sm font-medium"
                        />
                    ) : (
                        <button
                            onClick={onStartEdit}
                            className="block w-full text-left truncate font-medium text-foreground hover:text-violet-200 transition-colors"
                            title="Click to rename"
                        >
                            {rec.name}
                        </button>
                    )}
                    <div className="flex items-center gap-2 text-[11px] text-muted-foreground mt-0.5">
                        <span className={cn("uppercase tracking-wider font-medium", meta.color)}>{meta.label}</span>
                        <span>·</span>
                        <span>{formatDuration(rec.durationMs)}</span>
                        <span>·</span>
                        <span>{formatBytes(rec.sizeBytes)}</span>
                        <span>·</span>
                        <span>{formatRelative(rec.createdAt)}</span>
                    </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                    <IconButton onClick={onToggleFavorite} title={rec.isFavorite ? "Unfavorite" : "Favorite"}>
                        <Star className={cn("h-4 w-4", rec.isFavorite && "fill-amber-300 text-amber-300")} />
                    </IconButton>
                    <IconButton onClick={onStartEdit} title="Rename">
                        <Pencil className="h-4 w-4" />
                    </IconButton>
                    <a
                        href={audioUrl}
                        download={rec.filename}
                        className="h-8 w-8 rounded-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
                        title="Download"
                    >
                        <Download className="h-4 w-4" />
                    </a>
                    <IconButton onClick={onDelete} title="Delete" danger>
                        <Trash2 className="h-4 w-4" />
                    </IconButton>
                </div>
            </div>

            {/* Inline player */}
            <AnimatePresence>
                {isPlaying && (
                    <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.2 }}
                        className="overflow-hidden border-t border-border/40"
                    >
                        <div className="p-3 pt-3">
                            <audio
                                src={audioUrl}
                                controls
                                autoPlay
                                onEnded={() => onTogglePlay()}
                                className="w-full h-9"
                            />
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}

function IconButton({
    children, onClick, title, danger,
}: { children: React.ReactNode; onClick: () => void; title: string; danger?: boolean }) {
    return (
        <button
            onClick={onClick}
            title={title}
            className={cn(
                "h-8 w-8 rounded-md flex items-center justify-center transition-colors",
                danger
                    ? "text-muted-foreground hover:text-rose-300 hover:bg-rose-500/10"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
            )}
        >
            {children}
        </button>
    );
}
