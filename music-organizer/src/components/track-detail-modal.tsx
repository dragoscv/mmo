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
} from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDuration } from "@/lib/utils";
import type { Track } from "@/db/schema";
import {
    updateTrack,
    toggleFavorite,
    setTrackRating,
    updateTrackTags,
} from "@/actions/tracks";
import {
    searchTrackMetadata,
    fetchAndApplyMetadata,
    type MetadataSearchResult,
} from "@/actions/metadata";
import {
    getPlaylistsForTrack,
    addTracksToPlaylist,
    removeTrackFromPlaylist,
    getPlaylists,
} from "@/actions/playlists";

interface TrackDetailModalProps {
    track: Track | null;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onTrackUpdated?: () => void;
    allTags?: string[];
}

export function TrackDetailModal({
    track,
    open,
    onOpenChange,
    onTrackUpdated,
    allTags = [],
}: TrackDetailModalProps) {
    const { currentTrack, isPlaying, play, pause, resume } = usePlayer();

    if (!track) return null;

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-3xl max-h-[85vh] overflow-hidden flex flex-col">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-3">
                        <Artwork
                            src={track.artworkUrl}
                            alt={`${track.artist} - ${track.title}`}
                            size="md"
                        />
                        <div className="min-w-0 flex-1">
                            <div className="font-semibold truncate">
                                {track.title || track.filename}
                            </div>
                            <div className="text-sm text-[var(--muted-foreground)] truncate">
                                {track.artist || "Unknown Artist"}
                            </div>
                        </div>
                        <div className="flex items-center gap-2">
                            <PlayButton
                                track={track}
                                currentTrack={currentTrack}
                                isPlaying={isPlaying}
                                play={play}
                                pause={pause}
                                resume={resume}
                            />
                        </div>
                    </DialogTitle>
                </DialogHeader>

                <Tabs defaultValue="overview" className="flex-1 overflow-hidden flex flex-col">
                    <TabsList className="w-full justify-start">
                        <TabsTrigger value="overview">Overview</TabsTrigger>
                        <TabsTrigger value="edit">Edit</TabsTrigger>
                        <TabsTrigger value="lookup">Lookup</TabsTrigger>
                        <TabsTrigger value="playlists">Playlists</TabsTrigger>
                    </TabsList>

                    <div className="flex-1 overflow-y-auto mt-4 px-1">
                        <TabsContent value="overview" className="mt-0">
                            <OverviewTab
                                track={track}
                                allTags={allTags}
                                onTrackUpdated={onTrackUpdated}
                            />
                        </TabsContent>
                        <TabsContent value="edit" className="mt-0">
                            <EditTab track={track} onTrackUpdated={onTrackUpdated} />
                        </TabsContent>
                        <TabsContent value="lookup" className="mt-0">
                            <LookupTab track={track} onTrackUpdated={onTrackUpdated} />
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

// --- Play Button ---
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
            className="h-10 w-10 rounded-full"
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

// --- Overview Tab ---
function OverviewTab({
    track,
    allTags,
    onTrackUpdated,
}: {
    track: Track;
    allTags: string[];
    onTrackUpdated?: () => void;
}) {
    const [localTrack, setLocalTrack] = useState(track);
    const [isPending, startTransition] = useTransition();

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
        <div className="space-y-6 pb-4">
            {/* Artwork + Quick Info */}
            <div className="flex gap-6">
                <Artwork
                    src={localTrack.artworkUrl}
                    alt={`${localTrack.artist} - ${localTrack.title}`}
                    size="xl"
                    className="shrink-0"
                />
                <div className="flex-1 space-y-4 min-w-0">
                    <div>
                        <h3 className="text-xl font-semibold truncate">
                            {localTrack.title || localTrack.filename}
                        </h3>
                        <p className="text-[var(--muted-foreground)] truncate">
                            {localTrack.artist || "Unknown Artist"}
                        </p>
                        {localTrack.album && (
                            <p className="text-sm text-zinc-500 truncate">
                                {localTrack.album}
                                {localTrack.year ? ` (${localTrack.year})` : ""}
                            </p>
                        )}
                    </div>

                    {/* Rating + Favorite */}
                    <div className="flex items-center gap-4">
                        <StarRating
                            value={localTrack.rating}
                            onChange={handleRating}
                            size="lg"
                        />
                        <FavoriteButton
                            isFavorite={!!localTrack.isFavorite}
                            onChange={handleFavorite}
                            size="lg"
                        />
                        {isPending && (
                            <Loader2 className="h-4 w-4 animate-spin text-zinc-500" />
                        )}
                    </div>

                    {/* Quick Stats Grid */}
                    <div className="grid grid-cols-3 gap-3">
                        <StatBadge
                            icon={<Disc3 className="h-3.5 w-3.5" />}
                            label="BPM"
                            value={localTrack.bpm?.toFixed(1) || "—"}
                        />
                        <StatBadge
                            icon={<Music className="h-3.5 w-3.5" />}
                            label="Key"
                            value={localTrack.keyCamelot || "—"}
                        />
                        <StatBadge
                            icon={<Clock className="h-3.5 w-3.5" />}
                            label="Duration"
                            value={formatDuration(localTrack.duration)}
                        />
                    </div>

                    {/* Quick Info Badges */}
                    <div className="flex flex-wrap gap-2">
                        {localTrack.genre && (
                            <Badge variant="secondary">{localTrack.genre}</Badge>
                        )}
                        {localTrack.energy && (
                            <Badge variant="outline">Energy: {localTrack.energy}</Badge>
                        )}
                        {localTrack.mood && (
                            <Badge variant="outline">{localTrack.mood}</Badge>
                        )}
                        {localTrack.label && (
                            <Badge variant="outline">{localTrack.label}</Badge>
                        )}
                        {localTrack.color && (
                            <Badge variant="outline">{localTrack.color}</Badge>
                        )}
                    </div>
                </div>
            </div>

            {/* Tags Section */}
            <div>
                <h4 className="text-sm font-medium mb-2 text-zinc-400">Tags</h4>
                <TagInput
                    tags={currentTags}
                    onChange={handleTags}
                    suggestions={allTags}
                    placeholder="Add tag (enter to confirm)..."
                />
            </div>

            {/* File Info */}
            <div className="rounded-lg border border-[var(--border)] px-4 py-3">
                <h4 className="text-xs font-medium text-zinc-500 uppercase mb-2">
                    File Info
                </h4>
                <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
                    <div className="flex justify-between">
                        <span className="text-zinc-500">Format</span>
                        <span>{localTrack.format || "—"}</span>
                    </div>
                    <div className="flex justify-between">
                        <span className="text-zinc-500">Bitrate</span>
                        <span>
                            {localTrack.bitrate
                                ? `${Math.round(localTrack.bitrate / 1000)}kbps`
                                : "—"}
                        </span>
                    </div>
                    <div className="flex justify-between">
                        <span className="text-zinc-500">Sample Rate</span>
                        <span>
                            {localTrack.sampleRate
                                ? `${(localTrack.sampleRate / 1000).toFixed(1)}kHz`
                                : "—"}
                        </span>
                    </div>
                    <div className="flex justify-between">
                        <span className="text-zinc-500">File Size</span>
                        <span>
                            {localTrack.fileSize
                                ? `${(localTrack.fileSize / (1024 * 1024)).toFixed(1)} MB`
                                : "—"}
                        </span>
                    </div>
                </div>
                <div className="mt-2 text-xs text-zinc-600 truncate">
                    {localTrack.filepath}
                </div>
            </div>
        </div>
    );
}

