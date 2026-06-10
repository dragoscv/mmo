"use client";

import { useState, useEffect, useTransition, useCallback } from "react";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { useRenderCount } from "@/lib/dev-debugger";
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { StarRating } from "@/components/star-rating";
import { FavoriteButton } from "@/components/favorite-button";
import { TagInput } from "@/components/tag-input";
import { Artwork } from "@/components/artwork";
import { usePlayer } from "@/components/player-context";
import {
    Play,
    Pause,
    Save,
    Search,
    Download,
    Check,
    Loader2,
    Music,
    Clock,
    Disc3,
    ListPlus,
    ListMinus,
    ExternalLink,
    RefreshCw,
    Copy,
    Trash2,
    Mic2,
    Zap,
    MoreHorizontal,
    Sparkles,
    FolderOpen,
    AlertCircle,
    CheckCircle2,
    X,
} from "lucide-react";
import { cn, formatDuration, getHarmonicColor, formatKey } from "@/lib/utils";
import { useDAWSettings } from "@/hooks/use-daw-settings";
import type { Track } from "@/db/schema";
import {
    updateTrack,
    toggleFavorite,
    setTrackRating,
    updateTrackTags,
    deleteTrack,
} from "@/actions/tracks";
import {
    searchTrackMetadata,
    fetchAndApplyMetadata,
    reanalyzeSingleTrack,
    applyReanalysisFields,
    fetchLyricsForTrack,
    type MetadataSearchResult,
    type ReanalysisField,
} from "@/actions/metadata";
import {
    getPlaylistsForTrack,
    addTracksToPlaylist,
    removeTrackFromPlaylist,
    getPlaylists,
} from "@/actions/playlists";
import {
    getRecommendedTracks,
    type RecommendedTrack,
} from "@/actions/recommendations";
import { toast } from "sonner";
import { MetadataLink } from "@/components/metadata-link";

// ─── Types ───────────────────────────────────────────────────────────────────

interface TrackDetailModalProps {
    track: Track | null;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onTrackUpdated?: () => void;
    allTags?: string[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getEnergyColor(energy: number): string {
    if (energy <= 2) return "bg-blue-500";
    if (energy <= 4) return "bg-cyan-500";
    if (energy <= 6) return "bg-yellow-500";
    if (energy <= 8) return "bg-orange-500";
    return "bg-red-500";
}

function getEnergyLabel(energy: number): string {
    if (energy <= 2) return "Low";
    if (energy <= 4) return "Low-Mid";
    if (energy <= 6) return "Mid";
    if (energy <= 8) return "High";
    return "Peak";
}

function parseSyncedLyrics(
    synced: string
): Array<{ time: string; text: string }> {
    return synced
        .split("\n")
        .filter(Boolean)
        .map((line) => {
            const match = line.match(/\[(\d{2}:\d{2}(?:\.\d{2,3})?)\]\s?(.*)/);
            if (match) return { time: match[1], text: match[2] };
            return { time: "", text: line };
        });
}

function formatDate(dateStr?: string | null): string {
    if (!dateStr) return "Never";
    try {
        return new Date(dateStr).toLocaleDateString("en-US", {
            year: "numeric",
            month: "short",
            day: "numeric",
        });
    } catch {
        return dateStr;
    }
}

// ─── Main Component ──────────────────────────────────────────────────────────

export function TrackDetailModal({
    track,
    open,
    onOpenChange,
    onTrackUpdated,
    allTags = [],
}: TrackDetailModalProps) {
    useRenderCount("TrackDetailModal");
    const { currentTrack, isPlaying, play, pause, resume } = usePlayer();
    const { noteNotations } = useDAWSettings();

    // Reanalysis state (lifted to parent so it persists across tabs)
    const [reanalysisResults, setReanalysisResults] =
        useState<ReanalysisField[] | null>(null);
    const [isReanalyzing, setIsReanalyzing] = useState(false);
    const [selectedReanalysisFields, setSelectedReanalysisFields] = useState<
        Set<string>
    >(new Set());
    const [isApplyingReanalysis, setIsApplyingReanalysis] = useState(false);

    // Reset reanalysis state when modal closes or track changes
    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- reset on prop transition (track/open change)
        setReanalysisResults(null);
        setIsReanalyzing(false);
        setSelectedReanalysisFields(new Set());
    }, [track?.id, open]);

    if (!track) return null;

    const handleReanalyze = async () => {
        setIsReanalyzing(true);
        setReanalysisResults(null);
        try {
            const result = await reanalyzeSingleTrack(track.id);
            if (result.errors.length > 0) {
                toast.error(result.errors[0]);
            }
            setReanalysisResults(result.fields);
            // Auto-select new/empty fields
            setSelectedReanalysisFields(
                new Set(result.fields.filter((f) => f.isNew).map((f) => f.field))
            );
        } catch {
            toast.error("Failed to analyze track");
        } finally {
            setIsReanalyzing(false);
        }
    };

    const handleApplyReanalysis = async () => {
        if (!reanalysisResults) return;
        setIsApplyingReanalysis(true);
        try {
            const fieldsToApply: Record<string, string> = {};
            for (const result of reanalysisResults) {
                if (selectedReanalysisFields.has(result.field)) {
                    fieldsToApply[result.field] = result.rawValue;
                }
            }
            if (Object.keys(fieldsToApply).length === 0) {
                toast.info("No fields selected");
                return;
            }
            const res = await applyReanalysisFields(track.id, fieldsToApply);
            if (res.success) {
                toast.success(`Updated ${res.applied} fields`);
                setReanalysisResults(null);
                onTrackUpdated?.();
            }
        } catch {
            toast.error("Failed to apply changes");
        } finally {
            setIsApplyingReanalysis(false);
        }
    };

    const handleDelete = async () => {
        if (!confirm("Delete this track from the library?")) return;
        try {
            await deleteTrack(track.id);
            toast.success("Track deleted");
            onOpenChange(false);
            onTrackUpdated?.();
        } catch {
            toast.error("Failed to delete track");
        }
    };

