"use client";

/** Transport buttons shared by Now Playing and the mini-player (aria labels + pressed state). */
import { useTranslations } from "next-intl";
import { Pause, Play, Repeat, Repeat1, Shuffle, SkipBack, SkipForward } from "lucide-react";
import type { WebMusicState } from "@/lib/mmo/web-music-player";
import { webMusicPlayer } from "@/lib/mmo/web-music-player";

export function PlayPauseButton({ st, className = "" }: { st: WebMusicState; className?: string }) {
    const t = useTranslations("mx.music.player");
    return (
        <button type="button" className={`np-ctl is-main ${className}`} onClick={() => webMusicPlayer.toggle()}
            aria-label={st.playing ? t("pause") : t("play")} data-testid="music-toggle">
            {st.playing ? <Pause aria-hidden className="size-6" /> : <Play aria-hidden className="size-6" />}
        </button>
    );
}

export function PrevButton({ className = "" }: { className?: string }) {
    const t = useTranslations("mx.music.player");
    return <button type="button" className={`np-ctl ${className}`} onClick={() => webMusicPlayer.prev()} aria-label={t("prev")}><SkipBack aria-hidden className="size-5" /></button>;
}

export function NextButton({ className = "" }: { className?: string }) {
    const t = useTranslations("mx.music.player");
    return <button type="button" className={`np-ctl ${className}`} onClick={() => webMusicPlayer.next()} aria-label={t("next")}><SkipForward aria-hidden className="size-5" /></button>;
}

export function ShuffleButton({ st, className = "" }: { st: WebMusicState; className?: string }) {
    const t = useTranslations("mx.music.player");
    return (
        <button type="button" className={`np-ctl ${className}`} aria-pressed={st.shuffle} aria-label={t("shuffle")}
            onClick={() => webMusicPlayer.setShuffle(!st.shuffle)}>
            <Shuffle aria-hidden className="size-5" />
        </button>
    );
}

export function RepeatButton({ st, className = "" }: { st: WebMusicState; className?: string }) {
    const t = useTranslations("mx.music.player");
    const label = st.repeat === "off" ? t("repeatOff") : st.repeat === "all" ? t("repeatAll") : t("repeatOne");
    return (
        <button type="button" className={`np-ctl ${className}`} aria-pressed={st.repeat !== "off"} aria-label={label} title={label}
            onClick={() => webMusicPlayer.cycleRepeat()}>
            {st.repeat === "one" ? <Repeat1 aria-hidden className="size-5" /> : <Repeat aria-hidden className="size-5" />}
        </button>
    );
}
