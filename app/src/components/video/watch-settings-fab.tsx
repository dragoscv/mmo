"use client";

/**
 * Floating settings button. Lives bottom-right (above the Now Playing
 * dock), opens the theme picker modal. Replaces the explicit top bar
 * for /watch — minimal chrome, maximum cinematic feel.
 */
import { useState } from "react";
import { Settings as SettingsIcon } from "lucide-react";
import { WatchSettingsModal } from "@/app/watch/_theme/watch-settings-modal";

export function WatchSettingsFab() {
    const [open, setOpen] = useState(false);
    return (
        <>
            <button
                type="button"
                className="watch-settings-fab"
                onClick={() => setOpen(true)}
                aria-label="Watch settings"
            >
                <SettingsIcon size={18} />
            </button>
            <WatchSettingsModal open={open} onClose={() => setOpen(false)} />
        </>
    );
}