function StatBadge({
    icon,
    label,
    value,
}: {
    icon: React.ReactNode;
    label: string;
    value: string;
}) {
    return (
        <div className="flex items-center gap-2 rounded-lg border border-[var(--border)] px-3 py-2">
            <div className="text-zinc-500">{icon}</div>
            <div>
                <div className="text-[10px] uppercase text-zinc-500">{label}</div>
                <div className="text-sm font-medium">{value}</div>
            </div>
        </div>
    );
}

// --- Edit Tab ---
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

    useEffect(() => {
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
                mixability: form.mixability ? parseInt(form.mixability) : undefined,
                year: form.year ? parseInt(form.year) : null,
                comment: form.comment || undefined,
            });
            setSaved(true);
            onTrackUpdated?.();
            setTimeout(() => setSaved(false), 2000);
        });
    };

    const Field = ({
        label,
        field,
        type = "text",
        span = 1,
    }: {
        label: string;
        field: keyof typeof form;
        type?: string;
        span?: number;
    }) => (
        <div className={span === 2 ? "col-span-2" : ""}>
            <label className="text-xs text-zinc-500 mb-1 block">{label}</label>
            <Input
                type={type}
                value={form[field]}
                onChange={(e) => setForm((f) => ({ ...f, [field]: e.target.value }))}
                className="h-8 text-sm"
            />
        </div>
    );

    return (
        <div className="space-y-4 pb-4">
            <div className="grid grid-cols-2 gap-3">
                <Field label="Artist" field="artist" />
                <Field label="Title" field="title" />
                <Field label="Album" field="album" />
                <Field label="Remix" field="remix" />
                <Field label="Label" field="label" />
                <Field label="Year" field="year" type="number" />
                <Field label="Genre" field="genre" />
                <Field label="Subgenre" field="subgenre" />
                <Field label="BPM" field="bpm" type="number" />
                <Field label="Key (Camelot)" field="keyCamelot" />
                <Field label="Key (Musical)" field="keyMusical" />
                <Field label="Energy (1-5)" field="energy" type="number" />
                <Field label="Mood" field="mood" />
                <Field label="Color" field="color" />
                <Field label="Vocal Type" field="vocalType" />
                <Field label="Set Position" field="setPosition" />
                <Field label="Mixability (1-5)" field="mixability" type="number" />
            </div>

            <div>
                <label className="text-xs text-zinc-500 mb-1 block">Comment</label>
                <Textarea
                    value={form.comment}
                    onChange={(e) => setForm((f) => ({ ...f, comment: e.target.value }))}
                    rows={2}
                    className="text-sm"
                />
            </div>

            <div className="flex justify-end">
                <Button onClick={handleSave} disabled={isPending} className="gap-2">
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

// --- Lookup Tab ---
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
        } finally {
            setSearching(false);
        }
    };

    const handleApply = async (result: MetadataSearchResult) => {
        setApplying(result.id);
        try {
            await fetchAndApplyMetadata(track.id, result.id, selectedFields);
            setApplied(result.id);
            onTrackUpdated?.();
        } finally {
            setApplying(null);
        }
    };

    const toggleField = (field: string) => {
        setSelectedFields((prev) =>
            prev.includes(field) ? prev.filter((f) => f !== field) : [...prev, field]
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
                    <p className="text-sm text-zinc-400">
                        Search MusicBrainz for metadata and artwork for{" "}
                        <span className="text-white font-medium">
                            {track.artist || "?"} - {track.title || track.filename}
                        </span>
                    </p>
                </div>
                <Button onClick={handleSearch} disabled={searching} className="gap-2">
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
                <p className="text-xs text-zinc-500 mb-2">Fields to apply:</p>
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
                                    : "bg-transparent text-zinc-500 border-zinc-700 hover:border-zinc-500"
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
                    <h4 className="text-sm font-medium text-zinc-400">
                        {results.length} results found
                    </h4>
                    {results.map((r) => (
                        <div
                            key={r.id}
                            className={cn(
                                "rounded-lg border px-4 py-3 transition-all",
                                applied === r.id
                                    ? "border-emerald-500/50 bg-emerald-500/5"
                                    : "border-[var(--border)] hover:border-purple-500/30"
                            )}
                        >
                            <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-2">
                                        <span className="font-medium truncate">{r.title}</span>
                                        <span className="text-xs text-zinc-500 shrink-0">
                                            {r.score}% match
                                        </span>
                                    </div>
                                    <div className="text-sm text-zinc-400 truncate">
                                        {r.artist}
                                    </div>
                                    <div className="flex flex-wrap gap-2 mt-1 text-xs text-zinc-500">
                                        {r.album && <span>📀 {r.album}</span>}
                                        {r.label && <span>🏷️ {r.label}</span>}
                                        {r.year && <span>📅 {r.year}</span>}
                                    </div>
                                    {r.tags && r.tags.length > 0 && (
                                        <div className="flex flex-wrap gap-1 mt-1.5">
                                            {r.tags.map((t) => (
                                                <Badge key={t} variant="outline" className="text-[10px] py-0">
                                                    {t}
                                                </Badge>
                                            ))}
                                        </div>
                                    )}
                                </div>
                                <Button
                                    size="sm"
                                    variant={applied === r.id ? "default" : "outline"}
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
                    <p className="text-xs text-zinc-600 flex items-center gap-1">
                        <ExternalLink className="h-3 w-3" />
                        Data from MusicBrainz / Cover Art Archive
                    </p>
                </div>
            )}

            {!searching && results.length === 0 && (
                <div className="text-center py-8 text-zinc-500">
                    <Search className="h-8 w-8 mx-auto mb-2 opacity-50" />
                    <p className="text-sm">
                        Click Search to look up metadata from MusicBrainz
                    </p>
                </div>
            )}
        </div>
    );
}

// --- Playlists Tab ---
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
        loadData();
    }, [loadData]);

    const handleAdd = (playlistId: number) => {
        startTransition(async () => {
            await addTracksToPlaylist(playlistId, [track.id]);
            await loadData();
        });
    };

    const handleRemove = (playlistId: number) => {
        startTransition(async () => {
            await removeTrackFromPlaylist(playlistId, track.id);
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
                <Loader2 className="h-5 w-5 animate-spin text-zinc-500" />
            </div>
        );
    }

    return (
        <div className="space-y-4 pb-4">
            {/* Current playlists */}
            <div>
                <h4 className="text-sm font-medium text-zinc-400 mb-2">
                    In {trackPlaylists.length} playlist
                    {trackPlaylists.length !== 1 ? "s" : ""}
                </h4>
                {trackPlaylists.length === 0 ? (
                    <p className="text-sm text-zinc-600">Not in any playlist yet</p>
                ) : (
                    <div className="space-y-1">
                        {trackPlaylists.map((pl) => (
                            <div
                                key={pl.id}
                                className="flex items-center justify-between rounded-lg border border-[var(--border)] px-3 py-2"
                            >
                                <span className="text-sm font-medium">{pl.name}</span>
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    className="gap-1.5 text-rose-400 hover:text-rose-300 hover:bg-rose-500/10"
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
                    <h4 className="text-sm font-medium text-zinc-400 mb-2">
                        Add to playlist
                    </h4>
                    <div className="space-y-1 max-h-48 overflow-y-auto">
                        {availablePlaylists.map((pl) => (
                            <div
                                key={pl.id}
                                className="flex items-center justify-between rounded-lg border border-[var(--border)] px-3 py-2 hover:border-purple-500/30 transition-colors"
                            >
                                <div>
                                    <span className="text-sm font-medium">{pl.name}</span>
                                    <span className="text-xs text-zinc-500 ml-2">
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
                <div className="text-center py-6 text-zinc-500">
                    <p className="text-sm">
                        No playlists yet. Create one from the Playlists page.
                    </p>
                </div>
            )}
        </div>
    );
}
