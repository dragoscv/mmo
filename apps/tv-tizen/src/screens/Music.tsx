/**
 * Music (WP16-33) — artwork-first library: tabs Home · Artists · Albums · Playlists · Search.
 * Home = recent, newest, most played, playlists, genres, random albums + Shuffle all (`/media/music/random`).
 * Grid tabs render the header inside the virtualised Grid's scroll container. Playback lives in
 * `lib/music-player.ts` (background audio), so browsing never stops the music.
 */
import { useCallback, useEffect, useState } from "react";
import { t } from "../i18n/messages";
import type { GenreCard, MusicHome, PlaylistCard } from "../lib/media-types";
import { musicPlayer, useMusicState } from "../lib/music-player";
import type { ScreenProps } from "../nav/ctx";
import { Chips, Empty, ErrorState, LoadingRows, ScreenHeader, SecondaryButton } from "../ui";
import { useCoverBackdrop } from "./music/common";
import { AlbumsTab, ArtistsTab, GenreView, HomeTab, PlaylistView, PlaylistsTab, SearchTab } from "./music/MusicTabs";

type Tab = "home" | "artists" | "albums" | "playlists" | "search";
const TABS: Tab[] = ["home", "artists", "albums", "playlists", "search"];

function isEmptyLibrary(h: MusicHome): boolean {
    return h.recent.length + h.newest.length + h.randomAlbums.length + h.mostPlayed.length + h.playlists.length === 0;
}

export function Music({ ctx }: ScreenProps<"music">) {
    const { music, nav } = ctx;
    const [tab, setTab] = useState<Tab>("home");
    const [home, setHome] = useState<MusicHome | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [cover, setCover] = useState<string | null | undefined>(undefined);
    const [playlist, setPlaylist] = useState<PlaylistCard | null>(null);
    const [genre, setGenre] = useState<GenreCard | null>(null);
    const st = useMusicState();
    useCoverBackdrop(cover);

    useEffect(() => { musicPlayer.attach(music, ctx.media); }, [music, ctx.media]);

    const load = useCallback(() => {
        setError(null);
        music.home().then((h) => setHome(h ?? { profileId: "", recent: [], newest: [], mostPlayed: [], playlists: [], genres: [], randomAlbums: [] }))
            .catch((e: Error) => setError(e.message));
    }, [music]);
    useEffect(load, [load]);

    const onCover = useCallback((url: string | null) => setCover(url), []);
    const tabProps = { music, nav, onCover };
    const empty = home !== null && isEmptyLibrary(home);

    const header = (
        <>
            <ScreenHeader title={t("screen.music")}
                sub={st.current ? t("music.nowPlayingSub", { title: st.current.title, artist: st.current.artist ?? "" }) : undefined}
                right={st.current ? <SecondaryButton icon={st.playing ? "pause" : "play"} label={t("nav.nowPlaying")} onClick={() => nav.push({ name: "nowPlaying" })} focusKey="mu:np" /> : undefined} />
            {!empty && (
                <Chips className="mu-tabs" rowId="mu-tabs" value={tab}
                    items={TABS.map((id) => ({ id, label: t(`music.tab.${id}` as const) }))}
                    onChange={(id) => { setPlaylist(null); setGenre(null); setTab(id as Tab); }} />
            )}
        </>
    );

    if (error) return <div className="tv-screen" data-scroll="screen" data-testid="screen-music">{header}<ErrorState message={error} onRetry={load} /></div>;
    if (!home) return <div className="tv-screen" data-scroll="screen" data-testid="screen-music">{header}<LoadingRows rows={3} kind="square" /></div>;
    if (empty) {
        return (
            <div className="tv-screen" data-scroll="screen" data-testid="screen-music">
                {header}
                <Empty icon="music" title={t("music.emptyTitle")} message={t("music.emptyMsg")} action={{ label: t("common.retry"), icon: "refresh", onClick: load }} />
            </div>
        );
    }

    if (genre) return <GenreView {...tabProps} genre={genre} header={header} onClose={() => setGenre(null)} />;
    if (tab === "artists") return <ArtistsTab {...tabProps} header={header} />;
    if (tab === "albums") return <AlbumsTab {...tabProps} header={header} />;
    if (tab === "playlists" && !playlist) return <PlaylistsTab {...tabProps} header={header} playlists={home.playlists} onOpen={setPlaylist} />;

    return (
        <div className="tv-screen" data-scroll="screen" data-testid="screen-music">
            {header}
            {playlist ? <PlaylistView {...tabProps} playlist={playlist} onClose={() => setPlaylist(null)} />
                : tab === "search" ? <SearchTab {...tabProps} />
                    : <HomeTab {...tabProps} home={home} onGenre={setGenre} onPlaylist={setPlaylist} />}
        </div>
    );
}
