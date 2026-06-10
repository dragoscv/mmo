"use client";

/**
 * Refetch buttons for the Library tab. Calls server actions in a
 * transition and toasts the result. Delta = only entries with empty
 * overview. Force = overwrite all (re-fetches every row).
 */
import { useTransition } from "react";
import { Languages, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { refetchMetadataDelta, refetchMetadataForce } from "@/actions/refetch-metadata";

export function RefetchMetadataButtons() {
    const [pending, start] = useTransition();
    const run = (mode: "delta" | "force") => {
        start(async () => {
            const fn = mode === "force" ? refetchMetadataForce : refetchMetadataDelta;
            const r = await fn();
            if (!r.ok) { toast.error("Refetch failed"); return; }
            toast.success(
                `Updated ${r.moviesUpdated} movies, ${r.showsUpdated} shows (skipped ${r.moviesSkipped + r.showsSkipped})`,
            );
        });
    };
    return (
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
            <button type="button" className="watch-btn watch-btn-ghost" onClick={() => run("delta")} disabled={pending}>
                <Languages size={14} />
                <span>Fill missing metadata</span>
            </button>
            <button type="button" className="watch-btn watch-btn-ghost" onClick={() => run("force")} disabled={pending}>
                <RefreshCw size={14} />
                <span>Force re-fetch (current locale)</span>
            </button>
        </div>
    );
}
