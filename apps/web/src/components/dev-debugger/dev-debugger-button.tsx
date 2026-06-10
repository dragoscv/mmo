"use client";

/**
 * DevDebuggerButton — small icon button that toggles the floating overlay.
 * Drop anywhere; the overlay portals itself to <body>.
 */

import { useEffect, useState } from "react";
import { Bug } from "lucide-react";
import { DevDebuggerOverlay } from "./dev-debugger-overlay";
import { installAppDebugSources } from "@/lib/dev-debugger/bootstrap-mmo";

export function DevDebuggerButton({ className }: { className?: string }) {
    const [open, setOpen] = useState(false);
    useEffect(() => { installAppDebugSources(); }, []);
    return (
        <>
            <button
                type="button"
                onClick={() => setOpen((o) => !o)}
                title={open ? "Close debug overlay" : "Open debug overlay"}
                className={
                    className ??
                    "text-white/15 hover:text-emerald-400 transition-colors cursor-pointer"
                }
            >
                <Bug className="h-3 w-3" />
            </button>
            <DevDebuggerOverlay open={open} onClose={() => setOpen(false)} />
        </>
    );
}
