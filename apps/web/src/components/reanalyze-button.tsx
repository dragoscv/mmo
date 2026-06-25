"use client";

/**
 * Compact "Analyze" button. The metadata/DSP/stems/fingerprint analysis now
 * lives entirely on the /analysis page (companion-driven, durable across
 * refresh) — this button simply routes there instead of opening a modal.
 */

import { Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function ReanalyzeButton({ className }: { className?: string }) {
    const router = useRouter();
    return (
        <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => router.push("/analysis")}
            title="Open the analysis page (metadata, BPM/key, artwork, lyrics, stems)"
            className={cn("h-8 gap-1.5 text-purple-400 hover:text-purple-300", className)}
        >
            <Sparkles className="h-3.5 w-3.5" />
            Analyze
        </Button>
    );
}
