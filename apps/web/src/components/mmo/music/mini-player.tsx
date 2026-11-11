"use client";

/**
 * `MusicMiniPlayer` (WP16-40): fixed bottom bar for the web music engine — cover, title/artist (link to Now
 * Playing), prev / play-pause / next, playback settings (crossfade + automix), elapsed time, progress line. Hidden
 * when nothing is queued, after Stop, on the Now Playing page itself, and while a video/live player owns the player
 * bus. Mounted by the media shell.
 */
import "./music.css";
import Link, { usePathname } from "@/components/host/host-context";
import { useTranslations } from "next-intl";
import { useNowPlaying } from "@/lib/mmo/player-bus";
import { fmtClock } from "@/lib/mmo/music-core";
import { useWebMusicProgress, useWebMusicState } from "@/lib/mmo/web-music-player";
import { Cover, NOW_PLAYING_HREF } from "./common";
import { PlaybackSettingsButton } from "./playback-settings";
import { NextButton, PlayPauseButton, PrevButton } from "./transport";
import { useMusic } from "./use-music";

export function MusicMiniPlayer() {
    const t = useTranslations("mx.music.player");
    const { music } = useMusic();
    const st = useWebMusicState();
    const np = useNowPlaying();
    const pathname = usePathname() ?? "";
    const cur = st.hidden ? null : st.current;
    if (!music || !cur || pathname.startsWith(NOW_PLAYING_HREF) || (np && np.kind !== "audio")) return null;
    return (
        <section className="mu-mini" aria-label={t("mini")} data-testid="music-mini-player">
            <Cover src={music.coverUrl(cur, 120)} className="mu-mini-cover" />
            <Link href={NOW_PLAYING_HREF} className="mu-mini-info" aria-label={t("openNowPlaying", { title: cur.title })}>
                <span className="mu-mini-title">{cur.title}</span>
                <span className="mu-mini-sub">{[cur.artist, cur.album].filter(Boolean).join(" · ")}</span>
            </Link>
            <MiniTime fallback={cur.durationSec} />
            <div className="mu-mini-ctl" role="group" aria-label={t("controls")}>
                <PrevButton className="is-optional" />
                <PlayPauseButton st={st} />
                <NextButton />
                <PlaybackSettingsButton variant="mini" className="is-optional" />
            </div>
            <MiniBar fallback={cur.durationSec} />
        </section>
    );
}

function MiniTime({ fallback }: { fallback: number }) {
    const pr = useWebMusicProgress();
    return <span className="mu-mini-time">{fmtClock(pr.position)} / {fmtClock(pr.duration || fallback)}</span>;
}

function MiniBar({ fallback }: { fallback: number }) {
    const pr = useWebMusicProgress();
    const d = pr.duration || fallback;
    const pct = d > 0 ? Math.min(1, pr.position / d) : 0;
    return <span className="mu-mini-bar" aria-hidden><span style={{ transform: `scaleX(${pct})` }} /></span>;
}
