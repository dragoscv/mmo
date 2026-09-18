/**
 * Listen half of Media Home (WP11-05). Server component: each row streams
 * independently inside its own <Suspense> with a square-skeleton fallback.
 * Empty rows render nothing; the whole section is hidden when the active
 * profile has `showListen === false`.
 *
 * Usage from `app/page.tsx`: `<ListenRows />` (fetches prefs itself) or
 * `<ListenRows prefs={prefs} />` when the page already loaded them.
 */
import { Suspense } from "react";
import { getTranslations } from "next-intl/server";
import { getListenHome, getRecentAlbums, getContinueListening, getFavouriteTracks, getMostPlayed } from "@/actions/track-plays";
import { getPlaylistsAggregated } from "@/actions/playlists-aggregate";
import { getWatchPrefs } from "@/actions/watch-prefs";
import { trackProgress } from "@/lib/media/listen-types";
import type { WatchPrefs } from "@/lib/watch-prefs";
import { AlbumCard } from "./album-card";
import { ListenHistoryMigrator } from "./listen-history-migrator";
import { ListenRow, ListenRowSkeleton } from "./listen-row";
import { PlaylistCard } from "./playlist-card";
import { TrackCard } from "./track-card";

export { getListenHome };

interface Labels {
    title: string; prev: string; next: string; play: string; playAlbum: string;
    trackCount: string; albumUnavailable: string; serverOffline: string;
    rows: { continue: string; newAlbums: string; favourites: string; mostPlayed: string; playlists: string };
}

async function loadLabels(): Promise<Labels> {
    const t = await getTranslations("listen");
    return {
        title: t("title"), prev: t("prev"), next: t("next"), play: t("play"), playAlbum: t("playAlbum"),
        // Cards format the count themselves; hand them the template with the token intact.
        trackCount: t("trackCount", { count: "{count}" }), albumUnavailable: t("albumUnavailable"), serverOffline: t("serverOffline"),
        rows: {
            continue: t("rows.continue"), newAlbums: t("rows.newAlbums"), favourites: t("rows.favourites"),
            mostPlayed: t("rows.mostPlayed"), playlists: t("rows.playlists"),
        },
    };
}

type T = Labels;
const rowLabels = (t: T) => ({ prev: t.prev, next: t.next });

async function ContinueRow({ t }: { t: T }) {
    const items = await getContinueListening(12);
    if (items.length === 0) return null;
    return (
        <ListenRow title={t.rows.continue} labels={rowLabels(t)} className="mb-8">
            {items.map((tr) => (
                <TrackCard key={tr.id} track={tr} queue={items} progress={trackProgress(tr.lastDurationSec, tr.duration)} playLabel={t.play} />
            ))}
        </ListenRow>
    );
}

async function AlbumsRow({ t }: { t: T }) {
    const albums = await getRecentAlbums(12);
    if (albums.length === 0) return null;
    return (
        <ListenRow title={t.rows.newAlbums} labels={rowLabels(t)} className="mb-8">
            {albums.map((a) => (
                <AlbumCard key={a.key} album={a} labels={{ play: t.playAlbum, tracks: t.trackCount, empty: t.albumUnavailable }} />
            ))}
        </ListenRow>
    );
}

async function FavouritesRow({ t }: { t: T }) {
    const items = await getFavouriteTracks(20);
    if (items.length === 0) return null;
    return (
        <ListenRow title={t.rows.favourites} labels={rowLabels(t)} className="mb-8">
            {items.map((tr) => <TrackCard key={tr.id} track={tr} queue={items} playLabel={t.play} />)}
        </ListenRow>
    );
}

async function MostPlayedRow({ t }: { t: T }) {
    const items = await getMostPlayed(20);
    if (items.length === 0) return null;
    return (
        <ListenRow title={t.rows.mostPlayed} labels={rowLabels(t)} className="mb-8">
            {items.map((tr) => <TrackCard key={tr.id} track={tr} queue={items} playLabel={t.play} />)}
        </ListenRow>
    );
}

async function PlaylistsRow({ t }: { t: T }) {
    const items = await getPlaylistsAggregated();
    if (items.length === 0) return null;
    return (
        <ListenRow title={t.rows.playlists} labels={rowLabels(t)} className="mb-8">
            {items.map((p) => (
                <PlaylistCard key={`${p.source.serverId}:${p.id}`} playlist={p} labels={{ tracks: t.trackCount, offline: t.serverOffline }} />
            ))}
        </ListenRow>
    );
}

export interface ListenRowsProps {
    /** Pass when the page already resolved prefs; otherwise fetched here. */
    prefs?: Pick<WatchPrefs, "showListen">;
}

export async function ListenRows({ prefs }: ListenRowsProps = {}) {
    const resolved = prefs ?? await getWatchPrefs();
    if (resolved.showListen === false) return null;
    const t = await loadLabels();
    return (
        <section aria-label={t.title} data-slot="listen-rows" className="w-full">
            <ListenHistoryMigrator />
            <Suspense fallback={<ListenRowSkeleton />}><ContinueRow t={t} /></Suspense>
            <Suspense fallback={<ListenRowSkeleton />}><AlbumsRow t={t} /></Suspense>
            <Suspense fallback={<ListenRowSkeleton />}><FavouritesRow t={t} /></Suspense>
            <Suspense fallback={<ListenRowSkeleton />}><MostPlayedRow t={t} /></Suspense>
            <Suspense fallback={<ListenRowSkeleton />}><PlaylistsRow t={t} /></Suspense>
        </section>
    );
}

export default ListenRows;
