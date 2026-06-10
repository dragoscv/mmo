"use client";

import { useMemo, useState, useTransition, useEffect } from "react";
import {
    type DuplicateReport,
    type DuplicateGroup,
    type DuplicateTrack,
    resolveDuplicatesHide,
    resolveDuplicatesDelete,
} from "@/actions/duplicates";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Artwork } from "@/components/artwork";
import {
    Copy,
    Sparkles,
    Fingerprint,
    EyeOff,
    Trash2,
    Loader2,
    Crown,
    Settings2,
} from "lucide-react";
import { toast } from "sonner";
import { cn, formatDuration } from "@/lib/utils";

type TabKey = "exact" | "fuzzy" | "audio";

type ResolveAction = "hide" | "delete" | "ask";

const ACTION_STORAGE_KEY = "mmo.duplicates.defaultAction";

interface Props {
    exact: DuplicateReport;
    fuzzy: DuplicateReport;
    audio: DuplicateReport;
}

export function DuplicatesClient({ exact, fuzzy, audio }: Props) {
    const [tab, setTab] = useState<TabKey>("exact");
    const [defaultAction, setDefaultAction] = useState<ResolveAction>("ask");
    const [pending, startTransition] = useTransition();

    // Hydrate the persisted default action.
    useEffect(() => {
        try {
            const stored = localStorage.getItem(ACTION_STORAGE_KEY) as ResolveAction | null;
            if (stored === "hide" || stored === "delete" || stored === "ask") {
                // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot read from localStorage on mount
                setDefaultAction(stored);
            }
        } catch {
            // localStorage unavailable (SSR, sandbox); fall back to "ask".
        }
    }, []);

    function persistAction(a: ResolveAction) {
        setDefaultAction(a);
        try { localStorage.setItem(ACTION_STORAGE_KEY, a); } catch { /* noop */ }
    }

    const report = tab === "exact" ? exact : tab === "fuzzy" ? fuzzy : audio;

    return (
        <div className="container mx-auto p-6 max-w-6xl space-y-6">
            <header className="flex items-start justify-between gap-4 flex-wrap">
                <div>
                    <h1 className="text-2xl font-semibold tracking-tight">Duplicates</h1>
                    <p className="text-sm text-muted-foreground">
                        Three orthogonal scans across your library. Pick a winner per group, hide or delete the rest.
                    </p>
                </div>
                <DefaultActionPicker value={defaultAction} onChange={persistAction} />
            </header>

            <Tabs value={tab} onValueChange={(v) => setTab(v as TabKey)} className="space-y-4">
                <TabsList className="grid w-full grid-cols-3 max-w-2xl text-xs sm:text-sm">
                    <TabsTrigger value="exact" className="gap-2">
                        <Copy className="h-4 w-4" />
                        Exact ({exact.groups.length})
                    </TabsTrigger>
                    <TabsTrigger value="fuzzy" className="gap-2">
                        <Sparkles className="h-4 w-4" />
                        Fuzzy ({fuzzy.groups.length})
                    </TabsTrigger>
                    <TabsTrigger value="audio" className="gap-2">
                        <Fingerprint className="h-4 w-4" />
                        Audio ({audio.groups.length})
                    </TabsTrigger>
                </TabsList>

                {(["exact", "fuzzy", "audio"] as const).map((k) => (
                    <TabsContent key={k} value={k} className="space-y-3">
                        <ReportSummary report={k === "exact" ? exact : k === "fuzzy" ? fuzzy : audio} kind={k} />
                        <GroupList
                            report={k === "exact" ? exact : k === "fuzzy" ? fuzzy : audio}
                            defaultAction={defaultAction}
                            pending={pending}
                            startTransition={startTransition}
                        />
                    </TabsContent>
                ))}
            </Tabs>
        </div>
    );
}

function DefaultActionPicker({
    value, onChange,
}: { value: ResolveAction; onChange: (v: ResolveAction) => void }) {
    return (
        <div className="flex items-center gap-2 text-xs">
            <Settings2 className="h-3.5 w-3.5 text-muted-foreground/60" />
            <span className="text-muted-foreground">Default action:</span>
            <div className="flex rounded-md border border-border/50 overflow-hidden">
                {(["ask", "hide", "delete"] as const).map((a) => (
                    <button
                        key={a}
                        type="button"
                        onClick={() => onChange(a)}
                        className={cn(
                            "px-2.5 py-1 text-xs capitalize transition-colors",
                            value === a
                                ? "bg-primary text-primary-foreground"
                                : "hover:bg-muted/50 text-muted-foreground",
                        )}
                    >
                        {a}
                    </button>
                ))}
            </div>
        </div>
    );
}

function ReportSummary({ report, kind }: { report: DuplicateReport; kind: TabKey }) {
    const empty = report.groups.length === 0;
    return (
        <div className="rounded-lg border border-border/40 bg-muted/20 px-4 py-3 text-xs flex items-center justify-between">
            <span className="text-muted-foreground">
                {empty ? (
                    kind === "audio" && report.scanned === 0
                        ? "No tracks have an audio fingerprint yet — run the analyzer with the fingerprint stage enabled."
                        : "No duplicates found in this strategy."
                ) : (
                    <>
                        <span className="font-medium text-foreground">{report.groups.length}</span> group{report.groups.length === 1 ? "" : "s"} ·{" "}
                        <span className="font-medium text-foreground">{report.duplicates}</span> tracks involved
                    </>
                )}
            </span>
            {!empty && (
                <span className="text-muted-foreground/50">
                    {report.scanned} {kind === "audio" ? "fingerprinted" : "scanned"}
                </span>
            )}
        </div>
    );
}

