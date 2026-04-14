"use client";

import Link from "next/link";
import { ScanSearch, FileDown, FolderOpen, Sparkles, Loader2, Eye } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAnalysisContext } from "@/hooks/analysis-context";
import { exportRekordboxXml } from "@/actions/export";
import { toast } from "sonner";

export function DashboardActions() {
    const { openModal, status, progress, total, changesCount } = useAnalysisContext();

    async function handleExport() {
        const result = await exportRekordboxXml();
        if (result.success) {
            toast.success(
                `Exported ${result.trackCount} tracks, ${result.playlistCount} playlists`,
                { description: result.path }
            );
        }
    }

    const isActive = status === "running" || status === "paused";
    const needsReview = status === "completed" || status === "stopped";
    const progressPct = total > 0 ? Math.round((progress / total) * 100) : 0;

    const buttonLabel = isActive
        ? `Analyzing... ${progressPct}%`
        : needsReview
            ? `Review ${changesCount} Change${changesCount !== 1 ? "s" : ""}`
            : "Reanalyze Library";

    const ButtonIcon = isActive
        ? Loader2
        : needsReview
            ? Eye
            : Sparkles;

    return (
        <div className="space-y-3">
            <Button
                variant="outline"
                className={cn(
                    "w-full justify-start gap-3 cursor-pointer",
                    isActive
                        ? "border-purple-500/50 bg-purple-500/5 hover:bg-purple-500/10 text-purple-400"
                        : needsReview
                            ? "border-amber-500/30 bg-amber-500/5 hover:bg-amber-500/10 text-amber-400"
                            : "border-purple-500/30 hover:bg-purple-500/10 hover:text-purple-400"
                )}
                onClick={openModal}
            >
                <ButtonIcon className={cn("h-4 w-4", isActive && "animate-spin", !isActive && !needsReview && "text-purple-400")} />
                {buttonLabel}
            </Button>

            <Link href="/scanner" className="block">
                <Button variant="outline" className="w-full justify-start gap-3">
                    <ScanSearch className="h-4 w-4" />
                    Scan Folder
                </Button>
            </Link>

            <Button
                variant="outline"
                className="w-full justify-start gap-3"
                onClick={handleExport}
            >
                <FileDown className="h-4 w-4" />
                Export Rekordbox XML
            </Button>

            <Link href="/library" className="block">
                <Button variant="outline" className="w-full justify-start gap-3">
                    <FolderOpen className="h-4 w-4" />
                    Browse Library
                </Button>
            </Link>
        </div>
    );
}
