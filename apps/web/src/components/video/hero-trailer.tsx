"use client";

/**
 * Netflix-style hero trailer for `/watch/movies/[id]` and similar detail
 * pages. Renders the static backdrop image immediately, then layers a
 * muted, autoplaying YouTube iframe on top so the trailer "keeps going"
 * after the user clicks through from the hover preview.
 *
 * Continuity: the hover popover writes
 *   sessionStorage["mmo:trailer-resume:<trailerId>"] = { seconds, at }
 * on unmount. We read that here and seek the embed to roughly the same
 * playhead, accounting for navigation time so the trailer doesn't snap
 * back to 0:00 on the details page.
 */

import { Pause, Play, Volume2, VolumeX } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { usePlayer } from "@/components/player-context";

interface HeroTrailerProps {
    trailerId: string | null;
    backdropPath: string | null;
    title: string;
    /** Delay (ms) before the iframe is mounted, so the navigation feels snappy. */
    mountDelayMs?: number;
}

export function HeroTrailer({
    trailerId,
    backdropPath,
    title,
    mountDelayMs = 350,
}: HeroTrailerProps) {
    const backdrop = backdropPath ? `https://image.tmdb.org/t/p/original${backdropPath}` : null;
    const [showIframe, setShowIframe] = useState(false);
    const [startSeconds, setStartSeconds] = useState(0);
    const [muted, setMuted] = useState(true);
    const [playing, setPlaying] = useState(true);
    const iframeRef = useRef<HTMLIFrameElement | null>(null);
    const player = usePlayer();
    const movieIsLive = !!player.currentVideo;

    const sendYtCommand = (func: "mute" | "unMute" | "playVideo" | "pauseVideo") => {
        const win = iframeRef.current?.contentWindow;
        if (!win) return;
        win.postMessage(
            JSON.stringify({ event: "command", func, args: [] }),
            "https://www.youtube-nocookie.com",
        );
    };

    const toggleMute = () => {
        const next = !muted;
        setMuted(next);
        sendYtCommand(next ? "mute" : "unMute");
    };

    const togglePlay = () => {
        const next = !playing;
        setPlaying(next);
        sendYtCommand(next ? "playVideo" : "pauseVideo");
    };

    // Auto-pause the trailer whenever the in-page player has a loaded video,
    // so the trailer audio/visuals don't compete with the movie playback.
    useEffect(() => {
        if (!showIframe) return;
        if (movieIsLive && playing) {
            setPlaying(false);
            sendYtCommand("pauseVideo");
        }
    }, [movieIsLive, showIframe, playing]);

    // Resolve a resume offset from sessionStorage (set by PosterPopover).
    useEffect(() => {
        if (!trailerId) return;
        try {
            const raw = sessionStorage.getItem(`mmo:trailer-resume:${trailerId}`);
            if (!raw) return;
            const parsed = JSON.parse(raw) as { seconds?: number; at?: number };
            const elapsedSinceStore = parsed.at ? Math.floor((Date.now() - parsed.at) / 1000) : 0;
            const total = Math.max(0, (parsed.seconds ?? 0) + elapsedSinceStore);
            // Cap at 2 minutes to avoid landing past a short trailer's end.
            setStartSeconds(Math.min(total, 120));
        } catch {
            /* ignore */
        }
    }, [trailerId]);

    // Mount the iframe after a short delay so the page transition (and any
    // view transition on the poster) finishes smoothly before the heavy
    // YouTube embed starts loading.
    useEffect(() => {
        if (!trailerId) return;
        const reduceMotion = typeof window !== "undefined"
            && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
        const delay = reduceMotion ? 0 : mountDelayMs;
        const t = window.setTimeout(() => setShowIframe(true), delay);
        return () => window.clearTimeout(t);
    }, [trailerId, mountDelayMs]);

    // Clear the resume marker after we've consumed it so a subsequent
    // visit doesn't seek to a stale offset.
    useEffect(() => {
        if (!showIframe || !trailerId) return;
        try {
            sessionStorage.removeItem(`mmo:trailer-resume:${trailerId}`);
        } catch {
            /* ignore */
        }
    }, [showIframe, trailerId]);

    const ytSrc = trailerId
        ? `https://www.youtube-nocookie.com/embed/${trailerId}`
        + `?autoplay=1&mute=1&controls=0&modestbranding=1&playsinline=1`
        + `&rel=0&loop=1&playlist=${trailerId}&enablejsapi=1`
        + `&disablekb=1&iv_load_policy=3&fs=0`
        + (startSeconds > 0 ? `&start=${startSeconds}` : "")
        : null;

    return (
        <>
            {backdrop && (
                <div
                    className="watch-hero-bg"
                    style={{ backgroundImage: `url(${backdrop})` }}
                    aria-hidden
                />
            )}
            {ytSrc && showIframe && (
                <>
                    <div className="watch-hero-trailer">
                        <iframe
                            ref={iframeRef}
                            src={ytSrc}
                            title={`${title} trailer`}
                            allow="autoplay; encrypted-media; fullscreen"
                            referrerPolicy="strict-origin-when-cross-origin"
                            loading="eager"
                        />
                    </div>
                    <div className="watch-hero-controls">
                        <button
                            type="button"
                            className="watch-hero-iconbtn"
                            onClick={togglePlay}
                            aria-pressed={!playing}
                            aria-label={playing ? "Pauză trailer" : "Redă trailer"}
                            title={playing ? "Pauză trailer" : "Redă trailer"}
                        >
                            {playing ? <Pause size={20} aria-hidden /> : <Play size={20} aria-hidden />}
                        </button>
                        <button
                            type="button"
                            className="watch-hero-iconbtn"
                            onClick={toggleMute}
                            aria-pressed={!muted}
                            aria-label={muted ? "Activează sunetul" : "Dezactivează sunetul"}
                            title={muted ? "Activează sunetul" : "Dezactivează sunetul"}
                        >
                            {muted ? <VolumeX size={20} aria-hidden /> : <Volume2 size={20} aria-hidden />}
                        </button>
                    </div>
                </>
            )}
        </>
    );
}