function GroupList({
    report, defaultAction, pending, startTransition,
}: {
    report: DuplicateReport;
    defaultAction: ResolveAction;
    pending: boolean;
    startTransition: React.TransitionStartFunction;
}) {
    if (report.groups.length === 0) return null;
    return (
        <div className="space-y-3">
            {report.groups.map((g) => (
                <GroupCard
                    key={g.key}
                    group={g}
                    defaultAction={defaultAction}
                    pending={pending}
                    startTransition={startTransition}
                />
            ))}
        </div>
    );
}

function GroupCard({
    group, defaultAction, pending, startTransition,
}: {
    group: DuplicateGroup;
    defaultAction: ResolveAction;
    pending: boolean;
    startTransition: React.TransitionStartFunction;
}) {
    // Initially the highest-quality track is the "winner" (kept). The
    // others are pre-checked as "to resolve".
    const initialKeepId = group.tracks[0]?.id;
    const [keepId, setKeepId] = useState<number | undefined>(initialKeepId);
    const [skip, setSkip] = useState<Set<number>>(new Set());

    const losers = useMemo(
        () => group.tracks.filter(t => t.id !== keepId && !skip.has(t.id)).map(t => t.id),
        [group.tracks, keepId, skip],
    );

    function toggleSkip(id: number) {
        setSkip(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    }

    function resolve(action: "hide" | "delete") {
        if (losers.length === 0) {
            toast.error("Nothing to resolve — every track is either the keeper or skipped");
            return;
        }
        const verb = action === "hide" ? "Hide" : "Delete";
        if (action === "delete" && !confirm(`${verb} ${losers.length} file(s) from disk? This cannot be undone.`)) {
            return;
        }
        startTransition(async () => {
            const fn = action === "hide" ? resolveDuplicatesHide : resolveDuplicatesDelete;
            const r = await fn(losers);
            if (!r.ok) {
                toast.error(r.error ?? "Resolve failed");
                return;
            }
            toast.success(`${verb}d ${r.count} duplicate${r.count === 1 ? "" : "s"}`);
            // Drop the resolved IDs from local state so the row stays in
            // place but gets visually emptied — saves a full route refresh
            // until the user navigates / refreshes.
            setSkip(prev => {
                const next = new Set(prev);
                for (const id of losers) next.add(id);
                return next;
            });
        });
    }

    const ask = defaultAction === "ask";

    return (
        <Card className="p-4 space-y-3">
            <header className="flex items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground/70 font-mono">{group.reason}</span>
                <div className="flex items-center gap-2">
                    {(ask || defaultAction === "hide") && (
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={() => resolve("hide")}
                            disabled={pending || losers.length === 0}
                        >
                            <EyeOff className="h-3.5 w-3.5 mr-1.5" />
                            Hide {losers.length || ""}
                        </Button>
                    )}
                    {(ask || defaultAction === "delete") && (
                        <Button
                            size="sm"
                            variant="destructive"
                            onClick={() => resolve("delete")}
                            disabled={pending || losers.length === 0}
                        >
                            {pending
                                ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                                : <Trash2 className="h-3.5 w-3.5 mr-1.5" />}
                            Delete {losers.length || ""}
                        </Button>
                    )}
                </div>
            </header>
            <div className="divide-y divide-border/30">
                {group.tracks.map((t) => (
                    <TrackRow
                        key={t.id}
                        track={t}
                        isKeeper={t.id === keepId}
                        isSkipped={skip.has(t.id)}
                        onPickKeeper={() => setKeepId(t.id)}
                        onToggleSkip={() => toggleSkip(t.id)}
                    />
                ))}
            </div>
        </Card>
    );
}

function TrackRow({
    track, isKeeper, isSkipped, onPickKeeper, onToggleSkip,
}: {
    track: DuplicateTrack;
    isKeeper: boolean;
    isSkipped: boolean;
    onPickKeeper: () => void;
    onToggleSkip: () => void;
}) {
    return (
        <div
            className={cn(
                "flex items-center gap-3 py-2.5 px-1 rounded-md transition-colors",
                isKeeper && "bg-emerald-500/5",
                isSkipped && "opacity-40",
            )}
        >
            <button
                type="button"
                onClick={onPickKeeper}
                title={isKeeper ? "Keeper" : "Make this the keeper"}
                className={cn(
                    "shrink-0 h-7 w-7 rounded-full grid place-items-center transition-colors",
                    isKeeper ? "bg-emerald-500/20 text-emerald-400" : "text-muted-foreground/40 hover:text-foreground",
                )}
            >
                <Crown className="h-3.5 w-3.5" />
            </button>
            <Artwork src={track.artworkUrl} alt={track.title || "Track"} size="sm" className="rounded-md" />
            <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">
                    {track.title || "Unknown title"}
                </p>
                <p className="text-xs text-muted-foreground truncate">
                    {track.artist || "Unknown artist"}
                    {track.album && ` · ${track.album}`}
                </p>
            </div>
            <div className="hidden sm:flex items-center gap-3 shrink-0 text-[11px] text-muted-foreground/70 tabular-nums">
                {track.format && (
                    <span className="uppercase">{track.format}</span>
                )}
                {track.bitrate && (
                    <span>{Math.round(track.bitrate)} kbps</span>
                )}
                {track.duration && (
                    <span>{formatDuration(Math.round(track.duration))}</span>
                )}
                {track.fileSize && (
                    <span>{(track.fileSize / 1024 / 1024).toFixed(1)} MB</span>
                )}
            </div>
            <label className="flex items-center gap-2 text-xs text-muted-foreground/70 shrink-0 cursor-pointer">
                <Checkbox
                    checked={isSkipped}
                    onChange={onToggleSkip}
                />
                Skip
            </label>
        </div>
    );
}