    const handleCopyInfo = () => {
        const info = [
            `${track.artist || "Unknown"} - ${track.title || track.filename}`,
            track.album ? `Album: ${track.album}` : null,
            track.bpm ? `BPM: ${track.bpm}` : null,
            track.keyCamelot ? `Key: ${formatKey(track.keyCamelot, noteNotations)}` : null,
            track.genre ? `Genre: ${track.genre}` : null,
            track.energy ? `Energy: ${track.energy}/10` : null,
        ]
            .filter(Boolean)
            .join("\n");
        navigator.clipboard.writeText(info);
        toast.success("Track info copied");
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-4xl max-h-[85vh] overflow-hidden flex flex-col p-0">
                {/* ── Header ── */}
                <DialogHeader className="px-5 pt-5 pb-3 border-b border-border">
                    <DialogTitle className="flex items-center gap-3">
                        <Artwork
                            src={track.artworkUrl}
                            alt={`${track.artist} - ${track.title}`}
                            size="md"
                        />
                        <div className="min-w-0 flex-1">
                            <div className="font-semibold text-lg truncate">
                                {track.title || track.filename}
                            </div>
                            <MetadataLink
                                field="artist"
                                value={track.artist}
                                onNavigate={() => onOpenChange(false)}
                                className="text-sm text-muted-foreground truncate block"
                            />
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                            <PlayButton
                                track={track}
                                currentTrack={currentTrack}
                                isPlaying={isPlaying}
                                play={play}
                                pause={pause}
                                resume={resume}
                            />
                            <TooltipProvider delayDuration={300}>
                                <Tooltip>
                                    <TooltipTrigger asChild>
                                        <Button
                                            size="icon"
                                            variant="outline"
                                            className="h-9 w-9"
                                            onClick={handleReanalyze}
                                            disabled={isReanalyzing}
                                        >
                                            {isReanalyzing ? (
                                                <Loader2 className="h-4 w-4 animate-spin" />
                                            ) : (
                                                <RefreshCw className="h-4 w-4" />
                                            )}
                                        </Button>
                                    </TooltipTrigger>
                                    <TooltipContent>
                                        Reanalyze from all sources
                                    </TooltipContent>
                                </Tooltip>
                            </TooltipProvider>
                            <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <Button
                                        size="icon"
                                        variant="ghost"
                                        className="h-9 w-9"
                                    >
                                        <MoreHorizontal className="h-4 w-4" />
                                    </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                    <DropdownMenuItem onClick={handleCopyInfo}>
                                        <Copy className="h-4 w-4 mr-2" />
                                        Copy track info
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                        onClick={() => {
                                            navigator.clipboard.writeText(
                                                track.filepath
                                            );
                                            toast.success("Path copied");
                                        }}
                                    >
                                        <FolderOpen className="h-4 w-4 mr-2" />
                                        Copy file path
                                    </DropdownMenuItem>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem
                                        className="text-destructive focus:text-destructive"
                                        onClick={handleDelete}
                                    >
                                        <Trash2 className="h-4 w-4 mr-2" />
                                        Delete track
                                    </DropdownMenuItem>
                                </DropdownMenuContent>
                            </DropdownMenu>
                        </div>
                    </DialogTitle>
                </DialogHeader>

                {/* ── Reanalysis Panel (conditional) ── */}
                {reanalysisResults && reanalysisResults.length > 0 && (
                    <ReanalysisPanel
                        results={reanalysisResults}
                        selected={selectedReanalysisFields}
                        onToggle={(field) => {
                            const next = new Set(selectedReanalysisFields);
                            if (next.has(field)) next.delete(field);
                            else next.add(field);
                            setSelectedReanalysisFields(next);
                        }}
                        onSelectAll={() =>
                            setSelectedReanalysisFields(
                                new Set(
                                    reanalysisResults.map((f) => f.field)
                                )
                            )
                        }
                        onApply={handleApplyReanalysis}
                        onDismiss={() => setReanalysisResults(null)}
                        isApplying={isApplyingReanalysis}
                    />
                )}

                {reanalysisResults && reanalysisResults.length === 0 && !isReanalyzing && (
                    <div className="mx-5 mb-2 rounded-lg border border-muted bg-muted/30 px-4 py-3 flex items-center gap-3">
                        <CheckCircle2 className="h-4 w-4 text-muted-foreground shrink-0" />
                        <span className="text-sm text-muted-foreground">
                            No new metadata found from external sources.
                        </span>
                        <Button
                            size="sm"
                            variant="ghost"
                            className="ml-auto h-7"
                            onClick={() => setReanalysisResults(null)}
                        >
                            <X className="h-3.5 w-3.5" />
                        </Button>
                    </div>
                )}

                {/* ── Tabs ── */}
                <Tabs
                    defaultValue="overview"
                    className="flex-1 overflow-hidden flex flex-col"
                >
                    <TabsList className="w-full justify-start px-5 shrink-0">
                        <TabsTrigger value="overview">Overview</TabsTrigger>
                        <TabsTrigger value="edit">Edit</TabsTrigger>
                        <TabsTrigger value="lyrics">
                            Lyrics
                            {!track.lyrics && (
                                <span className="ml-1.5 h-1.5 w-1.5 rounded-full bg-amber-500 inline-block" />
                            )}
                        </TabsTrigger>
                        <TabsTrigger value="lookup">Lookup</TabsTrigger>
                        <TabsTrigger value="recommendations">
                            Recommendations
                        </TabsTrigger>
                        <TabsTrigger value="playlists">Playlists</TabsTrigger>
                    </TabsList>

                    <div className="flex-1 overflow-y-auto px-5 pb-5 mt-3">
                        <TabsContent value="overview" className="mt-0">
                            <OverviewTab
                                track={track}
                                allTags={allTags}
                                onTrackUpdated={onTrackUpdated}
                                onClose={() => onOpenChange(false)}
                            />
                        </TabsContent>
                        <TabsContent value="edit" className="mt-0">
                            <EditTab
                                track={track}
                                onTrackUpdated={onTrackUpdated}
                            />
                        </TabsContent>
                        <TabsContent value="lyrics" className="mt-0">
                            <LyricsTab
                                track={track}
                                onTrackUpdated={onTrackUpdated}
                            />
                        </TabsContent>
                        <TabsContent value="lookup" className="mt-0">
                            <LookupTab
                                track={track}
                                onTrackUpdated={onTrackUpdated}
                            />
                        </TabsContent>
                        <TabsContent value="recommendations" className="mt-0">
                            <RecommendationsTab track={track} onClose={() => onOpenChange(false)} />
                        </TabsContent>
                        <TabsContent value="playlists" className="mt-0">
                            <PlaylistsTab track={track} />
                        </TabsContent>
                    </div>
                </Tabs>
            </DialogContent>
        </Dialog>
    );
}

// ─── Play Button ─────────────────────────────────────────────────────────────

function PlayButton({
    track,
    currentTrack,
    isPlaying,
    play,
    pause,
    resume,
}: {
    track: Track;
    currentTrack: Track | null;
    isPlaying: boolean;
    play: (t: Track) => void;
    pause: () => void;
    resume: () => void;
}) {
    const isCurrentTrack = currentTrack?.id === track.id;

    return (
        <Button
            size="icon"
            variant={isCurrentTrack && isPlaying ? "default" : "outline"}
            className="h-9 w-9 rounded-full"
            onClick={() => {
                if (isCurrentTrack) {
                    isPlaying ? pause() : resume();
                } else {
                    play(track);
                }
            }}
        >
            {isCurrentTrack && isPlaying ? (
                <Pause className="h-4 w-4" />
            ) : (
                <Play className="h-4 w-4 ml-0.5" />
            )}
        </Button>
    );
}

// ─── Reanalysis Panel ────────────────────────────────────────────────────────

