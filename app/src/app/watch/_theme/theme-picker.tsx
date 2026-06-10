"use client";

import { Check } from "lucide-react";
import { useWatchTheme } from "./watch-theme-provider";
import { WATCH_THEMES, type WatchThemeId } from "./themes";

/** Reusable theme grid. Used both on /watch/settings and inside the
 *  WatchSettingsModal. Renders one tile per registered theme; selecting
 *  one applies it instantly (no save button — theme state is local). */
export function ThemePicker() {
    const { theme, setTheme } = useWatchTheme();

    return (
        <div className="theme-grid" role="radiogroup" aria-label="Watch theme">
            {WATCH_THEMES.map((t) => (
                <button
                    key={t.id}
                    type="button"
                    role="radio"
                    aria-checked={theme === t.id}
                    className={`theme-card${theme === t.id ? " is-active" : ""}`}
                    onClick={() => setTheme(t.id as WatchThemeId)}
                >
                    <div className="theme-card-swatch" aria-hidden>
                        {t.swatch.map((c, i) => (
                            <span key={i} style={{ background: c }} />
                        ))}
                    </div>
                    <div className="theme-card-name">{t.label}</div>
                    <div className="theme-card-blurb">{t.blurb}</div>
                    <span className="theme-card-check" aria-hidden>
                        <Check size={14} strokeWidth={3} />
                    </span>
                </button>
            ))}
        </div>
    );
}
