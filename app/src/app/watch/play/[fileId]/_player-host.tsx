"use client";

import { VideoPlayer } from "@/components/video/player";
import { SubtitlePicker } from "@/components/video/subtitle-picker";
import { saveProgress, pushDiscordPresence } from "@/actions/video-playback";
import { useCallback, useRef, useState } from "react";

interface Props {
    hlsUrl: string;
    directUrl?: string | null;
    poster?: string | null;
    title: string;
    subtitle?: string;
    durationHint?: number | null;
    startSec?: number;
    movieId?: number | null;
    episodeId?: number | null;
    fileId?: number | null;
    /** Subtitle search context (forwarded to picker). */
    subtitleQuery?: {
        title?: string;
        tmdbId?: number;
        imdbId?: string;
        kind?: "movie" | "tv";
        season?: number;
        episode?: number;
    };
}

export function PlayerHost(props: Props) {
    const lastSent = useRef(0);
    const [tracks, setTracks] = useState<Array<{ src: string; lang: string; label: string; default?: boolean }>>([]);

    const onProgress = useCallback((position: number, duration: number, ended: boolean) => {
        const now = Date.now();
        if (!ended && now - lastSent.current < 4500) return;
        lastSent.current = now;
        void saveProgress({
            movieId: props.movieId ?? undefined,
            episodeId: props.episodeId ?? undefined,
            fileId: props.fileId ?? undefined,
            positionSec: position,
            durationSec: duration,
            completed: ended,
        });
    }, [props.movieId, props.episodeId, props.fileId]);

    const onPresence = useCallback((s: Parameters<NonNullable<Parameters<typeof VideoPlayer>[0]["onPresence"]>>[0]) => {
        void pushDiscordPresence({
            title: s.title, subtitle: s.subtitle, progressSec: s.progressSec, durationSec: s.durationSec, paused: s.paused,
        });
    }, []);

    const addTrack = useCallback((t: { src: string; lang: string; label: string }) => {
        setTracks((cur) => {
            // Replace if same lang already present; otherwise append.
            const without = cur.filter(x => x.lang !== t.lang);
            return [...without, { ...t, default: true }];
        });
    }, []);

    return (
        <div style={{ position: "relative" }}>
            <VideoPlayer
                hlsUrl={props.hlsUrl}
                directUrl={props.directUrl}
                poster={props.poster}
                title={props.title}
                subtitle={props.subtitle}
                durationHint={props.durationHint}
                startSec={props.startSec}
                onProgress={onProgress}
                onPresence={onPresence}
                subtitleTracks={tracks}
            />
            <div style={{ position: "absolute", top: 12, right: 12, zIndex: 20 }}>
                <SubtitlePicker
                    query={props.subtitleQuery ?? { title: props.title }}
                    onPick={addTrack}
                />
            </div>
        </div>
    );
}