function ReanalysisPanel({
    results,
    selected,
    onToggle,
    onSelectAll,
    onApply,
    onDismiss,
    isApplying,
}: {
    results: ReanalysisField[];
    selected: Set<string>;
    onToggle: (field: string) => void;
    onSelectAll: () => void;
    onApply: () => void;
    onDismiss: () => void;
    isApplying: boolean;
}) {
    return (
        <div className="mx-5 mb-2 rounded-lg border border-purple-500/20 bg-purple-500/5 p-3.5">
            <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                    <Sparkles className="h-4 w-4 text-purple-400" />
                    <h4 className="text-sm font-medium">
                        Found {results.length} metadata updates
                    </h4>
                </div>
                <div className="flex items-center gap-2">
                    <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 text-xs"
                        onClick={onSelectAll}
                    >
                        Select all
                    </Button>
                    <Button
                        size="sm"
                        variant="ghost"
                        className="h-7"
                        onClick={onDismiss}
                    >
                        <X className="h-3.5 w-3.5" />
                    </Button>
                </div>
            </div>

            <div className="space-y-1.5 max-h-40 overflow-y-auto mb-3">
                {results.map((r) => (
                    <label
                        key={r.field}
                        className={cn(
                            "flex items-center gap-3 rounded-md px-3 py-1.5 text-sm cursor-pointer transition-colors",
                            selected.has(r.field)
                                ? "bg-purple-500/10"
                                : "hover:bg-muted/50"
                        )}
                    >
                        <input
                            type="checkbox"
                            checked={selected.has(r.field)}
                            onChange={() => onToggle(r.field)}
                            className="rounded border-border"
                        />
                        <span className="w-24 shrink-0 text-muted-foreground text-xs">
                            {r.label}
                        </span>
                        <span className="flex-1 truncate">
                            {r.current ? (
                                <span className="text-muted-foreground line-through mr-2">
                                    {r.current}
                                </span>
                            ) : (
                                <span className="text-amber-500/70 mr-2 text-xs">
                                    empty
                                </span>
                            )}
                            <span className="text-foreground">{r.found}</span>
                        </span>
                        <Badge
                            variant="outline"
                            className="text-[10px] shrink-0"
                        >
                            {r.source}
                        </Badge>
                    </label>
                ))}
            </div>

            <div className="flex items-center justify-between">
                <p className="text-xs text-muted-foreground">
                    {selected.size} of {results.length} selected
                </p>
                <Button
                    size="sm"
                    onClick={onApply}
                    disabled={isApplying || selected.size === 0}
                    className="gap-1.5"
                >
                    {isApplying ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                        <Check className="h-3.5 w-3.5" />
                    )}
                    Apply {selected.size} changes
                </Button>
            </div>
        </div>
    );
}

// ─── Overview Tab ────────────────────────────────────────────────────────────

function OverviewTab({
    track,
    allTags,
    onTrackUpdated,
    onClose,
}: {
    track: Track;
    allTags: string[];
    onTrackUpdated?: () => void;
    onClose: () => void;
}) {
    const [localTrack, setLocalTrack] = useState(track);
    const [isPending, startTransition] = useTransition();
    const { noteNotations } = useDAWSettings();

    // eslint-disable-next-line react-hooks/set-state-in-effect -- prop sync into local mutable state
    useEffect(() => setLocalTrack(track), [track]);

    const handleRating = (rating: number) => {
        setLocalTrack((t) => ({ ...t, rating: rating || null }));
        startTransition(async () => {
            await setTrackRating(track.id, rating || null);
            onTrackUpdated?.();
        });
    };

    const handleFavorite = () => {
        setLocalTrack((t) => ({ ...t, isFavorite: !t.isFavorite }));
        startTransition(async () => {
            await toggleFavorite(track.id);
            onTrackUpdated?.();
        });
    };

    const handleTags = (tags: string[]) => {
        setLocalTrack((t) => ({ ...t, tags: JSON.stringify(tags) }));
        startTransition(async () => {
            await updateTrackTags(track.id, tags);
            onTrackUpdated?.();
        });
    };

    const currentTags: string[] = localTrack.tags
        ? JSON.parse(localTrack.tags)
        : [];

    return (
        <div className="space-y-3 pb-2">
            {/* ── Hero Section: Artwork + Info ── */}
            <div className="flex gap-4">
                <Artwork
                    src={localTrack.artworkUrl}
                    alt={`${localTrack.artist} - ${localTrack.title}`}
                    size="lg"
                    className="shrink-0 rounded-lg"
                />
                <div className="flex-1 min-w-0 space-y-2">
                    <div>
                        <h3 className="text-base font-semibold truncate">
                            {localTrack.title || localTrack.filename}
                        </h3>
                        <MetadataLink
                            field="artist"
                            value={localTrack.artist}
                            onNavigate={onClose}
                            className="text-sm text-muted-foreground truncate block"
                        />
                        {(localTrack.album || localTrack.label) && (
                            <p className="text-xs text-muted-foreground/70 truncate mt-0.5">
                                <MetadataLink field="album" value={localTrack.album} onNavigate={onClose} className="text-xs text-muted-foreground/70 hover:text-foreground" />
                                {localTrack.year && (
                                    <MetadataLink field="year" value={localTrack.year} onNavigate={onClose} className="text-xs text-muted-foreground/70 hover:text-foreground">
                                        {" ("}{localTrack.year}{")"}                                    </MetadataLink>
                                )}
                                {localTrack.album && localTrack.label ? " · " : ""}
                                <MetadataLink field="label" value={localTrack.label} onNavigate={onClose} className="text-xs text-muted-foreground/70 hover:text-foreground" />
                            </p>
                        )}
                    </div>

                    <div className="flex items-center gap-2">
                        <StarRating
                            value={localTrack.rating}
                            onChange={handleRating}
                        />
                        <FavoriteButton
                            isFavorite={!!localTrack.isFavorite}
                            onChange={handleFavorite}
                        />
                        {isPending && (
                            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                        )}
                        <span className="w-px h-4 bg-border mx-1" />
                        {localTrack.genre && (
                            <MetadataLink field="genre" value={localTrack.genre} onNavigate={onClose}>
                                <Badge variant="secondary" className="text-[11px] cursor-pointer hover:bg-secondary/80">{localTrack.genre}</Badge>
                            </MetadataLink>
                        )}
                        {localTrack.subgenre && (
                            <MetadataLink field="subgenre" value={localTrack.subgenre} onNavigate={onClose}>
                                <Badge variant="outline" className="text-[11px] cursor-pointer hover:bg-accent">{localTrack.subgenre}</Badge>
                            </MetadataLink>
                        )}
                        {localTrack.mood && (
                            <MetadataLink field="mood" value={localTrack.mood} onNavigate={onClose}>
                                <Badge variant="outline" className="text-[11px] cursor-pointer hover:bg-accent">{localTrack.mood}</Badge>
                            </MetadataLink>
                        )}
                    </div>
                </div>
            </div>

            {/* ── Quick Stats ── */}
            <div className="grid grid-cols-4 gap-1.5">
                <StatCard
                    icon={<Disc3 className="h-3 w-3" />}
                    label="BPM"
                    value={localTrack.bpm?.toFixed(1) || "—"}
                />
                <StatCard
                    icon={<Music className="h-3 w-3" />}
                    label="Key"
                    value={
                        localTrack.keyCamelot ? (
                            <MetadataLink field="key" value={localTrack.keyCamelot} onNavigate={onClose} className="hover:text-foreground">
                                {formatKey(localTrack.keyCamelot, noteNotations)}
                            </MetadataLink>
                        ) : "—"
                    }
                />
                <StatCard
                    icon={<Clock className="h-3 w-3" />}
                    label="Duration"
                    value={formatDuration(localTrack.duration)}
                />
                <StatCard
                    icon={<Zap className="h-3 w-3" />}
                    label="Energy"
                    value={localTrack.energy ? `${localTrack.energy}/10` : "—"}
                />
            </div>

            {/* ── Energy & Mixability Bars ── */}
            {(localTrack.energy || localTrack.mixability) && (
                <div className="space-y-2 rounded-lg border border-border bg-muted/20 px-3 py-2.5">
                    {localTrack.energy && (
                        <div className="flex items-center gap-3">
                            <span className="text-xs text-muted-foreground w-16">
                                Energy
                            </span>
                            <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
                                <div
                                    className={cn(
                                        "h-full rounded-full transition-all",
                                        getEnergyColor(localTrack.energy)
                                    )}
                                    style={{
                                        width: `${localTrack.energy * 10}%`,
                                    }}
                                />
                            </div>
                            <span className="text-xs font-medium w-20 text-right tabular-nums">
                                {localTrack.energy}/10 ·{" "}
                                {getEnergyLabel(localTrack.energy)}
                            </span>
                        </div>
                    )}
                    {localTrack.mixability && (
                        <div className="flex items-center gap-3">
                            <span className="text-xs text-muted-foreground w-16">
                                Mixability
                            </span>
                            <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
                                <div
                                    className="h-full rounded-full bg-purple-500 transition-all"
                                    style={{
                                        width: `${localTrack.mixability * 20}%`,
                                    }}
                                />
                            </div>
                            <span className="text-xs font-medium w-20 text-right tabular-nums">
                                {localTrack.mixability}/5
                            </span>
                        </div>
                    )}
                </div>
            )}

            {/* ── Extra Badges ── */}
            {(localTrack.color || localTrack.vocalType || localTrack.setPosition || localTrack.remix) && (
                <div className="flex flex-wrap gap-1.5">
                    {localTrack.color && (
                        <Badge variant="outline" className="text-[11px]">🎨 {localTrack.color}</Badge>
                    )}
                    {localTrack.vocalType && (
                        <Badge variant="outline" className="text-[11px]">
                            <Mic2 className="h-3 w-3 mr-1" />
                            {localTrack.vocalType}
                        </Badge>
                    )}
                    {localTrack.setPosition && (
                        <Badge variant="outline" className="text-[11px]">Set: {localTrack.setPosition}</Badge>
                    )}
                    {localTrack.remix && (
                        <Badge variant="outline" className="text-[11px]">{localTrack.remix}</Badge>
                    )}
                </div>
            )}

            {/* ── Tags ── */}
            <div>
                <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1.5">
                    Tags
                </h4>
                <TagInput
                    tags={currentTags}
                    onChange={handleTags}
                    suggestions={allTags}
                    placeholder="Add tag (enter to confirm)..."
                />
            </div>

            {/* ── File Info ── */}
            <div className="rounded-lg border border-border px-3.5 py-3 space-y-2">
                <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    File Information
                </h4>
                <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
                    <InfoRow
                        label="Format"
                        value={localTrack.format?.toUpperCase() || "—"}
                    />
                    <InfoRow
                        label="Bitrate"
                        value={
                            localTrack.bitrate
                                ? `${Math.round(localTrack.bitrate / 1000)}kbps`
                                : "—"
                        }
                    />
                    <InfoRow
                        label="Sample Rate"
                        value={
                            localTrack.sampleRate
                                ? `${(localTrack.sampleRate / 1000).toFixed(1)}kHz`
                                : "—"
                        }
                    />
                    <InfoRow
                        label="File Size"
                        value={
                            localTrack.fileSize
                                ? `${(localTrack.fileSize / (1024 * 1024)).toFixed(1)} MB`
                                : "—"
                        }
                    />
                    <InfoRow
                        label="Added"
                        value={formatDate(localTrack.addedAt)}
                    />
                    <InfoRow
                        label="Analyzed"
                        value={formatDate(localTrack.analyzedAt)}
                    />
                </div>

                {/* IDs */}
                {(localTrack.isrc ||
                    localTrack.musicbrainzId ||
                    localTrack.keyCamelot) && (
                        <div className="border-t border-border pt-2 grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
                            {localTrack.isrc && (
                                <InfoRow label="ISRC" value={localTrack.isrc} />
                            )}
                            {localTrack.musicbrainzId && (
                                <InfoRow
                                    label="MusicBrainz"
                                    value={
                                        <a
                                            href={`https://musicbrainz.org/recording/${localTrack.musicbrainzId}`}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="text-purple-400 hover:text-purple-300 flex items-center gap-1"
                                        >
                                            {localTrack.musicbrainzId.slice(0, 8)}…
                                            <ExternalLink className="h-3 w-3" />
                                        </a>
                                    }
                                />
                            )}
                            {localTrack.keyMusical && (
                                <InfoRow
                                    label="Musical Key"
                                    value={localTrack.keyMusical}
                                />
                            )}
                        </div>
                    )}

                {/* File path */}
                <div className="border-t border-border pt-2">
                    <p className="text-xs text-muted-foreground/60 truncate font-mono">
                        {localTrack.filepath}
                    </p>
                </div>
            </div>
        </div>
    );
}

