"use client";

/**
 * `/media/music` (WP16-40): Home / Artists A–Z / Albums tabs (tab in `?tab=`), search box, "Surprise me"
 * (random 50 → play → Now Playing). Home rows: recently played, recently added, most played, playlists,
 * genre chips, random albums. Albums grid uses `content-visibility:auto` (music.css) for 1000+ items.
 */
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { Search, Shuffle } from "lucide-react";
import { Button, Tabs, TabsContent, TabsList, TabsTrigger } from "@mmo/ui";
import type { AlbumCard, ArtistCard, MusicHome } from "@/lib/mmo/media-types";
import type { MusicClient } from "@/lib/mmo/music";
import { MUSIC_LETTERS } from "@/lib/mmo/music-core";
import { webMusicPlayer } from "@/lib/mmo/web-music-player";
import { rowKeys } from "../row";
import {
    AlbumTile, ArtistTile, MusicEmptyLibrary, MusicError, MusicLoading, NOW_PLAYING_HREF, PlaylistTile, TileGrid, TrackList, genreHref,
} from "./common";
import { useLoad, useMusic } from "./use-music";

type Tab = "home" | "artists" | "albums";
const TABS: readonly Tab[] = ["home", "artists", "albums"];
const PAGE = 200;

export function MusicHomeScreen() {
    const t = useTranslations("mx.music");
    const { music, profileKey } = useMusic();
    const router = useRouter();
    const pathname = usePathname() ?? "/media/music";
    const params = useSearchParams();
    const raw = params?.get("tab");
    const tab: Tab = TABS.includes(raw as Tab) ? (raw as Tab) : "home";
    const [q, setQ] = useState("");
    const [surprising, setSurprising] = useState(false);

    const setTab = (v: unknown) => {
        const next = new URLSearchParams(params?.toString() ?? "");
        if (v === "home") next.delete("tab"); else next.set("tab", String(v));
        const s = next.toString();
        router.replace(s ? `${pathname}?${s}` : pathname, { scroll: false });
    };

    const onSearch = (e: FormEvent) => {
        e.preventDefault();
        const s = q.trim();
        if (s) router.push(`/media/music/search?q=${encodeURIComponent(s)}`);
    };

    const surprise = useCallback(async () => {
        if (!music) return;
        setSurprising(true);
        try {
            const tracks = await music.random(50);
            if (tracks.length > 0) { webMusicPlayer.play(tracks, 0); router.push(NOW_PLAYING_HREF); }
        } catch { /* stays on the page */ } finally { setSurprising(false); }
    }, [music, router]);

    if (!music) return null;

    return (
        <div className="mu-page" data-testid="music-home">
            <div className="mu-head">
                <h1 className="mu-title">{t("title")}</h1>
                <div className="mu-actions">
                    <form role="search" className="mu-search" onSubmit={onSearch}>
                        <Search aria-hidden className="size-4 text-muted-foreground" />
                        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("search.placeholder")}
                            aria-label={t("search.label")} enterKeyHint="search" />
                    </form>
                    <Button onClick={() => void surprise()} loading={surprising}>
                        <Shuffle aria-hidden />{t("home.surprise")}
                    </Button>
                </div>
            </div>
            <Tabs value={tab} onValueChange={setTab}>
                <TabsList aria-label={t("tabs.label")}>
                    {TABS.map((k) => <TabsTrigger key={k} value={k}>{t(`tabs.${k}`)}</TabsTrigger>)}
                </TabsList>
                <TabsContent value="home" className="pt-4"><HomeTab music={music} profileKey={profileKey} /></TabsContent>
                <TabsContent value="artists" className="pt-4"><LetterPaged kind="artists" music={music} /></TabsContent>
                <TabsContent value="albums" className="pt-4"><LetterPaged kind="albums" music={music} /></TabsContent>
            </Tabs>
        </div>
    );
}

function isEmpty(h: MusicHome | null): boolean {
    return !h || (h.recent.length === 0 && h.newest.length === 0 && h.mostPlayed.length === 0 && h.randomAlbums.length === 0 && h.genres.length === 0);
}

