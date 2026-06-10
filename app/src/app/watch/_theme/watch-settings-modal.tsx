"use client";

/**
 * Tabbed Watch settings modal. Fetches `WatchPrefs` once on open and feeds
 * them into each panel so individual tabs render instantly when switched.
 */
import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ThemePicker } from "./theme-picker";
import { ImportLibraryButton } from "@/app/watch/_import-button";
import { DEFAULT_WATCH_THEME, type WatchThemeId } from "./themes";
import { getWatchPrefs } from "@/actions/watch-prefs";
import { DEFAULT_PREFS, type WatchPrefs } from "@/lib/watch-prefs";
import { WatchPrefsPanel } from "@/components/settings/watch-prefs-panel";
import {
    WatchFiltersPanel,
    WatchAspectPanel,
    WatchPlaybackPanel,
} from "@/components/video/watch-quick-panels";
import { RefetchMetadataButtons } from "@/components/video/refetch-metadata-buttons";

interface Props {
    open: boolean;
    onClose: () => void;
}

type TabId = "aspect" | "playback" | "library" | "filters" | "profiles" | "advanced";

const TABS: Array<{ id: TabId; label: string }> = [
    { id: "aspect", label: "Aspect" },
    { id: "playback", label: "Playback" },
    { id: "library", label: "Library" },
    { id: "filters", label: "Filters" },
    { id: "profiles", label: "Profiles" },
    { id: "advanced", label: "Advanced" },
];

export function WatchSettingsModal({ open, onClose }: Props) {
    const [theme, setTheme] = useState<WatchThemeId>(DEFAULT_WATCH_THEME);
    const [tab, setTab] = useState<TabId>("aspect");
    const [prefs, setPrefs] = useState<WatchPrefs | null>(null);

    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
        document.addEventListener("keydown", onKey);
        const prev = document.body.style.overflow;
        document.body.style.overflow = "hidden";
        const current = document.querySelector<HTMLElement>(".watch-shell")?.dataset.watchTheme as WatchThemeId | undefined;
        if (current) setTheme(current);
        let cancelled = false;
        getWatchPrefs().then((p) => { if (!cancelled) setPrefs(p); }).catch(() => { if (!cancelled) setPrefs(DEFAULT_PREFS); });
        return () => {
            cancelled = true;
            document.removeEventListener("keydown", onKey);
            document.body.style.overflow = prev;
        };
    }, [open, onClose]);

    if (!open || typeof window === "undefined") return null;

    return createPortal(
        <div className="watch-shell watch-modal-portal" data-watch-theme={theme}>
            <div className="watch-modal-backdrop" onClick={onClose} aria-hidden />
            <div className="watch-modal" role="dialog" aria-modal="true" aria-labelledby="watch-settings-title">
                <header className="watch-modal-head">
                    <div className="watch-modal-title" id="watch-settings-title">Watch settings</div>
                    <button type="button" className="watch-modal-close" aria-label="Close" onClick={onClose}>
                        <X size={18} />
                    </button>
                </header>

                <nav className="watch-tabs" role="tablist">
                    {TABS.map((t) => (
                        <button
                            key={t.id}
                            type="button"
                            role="tab"
                            aria-selected={tab === t.id}
                            className={`watch-tab${tab === t.id ? " is-active" : ""}`}
                            onClick={() => setTab(t.id)}
                        >
                            {t.label}
                        </button>
                    ))}
                </nav>

                {tab === "aspect" && (
                    <section className="watch-modal-section">
                        <h3 className="watch-modal-section-title">Theme</h3>
                        <p className="watch-settings-blurb">Visual style. Applies instantly and persists per device.</p>
                        <ThemePicker />
                        {prefs && <div style={{ marginTop: "1rem" }}><WatchAspectPanel initial={prefs} /></div>}
                    </section>
                )}

                {tab === "playback" && prefs && (
                    <section className="watch-modal-section">
                        <h3 className="watch-modal-section-title">Playback &amp; subtitles</h3>
                        <p className="watch-settings-blurb">Autoplay, trailers, subtitle preferences.</p>
                        <WatchPlaybackPanel initial={prefs} />
                        <div style={{ marginTop: "1rem" }}>
                            <WatchPrefsPanel initial={prefs} />
                        </div>
                    </section>
                )}

                {tab === "library" && (
                    <section className="watch-modal-section">
                        <h3 className="watch-modal-section-title">Library</h3>
                        <p className="watch-settings-blurb">Scan local folders and refresh TMDB metadata.</p>
                        <ImportLibraryButton />
                        <div style={{ marginTop: "1rem" }}>
                            <RefetchMetadataButtons />
                        </div>
                    </section>
                )}

                {tab === "filters" && prefs && (
                    <section className="watch-modal-section">
                        <h3 className="watch-modal-section-title">Discovery filters</h3>
                        <p className="watch-settings-blurb">Control what shows up on the Watch home and discover rows.</p>
                        <WatchFiltersPanel initial={prefs} />
                    </section>
                )}

                {tab === "profiles" && (
                    <section className="watch-modal-section">
                        <h3 className="watch-modal-section-title">Profiles</h3>
                        <p className="watch-settings-blurb">Manage watch profiles for each member of the household.</p>
                        <p style={{ marginTop: "0.75rem" }}>
                            <a href="/watch/profiles" className="watch-btn watch-btn-ghost" onClick={onClose}>Open profile manager →</a>
                        </p>
                    </section>
                )}

                {tab === "advanced" && (
                    <section className="watch-modal-section">
                        <h3 className="watch-modal-section-title">Advanced</h3>
                        <p className="watch-settings-blurb">Companion status, cache, telemetry.</p>
                        <p style={{ marginTop: "0.75rem", display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                            <a href="/settings" className="watch-btn watch-btn-ghost" onClick={onClose}>Global settings →</a>
                            <a href="/watch/settings" className="watch-btn watch-btn-ghost" onClick={onClose}>Full watch settings →</a>
                        </p>
                    </section>
                )}
            </div>
        </div>,
        document.body,
    );
}