function StatCard({
    icon,
    label,
    value,
}: {
    icon: React.ReactNode;
    label: string;
    value: React.ReactNode;
}) {
    return (
        <div className="rounded-md bg-muted/50 px-2 py-1.5 text-center">
            <div className="flex items-center justify-center gap-1 text-muted-foreground mb-0.5">
                {icon}
                <span className="text-[10px] uppercase tracking-wider">
                    {label}
                </span>
            </div>
            <div className="text-xs font-semibold tabular-nums">{value}</div>
        </div>
    );
}

function InfoRow({
    label,
    value,
}: {
    label: string;
    value: React.ReactNode;
}) {
    return (
        <div className="flex justify-between items-center">
            <span className="text-muted-foreground text-xs">{label}</span>
            <span className="text-xs font-medium">{value}</span>
        </div>
    );
}

// ─── Edit Tab ────────────────────────────────────────────────────────────────

function EditFieldRow({
    label,
    type,
    span,
    value,
    onChange,
}: {
    label: string;
    field: string;
    type: string;
    span: number;
    value: string;
    onChange: (value: string) => void;
}) {
    return (
        <div className={span === 2 ? "col-span-2" : ""}>
            <label className="text-xs text-muted-foreground mb-1 block">
                {label}
            </label>
            <Input
                type={type}
                value={value}
                onChange={(e) => onChange(e.target.value)}
                className="h-8 text-sm"
            />
        </div>
    );
}

