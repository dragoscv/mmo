"use client";

/**
 * Slim sticky top bar for the /watch shell. Hosts the "Local only" switch
 * and the Settings button (which opens the tabbed WatchSettingsModal).
 * Replaces the bottom-right FAB on the /watch home — keeps controls in
 * thumb-reach on TV remotes and within scan-path on desktop.
 */
import { useState, useTransition } from "react";
import { Settings as SettingsIcon, HardDrive } from "lucide-react";
import { WatchSettingsModal } from "@/app/watch/_theme/watch-settings-modal";
import { saveWatchPrefs } from "@/actions/watch-prefs";

interface Props {
    initialLocalOnly: boolean;
}

export function WatchTopBar({ initialLocalOnly }: Props) {
    const [open, setOpen] = useState(false);
    const [localOnly, setLocalOnly] = useState(initialLocalOnly);
    const [pending, startTransition] = useTransition();

    const toggleLocal = () => {
        const next = !localOnly;
        setLocalOnly(next);
        startTransition(async () => {
            await saveWatchPrefs({ localOnly: next });
            // Use a hard navigation rather than router.refresh() to avoid
            // a Turbopack RSC streaming race when Suspense boundaries
            // appear/disappear between renders.
            window.location.reload();
        });
    };

    return (
        <>
            <div className="watch-topbar">
                <button
                    type="button"
                    role="switch"
                    aria-checked={localOnly}
                    onClick={toggleLocal}
                    className={`watch-topbar-toggle${localOnly ? " is-on" : ""}`}
                    disabled={pending}
                    title={localOnly ? "Showing only items in your library" : "Show only items in your library"}
                >
                    <HardDrive size={12} />
                    <span>Local only</span>
                    <span className="watch-topbar-switch" aria-hidden>
                        <span className="watch-topbar-switch-knob" />
                    </span>
                </button>
                <button
                    type="button"
                    className="watch-topbar-btn"
                    onClick={() => setOpen(true)}
                    aria-label="Watch settings"
                >
                    <SettingsIcon size={13} />
                </button>
            </div>
            <WatchSettingsModal open={open} onClose={() => setOpen(false)} />
        </>
    );
}