function HomeTab({ music, profileKey }: { music: MusicClient; profileKey: string }) {
    const t = useTranslations("mx.music");
    const home = useLoad<MusicHome | null>(`home|${profileKey}`, () => music.home());
    if (home.status === "loading") return <MusicLoading label={t("state.loading")} />;
    if (home.status === "error") return <MusicError onRetry={home.retry} />;
    const h = home.data;
    if (!h || isEmpty(h)) return <MusicEmptyLibrary />;

    return (
        <div className="flex flex-col gap-8">
            <AlbumRow title={t("home.recent")} items={h.recent} music={music} />
            <AlbumRow title={t("home.newest")} items={h.newest} music={music} />
            {h.genres.length > 0 ? (
                <section aria-labelledby="mu-genres">
                    <h2 id="mu-genres" className="mu-section-title">{t("home.genres")}</h2>
                    <ul className="mu-chips">
                        {h.genres.slice(0, 40).map((g) => (
                            <li key={g.name}>
                                <Link href={genreHref(g.name)} className="mu-chip" prefetch={false}>
                                    {g.name}<small>{g.albumCount}</small>
                                </Link>
                            </li>
                        ))}
                    </ul>
                </section>
            ) : null}
            {h.mostPlayed.length > 0 ? (
                <section aria-labelledby="mu-most">
                    <h2 id="mu-most" className="mu-section-title">{t("home.mostPlayed")}</h2>
                    <TrackList music={music} tracks={h.mostPlayed.slice(0, 10)} showArtist showCover label={t("home.mostPlayed")} />
                </section>
            ) : null}
            {h.playlists.length > 0 ? (
                <section aria-labelledby="mu-pl">
                    <h2 id="mu-pl" className="mu-section-title">{t("home.playlists")}</h2>
                    <ul className="mu-row" onKeyDown={rowKeys} data-mx-row>
                        {h.playlists.map((p) => <li key={p.id}><PlaylistTile music={music} playlist={p} /></li>)}
                    </ul>
                </section>
            ) : null}
            <AlbumRow title={t("home.random")} items={h.randomAlbums} music={music} />
        </div>
    );
}

function AlbumRow({ title, items, music }: { title: string; items: AlbumCard[]; music: MusicClient }) {
    if (items.length === 0) return null;
    const id = `mu-row-${title.replace(/\W+/g, "-")}`;
    return (
        <section aria-labelledby={id}>
            <h2 id={id} className="mu-section-title">{title}</h2>
            <ul className="mu-row" onKeyDown={rowKeys} data-mx-row>
                {items.map((a) => <li key={a.id}><AlbumTile music={music} album={a} /></li>)}
            </ul>
        </section>
    );
}

interface PagedState<T> { items: T[]; total: number }

/** Artists or albums, optionally filtered by first letter, paged by 200 with "Load more". */
function LetterPaged({ kind, music }: { kind: "artists" | "albums"; music: MusicClient }) {
    const t = useTranslations("mx.music");
    const [letter, setLetter] = useState<string>("");
    const [extra, setExtra] = useState<{ key: string; items: Array<ArtistCard | AlbumCard> }>({ key: "", items: [] });
    const [more, setMore] = useState(false);
    const key = `${kind}|${letter}`;
    const first = useLoad<PagedState<ArtistCard | AlbumCard>>(key, async () => {
        const r = kind === "artists" ? await music.artists({ letter, limit: PAGE }) : await music.albums({ letter, limit: PAGE });
        return { items: r?.items ?? [], total: r?.total ?? 0 };
    });
    const items = first.data ? [...first.data.items, ...(extra.key === key ? extra.items : [])] : [];
    const total = first.data?.total ?? 0;

    const loadMore = async () => {
        setMore(true);
        try {
            const opts = { letter, offset: items.length, limit: PAGE };
            const r = kind === "artists" ? await music.artists(opts) : await music.albums(opts);
            const add: Array<ArtistCard | AlbumCard> = r?.items ?? [];
            setExtra((e) => ({ key, items: [...(e.key === key ? e.items : []), ...add] }));
        } catch { /* keep what we have */ } finally { setMore(false); }
    };

    return (
        <div className="flex flex-col gap-4">
            <div className="mu-letters" role="group" aria-label={t("letters.label")}>
                <button type="button" className="mu-letter px-2" aria-pressed={letter === ""} onClick={() => setLetter("")}>{t("letters.all")}</button>
                {MUSIC_LETTERS.map((l) => (
                    <button key={l} type="button" className="mu-letter" aria-pressed={letter === l} onClick={() => setLetter(l)}
                        aria-label={l === "#" ? t("letters.other") : l}>{l}</button>
                ))}
            </div>
            {first.status === "loading" ? <MusicLoading label={t("state.loading")} />
                : first.status === "error" ? <MusicError onRetry={first.retry} />
                    : items.length === 0 ? (letter ? <p className="text-muted-foreground">{t("letters.none", { letter })}</p> : <MusicEmptyLibrary />)
                        : (
                            <>
                                <p className="text-muted-foreground text-sm" aria-live="polite">
                                    {kind === "artists" ? t("count.artists", { count: total }) : t("count.albums", { count: total })}
                                </p>
                                <TileGrid label={t(`tabs.${kind}`)}>
                                    {items.map((it) => (
                                        <li key={it.id}>
                                            {kind === "artists"
                                                ? <ArtistTile music={music} artist={it as ArtistCard} />
                                                : <AlbumTile music={music} album={it as AlbumCard} />}
                                        </li>
                                    ))}
                                </TileGrid>
                                {items.length < total ? (
                                    <div className="flex justify-center">
                                        <Button variant="outline" onClick={() => void loadMore()} loading={more}>
                                            {t("letters.more", { shown: items.length, total })}
                                        </Button>
                                    </div>
                                ) : null}
                            </>
                        )}
        </div>
    );
}
