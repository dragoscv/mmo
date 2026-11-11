"use client";

/**
 * Playback settings of the web music engine (WP17-44 on the web): crossfade length (0 = gapless) and automix
 * (beat-matched crossfades). A popover behind one button; the values live in `webMusicPlayer` (persisted on this
 * device) and apply from the next transition. `variant="mini"` renders the round control used by the mini-player
 * and Now Playing, `variant="button"` the outline icon button of page headers.
 */
import "./music.css";
import { useId } from "react";
import { useTranslations } from "next-intl";
import { SlidersHorizontal } from "lucide-react";
import { Button, Popover, PopoverContent, PopoverTitle, PopoverTrigger, Switch } from "@mmo/ui";
import { MAX_CROSSFADE_SEC } from "@/lib/mmo/music-core";
import { useWebMusicPlayback, webMusicPlayer } from "@/lib/mmo/web-music-player";

export function PlaybackSettingsButton({ variant = "button", className = "" }: { variant?: "button" | "mini"; className?: string }) {
    const t = useTranslations("mx.music.playback");
    const label = t("open");
    return (
        <Popover>
            {variant === "mini" ? (
                <PopoverTrigger className={`np-ctl ${className}`} aria-label={label} title={label} data-testid="music-playback-open">
                    <SlidersHorizontal aria-hidden className="size-5" />
                </PopoverTrigger>
            ) : (
                <PopoverTrigger render={<Button variant="outline" size="icon" className={className} aria-label={label} title={label} data-testid="music-playback-open" />}>
                    <SlidersHorizontal aria-hidden />
                </PopoverTrigger>
            )}
            <PopoverContent align="end" side={variant === "mini" ? "top" : "bottom"}>
                <PlaybackSettings />
            </PopoverContent>
        </Popover>
    );
}

/** Popover body: crossfade slider + automix switch. */
function PlaybackSettings() {
    const t = useTranslations("mx.music.playback");
    const pb = useWebMusicPlayback();
    const id = useId();
    const value = pb.crossfadeSec === 0 ? t("crossfadeOff") : t("crossfadeSeconds", { count: pb.crossfadeSec });
    return (
        <div className="mu-pb" data-testid="music-playback">
            <PopoverTitle className="mu-pb-title">{t("title")}</PopoverTitle>
            <div className="mu-pb-field">
                <div className="mu-pb-row">
                    <label htmlFor={`${id}-xf`}>{t("crossfade")}</label>
                    <span className="mu-pb-value" aria-hidden>{value}</span>
                </div>
                <input id={`${id}-xf`} type="range" className="mu-pb-range" min={0} max={MAX_CROSSFADE_SEC} step={1} value={pb.crossfadeSec}
                    aria-valuetext={value} aria-describedby={`${id}-xf-hint`} data-testid="music-crossfade"
                    onChange={(e) => webMusicPlayer.setPlayback({ crossfadeSec: Number(e.target.value) })} />
                <p id={`${id}-xf-hint`} className="mu-pb-hint">{t("crossfadeHint")}</p>
            </div>
            <div className="mu-pb-field">
                <label className="mu-pb-row mu-pb-switch">
                    <span>{t("automix")}</span>
                    <Switch checked={pb.automix} onCheckedChange={(v) => webMusicPlayer.setPlayback({ automix: v })}
                        aria-describedby={`${id}-am-hint`} data-testid="music-automix" />
                </label>
                <p id={`${id}-am-hint`} className="mu-pb-hint">{t("automixHint")}</p>
            </div>
        </div>
    );
}
