"use client";

/**
 * Discovery filters + playback toggles tab. Persists to WatchPrefs.
 */
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { saveWatchPrefs } from "@/actions/watch-prefs";
import type { WatchPrefs } from "@/lib/watch-prefs";

interface Props { initial: WatchPrefs }

export function WatchFiltersPanel({ initial }: Props) {
    const [prefs, setPrefs] = useState<WatchPrefs>(initial);
    const [pending, start] = useTransition();

    const persist = (patch: Partial<WatchPrefs>) => {
        const next = { ...prefs, ...patch };
        setPrefs(next);
        start(async () => {
            const r = await saveWatchPrefs(patch);
            if (!r.ok) toast.error("Save failed");
        });
    };

    return (
        <div className="watch-prefs-grid">
            <Row label="Local only" hint="Hide rows that aren't in your library (Trending, For you).">
                <Switch checked={prefs.localOnly} onChange={(v) => persist({ localOnly: v })} disabled={pending} />
            </Row>
            <Row label="Hide watched" hint="Exclude items you've already finished from discover rows.">
                <Switch checked={prefs.hideWatched} onChange={(v) => persist({ hideWatched: v })} disabled={pending} />
            </Row>
            <Row label="Include adult content" hint="Show adult-rated items in TMDB results.">
                <Switch checked={prefs.includeAdult} onChange={(v) => persist({ includeAdult: v })} disabled={pending} />
            </Row>
            <Row label={`Minimum TMDB rating (${prefs.minRating.toFixed(1)})`} hint="Filter out items below this score (0 = no filter).">
                <input
                    type="range"
                    min={0}
                    max={10}
                    step={0.5}
                    value={prefs.minRating}
                    onChange={(e) => persist({ minRating: parseFloat(e.target.value) })}
                    disabled={pending}
                    style={{ width: "180px" }}
                />
            </Row>
        </div>
    );
}

export function WatchPlaybackPanel({ initial }: Props) {
    const [prefs, setPrefs] = useState<WatchPrefs>(initial);
    const [pending, start] = useTransition();

    const persist = (patch: Partial<WatchPrefs>) => {
        const next = { ...prefs, ...patch };
        setPrefs(next);
        start(async () => {
            const r = await saveWatchPrefs(patch);
            if (!r.ok) toast.error("Save failed");
        });
    };

    return (
        <div className="watch-prefs-grid">
            <Row label="Autoplay next episode" hint="Continue to the next episode automatically when credits start.">
                <Switch checked={prefs.autoplayNext} onChange={(v) => persist({ autoplayNext: v })} disabled={pending} />
            </Row>
            <Row label="Autoplay trailer on hover" hint="Play the trailer muted inside the hover preview.">
                <Switch checked={prefs.autoplayTrailer} onChange={(v) => persist({ autoplayTrailer: v })} disabled={pending} />
            </Row>
            <Row label="Subtitle offset" hint={`Shift all subtitles by ${prefs.subtitleOffsetSec.toFixed(1)}s.`}>
                <input
                    type="range"
                    min={-5}
                    max={5}
                    step={0.1}
                    value={prefs.subtitleOffsetSec}
                    onChange={(e) => persist({ subtitleOffsetSec: parseFloat(e.target.value) })}
                    disabled={pending}
                    style={{ width: "180px" }}
                />
            </Row>
        </div>
    );
}

export function WatchAspectPanel({ initial }: Props) {
    const [prefs, setPrefs] = useState<WatchPrefs>(initial);
    const [pending, start] = useTransition();

    const persist = (patch: Partial<WatchPrefs>) => {
        const next = { ...prefs, ...patch };
        setPrefs(next);
        start(async () => {
            const r = await saveWatchPrefs(patch);
            if (!r.ok) toast.error("Save failed");
        });
    };

    return (
        <div className="watch-prefs-grid">
            <Row label="Poster size" hint="Compact rows or chunky cinematic tiles.">
                <div style={{ display: "inline-flex", gap: "0.35rem" }}>
                    {(["sm", "md", "lg"] as const).map((s) => (
                        <button key={s} type="button"
                            onClick={() => persist({ posterSize: s })}
                            className={`watch-pill${prefs.posterSize === s ? " is-active" : ""}`}
                            disabled={pending}>{s.toUpperCase()}</button>
                    ))}
                </div>
            </Row>
            <Row label="Reduce motion" hint="Disable hover popovers, autoplay trailers, and large transitions.">
                <Switch checked={prefs.reduceMotion} onChange={(v) => persist({ reduceMotion: v })} disabled={pending} />
            </Row>
        </div>
    );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
    return (
        <div className="watch-prefs-row">
            <div>
                <div className="watch-prefs-label">{label}</div>
                {hint && <div className="watch-prefs-hint">{hint}</div>}
            </div>
            <div>{children}</div>
        </div>
    );
}

function Switch({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
    return (
        <button type="button" role="switch" aria-checked={checked} disabled={disabled}
            onClick={() => onChange(!checked)}
            className={`watch-topbar-switch${checked ? " is-on" : ""}`}
            style={{ width: 36, height: 20, border: 0, padding: 0, cursor: disabled ? "default" : "pointer" }}>
            <span className="watch-topbar-switch-knob" style={{ width: 16, height: 16, transform: checked ? "translateX(16px)" : undefined }} />
        </button>
    );
}
