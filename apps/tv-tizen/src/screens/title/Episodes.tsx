/**
 * Season tabs + episode row (Title) and the episode card used by Season. Episodes are LandscapeCards with the
 * TMDB still, "N. Name", runtime, progress and an "on server" badge; OK plays the best local version.
 */
import { useEffect, useState } from "react";
import { remPx } from "../../lib/image";
import type { MediaSeasonResponse, SeasonEpisode, SeasonSummary } from "../../lib/media-types";
import type { ScreenCtx } from "../../nav/ctx";
import { t } from "../../i18n/messages";
import { CARD_REM, Chips, ErrorState, LandscapeCard, LoadingRows, Row, SecondaryButton } from "../../ui";
import { episodeTarget, runtimeLabel, startPlayback } from "../home/media-ui";

export function episodeProgress(ep: SeasonEpisode): number | null {
    const p = ep.progress;
    if (!p) return null;
    if (p.completed) return 1;
    return p.durationSec > 0 ? p.positionSec / p.durationSec : null;
}

export function EpisodeCard({ ctx, tmdbId, ep, focusKey, widthRem, onPlayError }: {
    ctx: ScreenCtx; tmdbId: number; ep: SeasonEpisode; focusKey: string; widthRem?: number; onPlayError?: (msg: string) => void;
}) {
    const local = ep.files.length > 0;
    const sub = [runtimeLabel(ep.runtime), ep.progress?.completed ? t("wh.watched") : null].filter(Boolean).join(" · ");
    const play = async () => {
        const tg = episodeTarget(tmdbId, ep.seasonNumber, ep.episodeNumber, ep.files, ep.progress);
        if (!tg) { onPlayError?.(t("wh.notOnServer")); return; }
        try { await startPlayback(ctx, tg); } catch (e) { onPlayError?.(t("wh.playError", { message: (e as Error).message })); }
    };
    return (
        <LandscapeCard focusKey={focusKey} title={`${ep.episodeNumber}. ${ep.name}`} subtitle={sub || undefined}
            image={ctx.media.imageFor(ep.stillPath, remPx(widthRem ?? CARD_REM.landscape))} progress={episodeProgress(ep)}
            badges={local ? [{ label: t("wh.onServer"), icon: "server", tone: "success" }] : undefined}
            placeholderIcon="tv" alwaysShowTitle testId="episode-card" onSelect={() => { void play(); }} />
    );
}

type Load = { s: "loading" } | { s: "ok"; data: MediaSeasonResponse } | { s: "error"; message: string } | { s: "none" };

/** Season tabs (Chips) + virtualised episode row + "All episodes" (Season screen). */
export function SeasonBlock({ ctx, tmdbId, seasons, initial, showTitle, onStatus }: {
    ctx: ScreenCtx; tmdbId: number; seasons: SeasonSummary[]; initial: number; showTitle: string; onStatus: (msg: string | null) => void;
}) {
    const list = seasons.filter((s) => s.seasonNumber > 0).length > 0 ? seasons.filter((s) => s.seasonNumber > 0) : seasons;
    const [season, setSeason] = useState(initial);
    const [load, setLoad] = useState<Load>({ s: "loading" });
    const [rev, setRev] = useState(0);

    useEffect(() => {
        let alive = true;
        setLoad({ s: "loading" });
        ctx.media.season(tmdbId, season)
            .then((data) => { if (alive) setLoad(data ? { s: "ok", data } : { s: "none" }); })
            .catch((e: Error) => { if (alive) setLoad({ s: "error", message: e.message }); });
        return () => { alive = false; };
    }, [ctx.media, tmdbId, season, rev]);

    if (list.length === 0) return null;
    return (
        <section className="wt-section" data-testid="title-seasons">
            <div className="ws-head">
                <h2 className="wt-section-title">{t("wh.episodes")}</h2>
                <SecondaryButton icon="chevronRight" label={t("wh.allEpisodes")} focusKey="title:season-all"
                    onClick={() => ctx.nav.push({ name: "season", tmdbId, season, showTitle })} />
            </div>
            {list.length > 1 && (
                <div className="wt-seasons">
                    <Chips rowId="title:seasons" value={String(season)} onChange={(id) => setSeason(Number(id))}
                        items={list.map((s) => ({ id: String(s.seasonNumber), label: s.seasonNumber > 0 ? t("screen.season", { n: s.seasonNumber }) : s.name }))} />
                </div>
            )}
            {load.s === "loading" && <LoadingRows rows={1} kind="landscape" count={6} />}
            {load.s === "error" && <ErrorState message={load.message} onRetry={() => setRev((r) => r + 1)} />}
            {load.s === "ok" && (
                <Row<SeasonEpisode> rowId={`title:eps:${season}`} items={load.data.episodes} kind="landscape"
                    itemKey={(e) => `${e.seasonNumber}:${e.episodeNumber}`}
                    renderItem={(e) => <EpisodeCard ctx={ctx} tmdbId={tmdbId} ep={e} focusKey={`title:ep:${e.seasonNumber}:${e.episodeNumber}`} onPlayError={onStatus} />} />
            )}
        </section>
    );
}
