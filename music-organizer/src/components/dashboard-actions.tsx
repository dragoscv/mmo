"use client";

import { useState } from "react";
import Link from "next/link";
import { ScanSearch, FileDown, FolderOpen, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AnalyzeModal } from "@/components/analyze-modal";
import { exportRekordboxXml } from "@/actions/export";
import { toast } from "sonner";

export function DashboardActions() {
    const [analyzeOpen, setAnalyzeOpen] = useState(false);

    async function handleExport() {
        const result = await exportRekordboxXml();
        if (result.success) {
            toast.success(
                `Exported ${result.trackCount} tracks, ${result.playlistCount} playlists`,
                { description: result.path }
            );
        }
    }

    return (
        <div className="space-y-3">
            <Button
                variant="outline"
                className="w-full justify-start gap-3 border-purple-500/30 hover:bg-purple-500/10 hover:text-purple-400 cursor-pointer"
                onClick={() => setAnalyzeOpen(true)}
            >
                <Sparkles className="h-4 w-4 text-purple-400" />
                Reanalyze Library
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

            <AnalyzeModal open={analyzeOpen} onOpenChange={setAnalyzeOpen} />
        </div>
    );
}