function EditTab({
    track,
    onTrackUpdated,
}: {
    track: Track;
    onTrackUpdated?: () => void;
}) {
    const [form, setForm] = useState({
        artist: track.artist || "",
        title: track.title || "",
        album: track.album || "",
        remix: track.remix || "",
        label: track.label || "",
        genre: track.genre || "",
        subgenre: track.subgenre || "",
        bpm: track.bpm?.toString() || "",
        keyCamelot: track.keyCamelot || "",
        keyMusical: track.keyMusical || "",
        energy: track.energy?.toString() || "",
        mood: track.mood || "",
        color: track.color || "",
        vocalType: track.vocalType || "",
        setPosition: track.setPosition || "",
        mixability: track.mixability?.toString() || "",
        year: track.year?.toString() || "",
        comment: track.comment || "",
    });
    const [isPending, startTransition] = useTransition();
    const [saved, setSaved] = useState(false);
    const [isSuggesting, setIsSuggesting] = useState(false);

    const handleSuggest = async () => {
        setIsSuggesting(true);
        try {
            const { suggestTrackTags } = await import("@/actions/ai-tag");
            const res = await suggestTrackTags(track.id);
            if (!res.success || !res.suggestion) {
                toast.error("AI suggest failed", { description: res.error ?? "Unknown error" });
                return;
            }
            const s = res.suggestion;
            const filledFields: string[] = [];
            setForm((f) => {
                const next = { ...f };
                const fillIfEmpty = <K extends keyof typeof next>(key: K, value: string | undefined | null) => {
                    if (value && !next[key]) {
                        next[key] = value as typeof next[K];
                        filledFields.push(String(key));
                    }
                };
                fillIfEmpty("genre", s.genre);
                fillIfEmpty("subgenre", s.subgenre);
                fillIfEmpty("mood", s.mood);
                fillIfEmpty("vocalType", s.vocalType);
                fillIfEmpty("setPosition", s.setPosition);
                if (typeof s.mixability === "number" && !next.mixability) {
                    next.mixability = String(s.mixability);
                    filledFields.push("mixability");
                }
                if (typeof s.energy === "number" && !next.energy) {
                    next.energy = String(s.energy);
                    filledFields.push("energy");
                }
                return next;
            });
            const provider = res.provider ? ` via ${res.provider}` : "";
            if (filledFields.length === 0) {
                toast.info(`AI ran${provider} — no new fields to fill (all already populated)`);
            } else {
                toast.success(`AI filled ${filledFields.length} field${filledFields.length === 1 ? "" : "s"}${provider}`, {
                    description: filledFields.join(", "),
                });
            }
        } finally {
            setIsSuggesting(false);
        }
    };

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- prop sync into form state
        setForm({
            artist: track.artist || "",
            title: track.title || "",
            album: track.album || "",
            remix: track.remix || "",
            label: track.label || "",
            genre: track.genre || "",
            subgenre: track.subgenre || "",
            bpm: track.bpm?.toString() || "",
            keyCamelot: track.keyCamelot || "",
            keyMusical: track.keyMusical || "",
            energy: track.energy?.toString() || "",
            mood: track.mood || "",
            color: track.color || "",
            vocalType: track.vocalType || "",
            setPosition: track.setPosition || "",
            mixability: track.mixability?.toString() || "",
            year: track.year?.toString() || "",
            comment: track.comment || "",
        });
    }, [track]);

    const handleSave = () => {
        setSaved(false);
        startTransition(async () => {
            await updateTrack(track.id, {
                artist: form.artist || undefined,
                title: form.title || undefined,
                album: form.album || undefined,
                remix: form.remix || undefined,
                label: form.label || undefined,
                genre: form.genre || undefined,
                subgenre: form.subgenre || undefined,
                bpm: form.bpm ? parseFloat(form.bpm) : undefined,
                keyCamelot: form.keyCamelot || undefined,
                keyMusical: form.keyMusical || undefined,
                energy: form.energy ? parseInt(form.energy) : undefined,
                mood: form.mood || undefined,
                color: form.color || undefined,
                vocalType: form.vocalType || undefined,
                setPosition: form.setPosition || undefined,
                mixability: form.mixability
                    ? parseInt(form.mixability)
                    : undefined,
                year: form.year ? parseInt(form.year) : null,
                comment: form.comment || undefined,
            });
            setSaved(true);
            onTrackUpdated?.();
            toast.success("Track saved");
            setTimeout(() => setSaved(false), 2000);
        });
    };

    type EditFormShape = typeof form;
    type EditField = keyof EditFormShape;
    const renderField = (
        label: string,
        field: EditField,
        type: string = "text",
        span: number = 1,
    ) => (
        <EditFieldRow
            key={field}
            label={label}
            field={field}
            type={type}
            span={span}
            value={form[field]}
            onChange={(value) => setForm((f) => ({ ...f, [field]: value }))}
        />
    );

    return (
        <div className="space-y-4 pb-2">
            {/* Basic Info */}
            <div>
                <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
                    Basic Information
                </h4>
                <div className="grid grid-cols-2 gap-3">
                    {renderField("Artist", "artist")}
                    {renderField("Title", "title")}
                    {renderField("Album", "album")}
                    {renderField("Remix", "remix")}
                    {renderField("Label", "label")}
                    {renderField("Year", "year", "number")}
                </div>
            </div>

            {/* Musical Properties */}
            <div>
                <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
                    Musical Properties
                </h4>
                <div className="grid grid-cols-2 gap-3">
                    {renderField("Genre", "genre")}
                    {renderField("Subgenre", "subgenre")}
                    {renderField("BPM", "bpm", "number")}
                    {renderField("Key (Camelot)", "keyCamelot")}
                    {renderField("Key (Musical)", "keyMusical")}
                    {renderField("Energy (1-10)", "energy", "number")}
                </div>
            </div>

            {/* DJ Properties */}
            <div>
                <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
                    DJ Properties
                </h4>
                <div className="grid grid-cols-2 gap-3">
                    {renderField("Mood", "mood")}
                    {renderField("Color", "color")}
                    {renderField("Vocal Type", "vocalType")}
                    {renderField("Set Position", "setPosition")}
                    {renderField("Mixability (1-5)", "mixability", "number")}
                </div>
            </div>

            {/* Comment */}
            <div>
                <label className="text-xs text-muted-foreground mb-1 block">
                    Comment
                </label>
                <Textarea
                    value={form.comment}
                    onChange={(e) =>
                        setForm((f) => ({ ...f, comment: e.target.value }))
                    }
                    rows={2}
                    className="text-sm"
                />
            </div>

            <div className="flex justify-between gap-2">
                <Button
                    type="button"
                    variant="secondary"
                    onClick={handleSuggest}
                    disabled={isSuggesting || isPending}
                    className="gap-2"
                    title="Use the AI provider you configured in Settings → AI to suggest genre / mood / energy / etc."
                >
                    {isSuggesting ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                        <Sparkles className="h-4 w-4" />
                    )}
                    Suggest with AI
                </Button>
                <Button
                    onClick={handleSave}
                    disabled={isPending}
                    className="gap-2"
                >
                    {isPending ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                    ) : saved ? (
                        <Check className="h-4 w-4" />
                    ) : (
                        <Save className="h-4 w-4" />
                    )}
                    {saved ? "Saved!" : "Save Changes"}
                </Button>
            </div>
        </div>
    );
}

// ─── Lyrics Tab ──────────────────────────────────────────────────────────────

