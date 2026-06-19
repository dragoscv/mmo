"use client";

/**
 * Compact "Reanalyze" button driven by the global AnalysisProvider context
 * (same engine as the dashboard's "Reanalyze Library" action). Drop it in
 * any toolbar — it reflects live status (idle / analyzing % / review N).
 */

import { Sparkles, Loader2, Eye } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAnalysisContext } from "@/hooks/analysis-context";

export function ReanalyzeButton({ className }: { className?: string }) {
    const { openModal, status, progress, total, changesCount } = useAnalysisContext();

    const isActive = status === "running" || status === "paused";
    const needsReview = status === "completed" || status === "stopped";
    const progressPct = total > 0 ? Math.round((progress / total) * 100) : 0;

    const label = isActive
        ? `Analyzing ${progressPct}%`
        : needsReview
            ? `Review ${changesCount}`
            : "Reanalyze";

    const Icon = isActive ? Loader2 : needsReview ? Eye : Sparkles;

    return (
        <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={openModal}
            title="Analyze tracks with missing metadata, BPM/key, artwork, lyrics"
            className={cn(
                "h-8 gap-1.5",
                isActive
                    ? "text-purple-400"
                    : needsReview
                        ? "text-amber-400"
                        : "text-purple-400 hover:text-purple-300",
                className,
            )}
        >
            <Icon className={cn("h-3.5 w-3.5", isActive && "animate-spin")} />
            {label}
        </Button>
    );
}
