/**
 * Season (WP16-33): every episode of one season as large stills in a virtualised grid (play on OK), season
 * overview, season switcher (Chips) when the show has several. Backdrop stays the show's.
 */
import { useEffect, useState } from "react";
import type { MediaSeasonResponse, MediaTitleResponse, SeasonEpisode } from "../lib/media-types";
import { t } from "../i18n/messages";
import type { ScreenProps } from "../nav/ctx";
import { useScreenActive } from "../nav/Nav";
import { Chips, Empty, ErrorState, Grid, LoadingRows, useBackdrop } from "../ui";
import { errorKind } from "./home/media-ui";
import { EpisodeCard } from "./title/Episodes";
import "./home/home.css";

type Load = { s: "loading" } | { s: "ok"; data: MediaSeasonResponse } | { s: "error"; error: unknown } | { s: "none" };

const EP_REM = 20;

export function Season({ ctx, params }: ScreenProps<"season">) {
    const { tmdbId } = params;
    const [season, setSeason] = useState(params.season);
    const [load, setLoad] = useState<Load>({ s: "loading" });
    const [show, setShow] = useState<MediaTitleResponse | null>(null);
    const [rev, setRev] = useState(0);
    const [status, setStatus] = useState<string | null>(null);
    const backdrop = useBackdrop();
    const active = useScreenActive();

    useEffect(() => {
        let alive = true;
        ctx.media.mediaTitle("tv", tmdbId).then((d) => { if (alive) setShow(d); }).catch(() => undefined);
        return () => { alive = false; };
    }, [ctx.media, tmdbId]);

    useEffect(() => {
        let alive = true;
        setLoad({ s: "loading" });
        ctx.media.season(tmdbId, season)
            .then((data) => { if (alive) setLoad(data ? { s: "ok", data } : { s: "none" }); })
            .catch((error: unknown) => { if (alive) setLoad({ s: "error", error }); });
        return () => { alive = false; };
    }, [ctx.media, tmdbId, season, rev]);

    const bd = show?.title.backdropPath ?? null;
    useEffect(() => {
        if (active && bd) backdrop.show(ctx.media.image(bd, "w1280"));
    }, [active, bd, backdrop, ctx.media]);

    const seasons = (show?.title.seasons ?? []).filter((s) => s.seasonNumber > 0);
    const name = params.showTitle || show?.title.title || "";
    const heading = load.s === "ok" && load.data.name ? load.data.name : t("screen.season", { n: season });

    const header = (
        <div>
            <div className="ws-head">
                <div>
                    <h1 className="tv-h1">{name}</h1>
                    <p className="tv-sub">{heading}{load.s === "ok" ? ` · ${t("title.episodesCount", { n: load.data.episodes.length })}` : ""}</p>
                </div>
            </div>
            {load.s === "ok" && load.data.overview && <p className="ws-overview">{load.data.overview}</p>}
            {seasons.length > 1 && (
                <Chips rowId="season:tabs" value={String(season)} onChange={(id) => setSeason(Number(id))}
                    items={seasons.map((s) => ({ id: String(s.seasonNumber), label: t("screen.season", { n: s.seasonNumber }) }))} />
            )}
            {status && <p className="wh-status is-error">{status}</p>}
            {load.s === "loading" && <LoadingRows rows={2} kind="landscape" count={4} />}
            {load.s === "none" && <Empty icon="tv" message={t("show.empty")} />}
            {load.s === "error" && (errorKind(load.error) === "age"
                ? <Empty icon="kids" title={t("wh.ageTitle")} message={t("wh.ageMessage")} />
                : <ErrorState message={String((load.error as Error)?.message ?? load.error)} onRetry={() => setRev((r) => r + 1)} />)}
        </div>
    );

    return (
        <div className="wl-root" data-testid="screen-season">
            <Grid<SeasonEpisode> gridId={`season-${tmdbId}-${season}`} header={header} kind="landscape" itemWidthRem={EP_REM}
                rowHeightRem={EP_REM * 9 / 16 + 3.8}
                items={load.s === "ok" ? load.data.episodes : []} itemKey={(e) => `${e.seasonNumber}:${e.episodeNumber}`}
                renderItem={(e) => <EpisodeCard ctx={ctx} tmdbId={tmdbId} ep={e} widthRem={EP_REM} focusKey={`season:ep:${e.seasonNumber}:${e.episodeNumber}`} onPlayError={setStatus} />} />
        </div>
    );
}