function LyricsTab({
    track,
    onTrackUpdated,
}: {
    track: Track;
    onTrackUpdated?: () => void;
}) {
    const [plainLyrics, setPlainLyrics] = useState(track.lyrics || "");
    const [syncedLyrics, setSyncedLyrics] = useState(track.syncedLyrics || "");
    const [isFetching, setIsFetching] = useState(false);
    const [viewMode, setViewMode] = useState<"plain" | "synced">(
        track.syncedLyrics ? "synced" : "plain"
    );
    const [isEditing, setIsEditing] = useState(false);
    const [editText, setEditText] = useState("");
    const [isPending, startTransition] = useTransition();

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- prop sync into local editable state
        setPlainLyrics(track.lyrics || "");
        setSyncedLyrics(track.syncedLyrics || "");
        setViewMode(track.syncedLyrics ? "synced" : "plain");
    }, [track]);

    const handleFetch = async () => {
        setIsFetching(true);
        try {
            const result = await fetchLyricsForTrack(track.id);
            if (result.success) {
                if (result.plainLyrics) setPlainLyrics(result.plainLyrics);
                if (result.syncedLyrics) setSyncedLyrics(result.syncedLyrics);
                toast.success("Lyrics found and saved");
                onTrackUpdated?.();
            } else {
                toast.error("No lyrics found for this track");
            }
        } catch {
            toast.error("Failed to fetch lyrics");
        } finally {
            setIsFetching(false);
        }
    };

    const handleCopy = () => {
        const text = viewMode === "synced" ? syncedLyrics : plainLyrics;
        if (text) {
            navigator.clipboard.writeText(text);
            toast.success("Lyrics copied");
        }
    };

    const handleEdit = () => {
        setEditText(plainLyrics);
        setIsEditing(true);
    };

    const handleSaveEdit = () => {
        startTransition(async () => {
            await updateTrack(track.id, { lyrics: editText } as Record<string, unknown>);
            setPlainLyrics(editText);
            setIsEditing(false);
            toast.success("Lyrics saved");
            onTrackUpdated?.();
        });
    };

    const hasLyrics = !!plainLyrics;
    const hasSynced = !!syncedLyrics;
    const parsedSynced = hasSynced ? parseSyncedLyrics(syncedLyrics) : [];

    return (
        <div className="space-y-4 pb-4">
            {/* Status + Actions */}
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                    <div
                        className={cn(
                            "flex items-center gap-2 text-sm",
                            hasLyrics
                                ? "text-emerald-400"
                                : "text-muted-foreground"
                        )}
                    >
                        {hasLyrics ? (
                            <CheckCircle2 className="h-4 w-4" />
                        ) : (
                            <AlertCircle className="h-4 w-4" />
                        )}
                        {hasLyrics ? "Lyrics available" : "No lyrics"}
                    </div>
                    {hasSynced && (
                        <Badge
                            variant="secondary"
                            className="text-[10px]"
                        >
                            Synced
                        </Badge>
                    )}
                </div>
                <div className="flex items-center gap-2">
                    {hasLyrics && !isEditing && (
                        <>
                            <Button
                                size="sm"
                                variant="ghost"
                                className="gap-1.5 h-8"
                                onClick={handleCopy}
                            >
                                <Copy className="h-3.5 w-3.5" />
                                Copy
                            </Button>
                            <Button
                                size="sm"
                                variant="ghost"
                                className="gap-1.5 h-8"
                                onClick={handleEdit}
                            >
                                <Save className="h-3.5 w-3.5" />
                                Edit
                            </Button>
                        </>
                    )}
                    <Button
                        size="sm"
                        variant="outline"
                        className="gap-1.5 h-8"
                        onClick={handleFetch}
                        disabled={isFetching}
                    >
                        {isFetching ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                            <Download className="h-3.5 w-3.5" />
                        )}
                        {hasLyrics ? "Re-fetch" : "Fetch Lyrics"}
                    </Button>
                </div>
            </div>

            {/* View Mode Toggle */}
            {hasLyrics && hasSynced && !isEditing && (
                <div className="flex gap-1 bg-muted/50 rounded-lg p-1 w-fit">
                    <button
                        className={cn(
                            "px-3 py-1 rounded-md text-xs font-medium transition-colors",
                            viewMode === "plain"
                                ? "bg-background text-foreground shadow-sm"
                                : "text-muted-foreground hover:text-foreground"
                        )}
                        onClick={() => setViewMode("plain")}
                    >
                        Plain Text
                    </button>
                    <button
                        className={cn(
                            "px-3 py-1 rounded-md text-xs font-medium transition-colors",
                            viewMode === "synced"
                                ? "bg-background text-foreground shadow-sm"
                                : "text-muted-foreground hover:text-foreground"
                        )}
                        onClick={() => setViewMode("synced")}
                    >
                        Synced
                    </button>
                </div>
            )}

            {/* Lyrics Content */}
            {isEditing ? (
                <div className="space-y-3">
                    <Textarea
                        value={editText}
                        onChange={(e) => setEditText(e.target.value)}
                        rows={16}
                        className="text-sm font-mono"
                        placeholder="Paste or type lyrics here..."
                    />
                    <div className="flex justify-end gap-2">
                        <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setIsEditing(false)}
                        >
                            Cancel
                        </Button>
                        <Button
                            size="sm"
                            onClick={handleSaveEdit}
                            disabled={isPending}
                            className="gap-1.5"
                        >
                            {isPending ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                                <Save className="h-3.5 w-3.5" />
                            )}
                            Save
                        </Button>
                    </div>
                </div>
            ) : hasLyrics ? (
                <div className="rounded-lg border border-border bg-muted/10 max-h-[400px] overflow-y-auto">
                    {viewMode === "plain" || !hasSynced ? (
                        <pre className="p-4 text-sm leading-relaxed whitespace-pre-wrap font-sans">
                            {plainLyrics}
                        </pre>
                    ) : (
                        <div className="p-4 space-y-1">
                            {parsedSynced.map((line, i) => (
                                <div
                                    key={i}
                                    className="flex items-baseline gap-3"
                                >
                                    {line.time && (
                                        <span className="text-[10px] text-muted-foreground/50 font-mono w-14 shrink-0 tabular-nums">
                                            {line.time}
                                        </span>
                                    )}
                                    <span
                                        className={cn(
                                            "text-sm",
                                            !line.text &&
                                            "text-muted-foreground/30 italic"
                                        )}
                                    >
                                        {line.text || "♪"}
                                    </span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            ) : (
                <div className="text-center py-8 text-muted-foreground">
                    <Mic2 className="h-10 w-10 mx-auto mb-3 opacity-30" />
                    <p className="text-sm mb-1">No lyrics available</p>
                    <p className="text-xs text-muted-foreground/60">
                        Click "Fetch Lyrics" to search LRCLIB for lyrics
                    </p>
                </div>
            )}
        </div>
    );
}

// ─── Lookup Tab ──────────────────────────────────────────────────────────────

function LookupTab({
    track,
    onTrackUpdated,
}: {
    track: Track;
    onTrackUpdated?: () => void;
}) {
    const [results, setResults] = useState<MetadataSearchResult[]>([]);
    const [searching, setSearching] = useState(false);
    const [applying, setApplying] = useState<string | null>(null);
    const [applied, setApplied] = useState<string | null>(null);
    const [selectedFields, setSelectedFields] = useState<string[]>([
        "artist",
        "title",
        "album",
        "label",
        "year",
        "genre",
        "artwork",
        "tags",
    ]);

    const handleSearch = async () => {
        setSearching(true);
        setResults([]);
        setApplied(null);
        try {
            const res = await searchTrackMetadata(
                track.artist || "",
                track.title || track.filename
            );
            setResults(res);
            if (res.length === 0) {
                toast.info("No results found on MusicBrainz");
            }
        } catch {
            toast.error("Search failed");
        } finally {
            setSearching(false);
        }
    };

    const handleApply = async (result: MetadataSearchResult) => {
        setApplying(result.id);
        try {
            await fetchAndApplyMetadata(track.id, result.id, selectedFields);
            setApplied(result.id);
            toast.success("Metadata applied");
            onTrackUpdated?.();
        } catch {
            toast.error("Failed to apply metadata");
        } finally {
            setApplying(null);
        }
    };

    const toggleField = (field: string) => {
        setSelectedFields((prev) =>
            prev.includes(field)
                ? prev.filter((f) => f !== field)
                : [...prev, field]
        );
    };

    const fields = [
        "artist",
        "title",
        "album",
        "label",
        "year",
        "genre",
        "artwork",
        "tags",
    ];

    return (
        <div className="space-y-4 pb-4">
            <div className="flex items-center gap-3">
                <div className="flex-1">
                    <p className="text-sm text-muted-foreground">
                        Search MusicBrainz for metadata and artwork for{" "}
                        <span className="text-foreground font-medium">
                            {track.artist || "?"} -{" "}
                            {track.title || track.filename}
                        </span>
                    </p>
                </div>
                <Button
                    onClick={handleSearch}
                    disabled={searching}
                    className="gap-2"
                >
                    {searching ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                        <Search className="h-4 w-4" />
                    )}
                    Search
                </Button>
            </div>

            {/* Fields to apply */}
            <div>
                <p className="text-xs text-muted-foreground mb-2">
                    Fields to apply:
                </p>
                <div className="flex flex-wrap gap-1.5">
                    {fields.map((f) => (
                        <button
                            key={f}
                            type="button"
                            onClick={() => toggleField(f)}
                            className={cn(
                                "rounded-full px-2.5 py-0.5 text-xs font-medium border transition-all cursor-pointer",
                                selectedFields.includes(f)
                                    ? "bg-purple-500/20 text-purple-300 border-purple-500/30"
                                    : "bg-transparent text-muted-foreground border-border hover:border-muted-foreground"
                            )}
                        >
                            {f}
                        </button>
                    ))}
                </div>
            </div>

            {/* Results */}
            {results.length > 0 && (
                <div className="space-y-2">
                    <h4 className="text-sm font-medium text-muted-foreground">
                        {results.length} results found
                    </h4>
                    {results.map((r) => (
                        <div
                            key={r.id}
                            className={cn(
                                "rounded-lg border px-4 py-3 transition-all",
                                applied === r.id
                                    ? "border-emerald-500/50 bg-emerald-500/5"
                                    : "border-border hover:border-purple-500/30"
                            )}
                        >
                            <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-2">
                                        <span className="font-medium truncate">
                                            {r.title}
                                        </span>
                                        <Badge
                                            variant="outline"
                                            className="text-[10px] shrink-0"
                                        >
                                            {r.score}% match
                                        </Badge>
                                    </div>
                                    <div className="text-sm text-muted-foreground truncate">
                                        {r.artist}
                                    </div>
                                    <div className="flex flex-wrap gap-2 mt-1 text-xs text-muted-foreground">
                                        {r.album && <span>💿 {r.album}</span>}
                                        {r.label && <span>🏷️ {r.label}</span>}
                                        {r.year && <span>📅 {r.year}</span>}
                                    </div>
                                    {r.tags && r.tags.length > 0 && (
                                        <div className="flex flex-wrap gap-1 mt-1.5">
                                            {r.tags.map((t) => (
                                                <Badge
                                                    key={t}
                                                    variant="outline"
                                                    className="text-[10px] py-0"
                                                >
                                                    {t}
                                                </Badge>
                                            ))}
                                        </div>
                                    )}
                                </div>
                                <Button
                                    size="sm"
                                    variant={
                                        applied === r.id
                                            ? "default"
                                            : "outline"
                                    }
                                    disabled={!!applying}
                                    onClick={() => handleApply(r)}
                                    className="gap-1.5 shrink-0"
                                >
                                    {applying === r.id ? (
                                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                    ) : applied === r.id ? (
                                        <Check className="h-3.5 w-3.5" />
                                    ) : (
                                        <Download className="h-3.5 w-3.5" />
                                    )}
                                    {applied === r.id ? "Applied" : "Apply"}
                                </Button>
                            </div>
                        </div>
                    ))}
                    <p className="text-xs text-muted-foreground/60 flex items-center gap-1">
                        <ExternalLink className="h-3 w-3" />
                        Data from MusicBrainz / Cover Art Archive
                    </p>
                </div>
            )}

            {!searching && results.length === 0 && (
                <div className="text-center py-8 text-muted-foreground">
                    <Search className="h-8 w-8 mx-auto mb-2 opacity-30" />
                    <p className="text-sm">
                        Click Search to look up metadata from MusicBrainz
                    </p>
                </div>
            )}
        </div>
    );
}

// ─── Recommendations Tab ─────────────────────────────────────────────────────

function RecommendationsTab({ track, onClose }: { track: Track; onClose: () => void }) {
    const [recommendations, setRecommendations] = useState<
        RecommendedTrack[]
    >([]);
    const [loading, setLoading] = useState(false);
    const [loaded, setLoaded] = useState(false);
    const { play: playTrack } = usePlayer();
    const { noteNotations } = useDAWSettings();

    const loadRecommendations = useCallback(async () => {
        setLoading(true);
        try {
            const recs = await getRecommendedTracks(
                track.id,
                track.genre,
                track.bpm,
                track.keyCamelot
            );
            setRecommendations(recs);
            setLoaded(true);
        } catch {
            toast.error("Failed to load recommendations");
        } finally {
            setLoading(false);
        }
    }, [track.id, track.genre, track.bpm, track.keyCamelot]);

    // Auto-load when tab is first viewed
    useEffect(() => {
        if (!loaded) {
            // eslint-disable-next-line react-hooks/set-state-in-effect -- async data fetch result; cannot derive
            loadRecommendations();
        }
    }, [loaded, loadRecommendations]);

    return (
        <div className="space-y-4 pb-4">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <h4 className="text-sm font-medium">
                        Similar Tracks
                        {recommendations.length > 0 && (
                            <span className="text-muted-foreground ml-1.5">
                                ({recommendations.length})
                            </span>
                        )}
                    </h4>
                    <p className="text-xs text-muted-foreground mt-0.5">
                        Based on key compatibility, BPM proximity, and genre
                        matching
                    </p>
                </div>
                <Button
                    size="sm"
                    variant="outline"
                    onClick={loadRecommendations}
                    disabled={loading}
                    className="gap-1.5 h-8"
                >
                    {loading ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                        <RefreshCw className="h-3.5 w-3.5" />
                    )}
                    Refresh
                </Button>
            </div>

            {/* Scoring Legend */}
            <div className="flex items-center gap-4 text-[10px] text-muted-foreground">
                <span className="flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full bg-emerald-500" />
                    Key (max 30pts)
                </span>
                <span className="flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full bg-blue-500" />
                    BPM (max 20pts)
                </span>
                <span className="flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full bg-purple-500" />
                    Genre (max 10pts)
                </span>
            </div>

            {/* Loading */}
            {loading && (
                <div className="flex items-center justify-center py-8">
                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
            )}

            {/* Recommendation Cards */}
            {!loading && recommendations.length > 0 && (
                <div className="space-y-2">
                    {recommendations.map((rec) => {
                        const pct = Math.round(
                            (rec.score / rec.maxScore) * 100
                        );
                        return (
                            <div
                                key={rec.id}
                                className="rounded-lg border border-border hover:border-purple-500/30 transition-all p-3"
                            >
                                <div className="flex items-center gap-3">
                                    {/* Artwork */}
                                    <Artwork
                                        src={rec.artworkUrl}
                                        alt={`${rec.artist} - ${rec.title}`}
                                        size="sm"
                                        className="shrink-0"
                                    />

                                    {/* Info */}
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2">
                                            <span className="text-sm font-medium truncate">
                                                {rec.title || "Unknown"}
                                            </span>
                                            <Badge
                                                variant={
                                                    pct >= 80
                                                        ? "default"
                                                        : pct >= 50
                                                            ? "secondary"
                                                            : "outline"
                                                }
                                                className="text-[10px] shrink-0 tabular-nums"
                                            >
                                                {pct}% match
                                            </Badge>
                                        </div>
                                        <p className="text-xs text-muted-foreground truncate">
                                            <MetadataLink field="artist" value={rec.artist} onNavigate={onClose} className="text-xs text-muted-foreground" />
                                        </p>

                                        {/* Score breakdown bar */}
                                        <div className="flex items-center gap-2 mt-1.5">
                                            <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden flex">
                                                {rec.breakdown.key > 0 && (
                                                    <div
                                                        className="h-full bg-emerald-500"
                                                        style={{
                                                            width: `${(rec.breakdown.key / rec.maxScore) * 100}%`,
                                                        }}
                                                    />
                                                )}
                                                {rec.breakdown.bpm > 0 && (
                                                    <div
                                                        className="h-full bg-blue-500"
                                                        style={{
                                                            width: `${(rec.breakdown.bpm / rec.maxScore) * 100}%`,
                                                        }}
                                                    />
                                                )}
                                                {rec.breakdown.genre > 0 && (
                                                    <div
                                                        className="h-full bg-purple-500"
                                                        style={{
                                                            width: `${(rec.breakdown.genre / rec.maxScore) * 100}%`,
                                                        }}
                                                    />
                                                )}
                                            </div>
                                            <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">
                                                {rec.score}/{rec.maxScore}
                                            </span>
                                        </div>

                                        {/* Details */}
                                        <div className="flex items-center gap-3 mt-1 text-[10px] text-muted-foreground">
                                            {rec.keyCamelot && (
                                                <span
                                                    className={getHarmonicColor(
                                                        track.keyCamelot,
                                                        rec.keyCamelot
                                                    )}
                                                >
                                                    {formatKey(rec.keyCamelot, noteNotations)}
                                                </span>
                                            )}
                                            {rec.bpm && (
                                                <span>
                                                    {rec.bpm.toFixed(1)} BPM
                                                </span>
                                            )}
                                            {rec.genre && (
                                                <span>{rec.genre}</span>
                                            )}
                                            {rec.energy && (
                                                <span>E:{rec.energy}</span>
                                            )}
                                            {rec.duration && (
                                                <span>
                                                    {formatDuration(
                                                        rec.duration
                                                    )}
                                                </span>
                                            )}
                                        </div>

                                        {/* Reason */}
                                        <p className="text-[10px] text-muted-foreground/60 mt-0.5">
                                            {rec.reason}
                                        </p>
                                    </div>

                                    {/* Play button */}
                                    <Button
                                        size="icon"
                                        variant="ghost"
                                        className="h-8 w-8 shrink-0"
                                        onClick={() =>
                                            playTrack({
                                                id: rec.id,
                                                title: rec.title,
                                                artist: rec.artist,
                                                bpm: rec.bpm,
                                                keyCamelot: rec.keyCamelot,
                                                genre: rec.genre,
                                                duration: rec.duration,
                                                energy: rec.energy,
                                                artworkUrl: rec.artworkUrl,
                                            } as Track)
                                        }
                                    >
                                        <Play className="h-3.5 w-3.5" />
                                    </Button>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}

            {/* Empty state */}
            {!loading && loaded && recommendations.length === 0 && (
                <div className="text-center py-8 text-muted-foreground">
                    <Sparkles className="h-10 w-10 mx-auto mb-3 opacity-30" />
                    <p className="text-sm mb-1">No recommendations found</p>
                    <p className="text-xs text-muted-foreground/60">
                        {!track.bpm && !track.keyCamelot
                            ? "This track needs BPM and key data for recommendations. Try analyzing it first."
                            : "No similar tracks found in your library with matching criteria."}
                    </p>
                </div>
            )}
        </div>
    );
}

// ─── Playlists Tab ───────────────────────────────────────────────────────────

function PlaylistsTab({ track }: { track: Track }) {
    const [trackPlaylists, setTrackPlaylists] = useState<
        Array<{ id: number; name: string }>
    >([]);
    const [allPlaylistsList, setAllPlaylistsList] = useState<
        Array<{ id: number; name: string; trackCount: number }>
    >([]);
    const [loading, setLoading] = useState(true);
    const [isPending, startTransition] = useTransition();

    const loadData = useCallback(async () => {
        setLoading(true);
        try {
            const [tp, all] = await Promise.all([
                getPlaylistsForTrack(track.id),
                getPlaylists(),
            ]);
            setTrackPlaylists(tp);
            setAllPlaylistsList(all);
        } finally {
            setLoading(false);
        }
    }, [track.id]);

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- async data fetch result; cannot derive
        loadData();
    }, [loadData]);

    const handleAdd = (playlistId: number) => {
        startTransition(async () => {
            await addTracksToPlaylist(playlistId, [track.id]);
            toast.success("Added to playlist");
            await loadData();
        });
    };

    const handleRemove = (playlistId: number) => {
        startTransition(async () => {
            await removeTrackFromPlaylist(playlistId, track.id);
            toast.success("Removed from playlist");
            await loadData();
        });
    };

    const inPlaylistIds = new Set(trackPlaylists.map((p) => p.id));
    const availablePlaylists = allPlaylistsList.filter(
        (p) => !inPlaylistIds.has(p.id)
    );

    if (loading) {
        return (
            <div className="flex items-center justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
        );
    }

    return (
        <div className="space-y-4 pb-4">
            {/* Current playlists */}
            <div>
                <h4 className="text-sm font-medium text-muted-foreground mb-2">
                    In {trackPlaylists.length} playlist
                    {trackPlaylists.length !== 1 ? "s" : ""}
                </h4>
                {trackPlaylists.length === 0 ? (
                    <p className="text-sm text-muted-foreground/60">
                        Not in any playlist yet
                    </p>
                ) : (
                    <div className="space-y-1">
                        {trackPlaylists.map((pl) => (
                            <div
                                key={pl.id}
                                className="flex items-center justify-between rounded-lg border border-border px-3 py-2"
                            >
                                <span className="text-sm font-medium">
                                    {pl.name}
                                </span>
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    className="gap-1.5 text-destructive hover:text-destructive hover:bg-destructive/10"
                                    disabled={isPending}
                                    onClick={() => handleRemove(pl.id)}
                                >
                                    <ListMinus className="h-3.5 w-3.5" />
                                    Remove
                                </Button>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {/* Add to playlist */}
            {availablePlaylists.length > 0 && (
                <div>
                    <h4 className="text-sm font-medium text-muted-foreground mb-2">
                        Add to playlist
                    </h4>
                    <div className="space-y-1 max-h-48 overflow-y-auto">
                        {availablePlaylists.map((pl) => (
                            <div
                                key={pl.id}
                                className="flex items-center justify-between rounded-lg border border-border px-3 py-2 hover:border-purple-500/30 transition-colors"
                            >
                                <div>
                                    <span className="text-sm font-medium">
                                        {pl.name}
                                    </span>
                                    <span className="text-xs text-muted-foreground ml-2">
                                        {pl.trackCount} tracks
                                    </span>
                                </div>
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    className="gap-1.5 text-purple-400 hover:text-purple-300 hover:bg-purple-500/10"
                                    disabled={isPending}
                                    onClick={() => handleAdd(pl.id)}
                                >
                                    <ListPlus className="h-3.5 w-3.5" />
                                    Add
                                </Button>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {allPlaylistsList.length === 0 && (
                <div className="text-center py-8 text-muted-foreground">
                    <ListPlus className="h-10 w-10 mx-auto mb-3 opacity-30" />
                    <p className="text-sm">
                        No playlists yet. Create one from the Playlists page.
                    </p>
                </div>
            )}
        </div>
    );
}
