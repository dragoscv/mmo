"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
    ChevronDown,
    ChevronRight,
    Check,
    CheckSquare,
    Square,
    Loader2,
    Sparkles,
    ListPlus,
    CheckCheck,
} from "lucide-react";
import {
    createRecommendedPlaylists,
    type RecommendedCategory,
} from "@/actions/playlists";

interface PlaylistRecommendationsProps {
    categories: RecommendedCategory[];
}

export function PlaylistRecommendations({
    categories,
}: PlaylistRecommendationsProps) {
    const router = useRouter();
    const [isPending, startTransition] = useTransition();
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [expandedCats, setExpandedCats] = useState<Set<string>>(
        new Set(
            categories
                .filter((c) => c.existingCount < c.totalCount)
                .map((c) => c.category)
        )
    );
    const [result, setResult] = useState<{ created: number } | null>(null);

    const totalMissing = categories.reduce(
        (sum, c) => sum + c.totalCount - c.existingCount,
        0
    );
    const totalExisting = categories.reduce(
        (sum, c) => sum + c.existingCount,
        0
    );
    const totalRecommended = categories.reduce(
        (sum, c) => sum + c.totalCount,
        0
    );

    if (totalMissing === 0) {
        return (
            <div className="rounded-xl border border-green-500/20 bg-green-500/5 p-6 text-center">
                <CheckCheck className="h-8 w-8 mx-auto mb-3 text-green-400" />
                <p className="text-sm font-medium text-green-400">
                    All recommended playlists created
                </p>
                <p className="text-xs text-[var(--muted-foreground)] mt-1">
                    You have all {totalRecommended} recommended playlists. Nice!
                </p>
            </div>
        );
    }

    function toggleCategory(category: string) {
        setExpandedCats((prev) => {
            const next = new Set(prev);
            if (next.has(category)) next.delete(category);
            else next.add(category);
            return next;
        });
    }

    function togglePlaylist(name: string) {
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(name)) next.delete(name);
            else next.add(name);
            return next;
        });
    }

    function selectAllMissing() {
        const missing = categories
            .flatMap((c) => c.playlists)
            .filter((p) => !p.exists)
            .map((p) => p.name);
        setSelected(new Set(missing));
    }

    function deselectAll() {
        setSelected(new Set());
    }

    function selectCategoryMissing(category: RecommendedCategory) {
        setSelected((prev) => {
            const next = new Set(prev);
            for (const p of category.playlists) {
                if (!p.exists) next.add(p.name);
            }
            return next;
        });
    }

    async function handleCreate() {
        if (selected.size === 0) return;
        startTransition(async () => {
            const res = await createRecommendedPlaylists(
                Array.from(selected)
            );
            setResult(res);
            setSelected(new Set());
            router.refresh();
        });
    }

    return (
        <div className="space-y-4">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-purple-500/20">
                        <Sparkles className="h-5 w-5 text-purple-400" />
                    </div>
                    <div>
                        <h3 className="text-sm font-semibold">
                            Recommended Playlists
                        </h3>
                        <p className="text-xs text-[var(--muted-foreground)]">
                            {totalExisting}/{totalRecommended} created
                            {totalMissing > 0 && (
                                <span className="text-amber-400 ml-1">
                                    — {totalMissing} missing
                                </span>
                            )}
                        </p>
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    {selected.size > 0 ? (
                        <button
                            onClick={deselectAll}
                            className="text-xs text-[var(--muted-foreground)] hover:text-[var(--foreground)] cursor-pointer"
                        >
                            Clear
                        </button>
                    ) : (
                        <button
                            onClick={selectAllMissing}
                            className="text-xs text-purple-400 hover:text-purple-300 cursor-pointer"
                        >
                            Select all missing
                        </button>
                    )}
                </div>
            </div>

            {/* Result toast */}
            {result && (
                <div className="rounded-lg border border-green-500/20 bg-green-500/10 px-4 py-2.5 text-sm text-green-400 flex items-center gap-2">
                    <Check className="h-4 w-4" />
                    Created {result.created} playlist
                    {result.created !== 1 ? "s" : ""}!
                </div>
            )}

            {/* Categories */}
            <div className="space-y-2">
                {categories.map((cat) => {
                    const isExpanded = expandedCats.has(cat.category);
                    const missing = cat.playlists.filter((p) => !p.exists);
                    const selectedInCat = cat.playlists.filter(
                        (p) => !p.exists && selected.has(p.name)
                    ).length;

                    return (
                        <div
                            key={cat.category}
                            className="rounded-lg border border-[var(--border)] overflow-hidden"
                        >
                            {/* Category header */}
                            <button
                                onClick={() => toggleCategory(cat.category)}
                                className={cn(
                                    "flex items-center gap-3 w-full px-4 py-3 text-left transition-colors hover:bg-[var(--accent)] cursor-pointer",
                                    isExpanded && "border-b border-[var(--border)]"
                                )}
                            >
                                {isExpanded ? (
                                    <ChevronDown className="h-4 w-4 shrink-0 text-[var(--muted-foreground)]" />
                                ) : (
                                    <ChevronRight className="h-4 w-4 shrink-0 text-[var(--muted-foreground)]" />
                                )}
                                <span className="text-base">{cat.icon}</span>
                                <div className="flex-1 min-w-0">
                                    <p className="text-sm font-medium">
                                        {cat.category}
                                    </p>
                                    <p className="text-xs text-[var(--muted-foreground)]">
                                        {cat.description}
                                    </p>
                                </div>
                                <div className="flex items-center gap-2 shrink-0">
                                    {missing.length > 0 ? (
                                        <span className="text-xs text-amber-400 tabular-nums">
                                            {missing.length} missing
                                        </span>
                                    ) : (
                                        <span className="text-xs text-green-400">
                                            <Check className="h-3.5 w-3.5 inline" /> All
                                            created
                                        </span>
                                    )}
                                </div>
                            </button>

                            {/* Playlist items */}
                            {isExpanded && (
                                <div className="px-2 py-1.5">
                                    {missing.length > 1 && (
                                        <button
                                            onClick={() =>
                                                selectCategoryMissing(cat)
                                            }
                                            className="text-xs text-purple-400 hover:text-purple-300 px-2 py-1 mb-1 cursor-pointer"
                                        >
                                            Select all in {cat.category}{" "}
                                            {selectedInCat > 0 &&
                                                `(${selectedInCat}/${missing.length})`}
                                        </button>
                                    )}
                                    {cat.playlists.map((pl) => (
                                        <div
                                            key={pl.name}
                                            className={cn(
                                                "flex items-center gap-3 rounded-md px-2 py-2 text-sm transition-colors",
                                                pl.exists
                                                    ? "opacity-50"
                                                    : "hover:bg-[var(--accent)] cursor-pointer"
                                            )}
                                            onClick={() =>
                                                !pl.exists &&
                                                togglePlaylist(pl.name)
                                            }
                                        >
                                            {pl.exists ? (
                                                <Check className="h-4 w-4 text-green-400 shrink-0" />
                                            ) : selected.has(pl.name) ? (
                                                <CheckSquare className="h-4 w-4 text-purple-400 shrink-0" />
                                            ) : (
                                                <Square className="h-4 w-4 text-[var(--muted-foreground)] shrink-0" />
                                            )}
                                            <div className="flex-1 min-w-0">
                                                <p
                                                    className={cn(
                                                        "font-medium truncate",
                                                        pl.exists &&
                                                        "line-through"
                                                    )}
                                                >
                                                    {pl.name}
                                                </p>
                                                <p className="text-xs text-[var(--muted-foreground)] truncate">
                                                    {pl.description}
                                                </p>
                                            </div>
                                            {pl.exists && (
                                                <span className="text-xs text-green-400/70">
                                                    exists
                                                </span>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>

            {/* Create button */}
            {selected.size > 0 && (
                <div className="flex items-center justify-between rounded-lg border border-purple-500/20 bg-purple-500/5 px-4 py-3">
                    <p className="text-sm">
                        <span className="font-medium text-purple-400">
                            {selected.size}
                        </span>{" "}
                        <span className="text-[var(--muted-foreground)]">
                            playlist{selected.size !== 1 ? "s" : ""} selected
                        </span>
                    </p>
                    <Button
                        size="sm"
                        onClick={handleCreate}
                        disabled={isPending}
                        className="gap-2"
                    >
                        {isPending ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                            <ListPlus className="h-4 w-4" />
                        )}
                        Create {selected.size} Playlist
                        {selected.size !== 1 ? "s" : ""}
                    </Button>
                </div>
            )}
        </div>
    );
}
