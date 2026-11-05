"use client";

/**
 * `/media/play/[kind]/[tmdbId]` client (WP16-39): resolves the title → file (best version or `file`), resume
 * position (explicit `t` > progress > 0), episode + next-up, then mounts the cinematic player. Watch Together
 * (`room`), "Play on TV" (remote mode) and hub remote commands are wired here.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { ArrowLeft, Film, Loader2 } from "lucide-react";
import { Button, EmptyState } from "@mmo/ui";
import type { MediaKind } from "@/lib/mmo/media-types";
import { tmdbImg } from "@/lib/media/normalize";
import { useMmo } from "../mmo-provider";
import { TvDeviceList } from "../play-on-tv";
import type { HubDevice } from "@/lib/mmo/media-types";
import { CinemaPlayer, type CastSlot } from "./cinema-player";
import { intParam, playHref, readPlayerPrefs, type StreamAuth } from "./model";
import { resolveNextUp, resolvePlayback, type NextUpInfo, type ResolveError, type Resolved } from "./resolve";

export interface PlayRouteProps {
    kind: MediaKind;
    tmdbId: number;
    file: string | null;
    season: number | null;
    episode: number | null;
    startSec: number | null;
    room: string | null;
}

type State = { s: "loading" } | { s: "error"; error: ResolveError | "network" } | { s: "ready"; value: Resolved };

export function PlayRoute(p: PlayRouteProps) {
    const t = useTranslations("mx.player");
    const router = useRouter();
    const { clients, profile, devices } = useMmo();
    const [state, setState] = useState<State>({ s: "loading" });
    const [nextUp, setNextUp] = useState<NextUpInfo | null>(null);
    const [attempt, setAttempt] = useState(0);

    useEffect(() => {
        if (!clients) return;
        let alive = true;
        const h = window.setTimeout(() => { if (alive) setState({ s: "loading" }); }, 0);
        resolvePlayback(clients.media, { kind: p.kind, tmdbId: p.tmdbId, file: p.file, season: p.season, episode: p.episode, startSec: p.startSec })
            .then((r) => { if (alive) setState(r.ok ? { s: "ready", value: r.value } : { s: "error", error: r.error }); })
            .catch(() => { if (alive) setState({ s: "error", error: "network" }); });
        return () => { alive = false; window.clearTimeout(h); };
    }, [clients, p.kind, p.tmdbId, p.file, p.season, p.episode, p.startSec, attempt]);

    const ready = state.s === "ready" ? state.value : null;
    useEffect(() => {
        if (!clients || !ready || ready.season === null || ready.episode === null) return;
        let alive = true;
        void resolveNextUp(clients.media, p.tmdbId, ready.season, ready.episode).then((n) => { if (alive) setNextUp(n); }).catch(() => undefined);
        return () => { alive = false; setNextUp(null); };
    }, [clients, ready, p.tmdbId]);

    const exit = useCallback(() => {
        if (window.history.length > 1) router.back();
        else router.push(`/media/${p.kind}/${p.tmdbId}`);
    }, [router, p.kind, p.tmdbId]);

    const auth = useMemo<StreamAuth | null>(() => (clients ? { kind: "token", token: clients.cfg.token, userId: clients.cfg.userId } : null), [clients]);
    const prefs = useMemo(() => readPlayerPrefs(profile), [profile]);

    const Picker = useMemo<CastSlot["Picker"] | null>(() => {
        if (!ready) return null;
        const d = ready.title.title;
        const season = ready.season ?? undefined;
        const episode = ready.episode ?? undefined;
        function CastPicker({ fileId, positionSec, onSent }: { fileId: string; positionSec: number; onSent(dev: HubDevice): void }) {
            return (
                <TvDeviceList kind={p.kind} tmdbId={p.tmdbId} title={d.title} fileId={fileId}
                    season={season} episode={episode} positionSec={positionSec} onSent={onSent} />
            );
        }
        return CastPicker;
    }, [ready, p.kind, p.tmdbId]);
    const cast = useMemo<CastSlot | null>(() => {
        if (!clients || !Picker) return null;
        return {
            Picker,
            remote: {
                device: (id) => devices.find((x) => x.deviceId === id) ?? null,
                send: (id, action, args) => clients.hub.sendCommand(id, action, args ?? {}),
            },
        };
    }, [clients, Picker, devices]);

    const onRemotePlay = useCallback((args: Record<string, unknown>): boolean => {
        const kind = args.kind === "movie" || args.kind === "tv" ? args.kind : null;
        const id = typeof args.tmdbId === "number" ? args.tmdbId : intParam(typeof args.tmdbId === "string" ? args.tmdbId : null);
        if (!kind || !id) return false;
        const num = (v: unknown) => (typeof v === "number" ? v : intParam(typeof v === "string" ? v : null));
        router.replace(playHref({
            kind, tmdbId: id, file: typeof args.fileId === "string" ? args.fileId : null,
            season: num(args.season), episode: num(args.episode), startSec: num(args.startSec),
        }));
        return true;
    }, [router]);

    if (!clients || !auth) return null;

    if (state.s === "loading") {
        return (
            <div className="mxp-root mxp-state dark" role="status">
                <Loader2 aria-hidden className="mxp-spin size-12" />
                <p>{t("route.loading")}</p>
            </div>
        );
    }
    if (state.s === "error") {
        const key = state.error === "not_found" ? "notFound" : state.error === "no_file" ? "noFile" : state.error === "no_episode" ? "noEpisode" : "network";
        return (
            <div className="mxp-root mxp-state dark">
                <EmptyState
                    icon={<Film aria-hidden />}
                    title={t(`route.${key}.title`)}
                    description={t(`route.${key}.body`)}
                    actions={
                        <>
                            {state.error === "network" && <Button onClick={() => setAttempt((a) => a + 1)}>{t("route.retry")}</Button>}
                            <Button variant="outline" render={<Link href={`/media/${p.kind}/${p.tmdbId}`} />}>
                                <ArrowLeft aria-hidden />{t("route.toTitle")}
                            </Button>
                        </>
                    }
                />
            </div>
        );
    }

    const v = state.value;
    const d = v.title.title;
    const epName = v.episodeInfo?.name;
    const subtitle = v.season !== null && v.episode !== null
        ? `${t("route.episodeLabel", { season: v.season, episode: v.episode })}${epName ? ` — ${epName}` : ""}`
        : [d.releaseDate?.slice(0, 4), v.file.version?.label].filter(Boolean).join(" · ") || null;

    return (
        <CinemaPlayer
            key={`${v.file.serverFileId}:${v.season ?? 0}:${v.episode ?? 0}`}
            baseUrl={clients.cfg.baseUrl}
            auth={auth}
            source={{
                fileId: v.file.serverFileId, path: v.file.path, title: d.title, subtitle, kind: p.kind, tmdbId: p.tmdbId,
                season: v.season, episode: v.episode, posterPath: d.posterPath, backdropPath: v.episodeInfo?.stillPath ?? d.backdropPath,
                overview: v.episodeInfo?.overview ?? d.overview ?? null,
                runtimeSec: (v.episodeInfo?.runtime ?? (p.kind === "movie" ? d.runtime : undefined) ?? 0) * 60 || null,
            }}
            startSec={v.startSec}
            prefs={prefs}
            versions={v.versions}
            onSwitchFile={(fileId, at) => router.replace(playHref({ kind: p.kind, tmdbId: p.tmdbId, file: fileId, season: v.season, episode: v.episode, startSec: at, room: p.room }))}
            media={clients.media}
            hub={clients.hub}
            nextUp={nextUp}
            nextUpStill={nextUp ? tmdbImg(nextUp.stillPath, "w500") : null}
            onPlayNext={nextUp ? () => router.replace(playHref({ kind: "tv", tmdbId: p.tmdbId, file: nextUp.fileId, season: nextUp.season, episode: nextUp.episode, room: p.room })) : undefined}
            onExit={exit}
            joinRoomId={p.room}
            cast={cast ?? undefined}
            onRemotePlay={onRemotePlay}
        />
    );
}
