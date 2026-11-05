/**
 * Search (WP16-35, `{initial?}`): on-screen Keyboard + a real <input> (Tizen IME / USB keyboard / hub `text`),
 * 300 ms debounce, sections In your library · Movies & shows (`/media/search`) · Music (albums, artists, tracks) ·
 * Channels (client-side, diacritic-insensitive). Recent searches per profile in localStorage. Results open title /
 * album / artist / livePlay.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { focusByKey } from "../lib/focus";
import { remPx } from "../lib/image";
import type { AlbumCard, ArtistCard, LiveTvChannel, MusicSearch, TitleCard, TrackCard } from "../lib/media-types";
import { t } from "../i18n/messages";
import type { ScreenProps } from "../nav/ctx";
import { useScreenActive } from "../nav/Nav";
import { CARD_REM, Chips, Empty, ErrorState, Keyboard, LandscapeCard, LoadingRows, PosterCard, Row, useBackdrop } from "../ui";
import { cardKey, fold } from "./home/media-ui";
import { TitlePoster } from "./home/widgets";
import "./home/home.css";

const DEBOUNCE_MS = 300;
const MIN_CHARS = 2;
const RECENT_MAX = 8;
const recentKey = (profile: string) => `mixai-tv:recent-searches:${profile}`;

function readRecent(profile: string): string[] {
    try {
        const j = JSON.parse(localStorage.getItem(recentKey(profile)) ?? "[]") as unknown;
        return Array.isArray(j) ? j.filter((x): x is string => typeof x === "string").slice(0, RECENT_MAX) : [];
    } catch { return []; }
}

function pushRecent(profile: string, q: string): string[] {
    const list = [q, ...readRecent(profile).filter((x) => fold(x) !== fold(q))].slice(0, RECENT_MAX);
    try { localStorage.setItem(recentKey(profile), JSON.stringify(list)); } catch { /* full */ }
    return list;
}

type Res<T> = { s: "idle" } | { s: "loading" } | { s: "ok"; data: T } | { s: "error"; message: string };

interface Results {
    titles: Res<TitleCard[]>;
    music: Res<MusicSearch | null>;
}

const IDLE: Results = { titles: { s: "idle" }, music: { s: "idle" } };

export function Search({ ctx, params }: ScreenProps<"search">) {
    const profile = ctx.media.profile;
    const [q, setQ] = useState(params.initial ?? "");
    const [res, setRes] = useState<Results>(IDLE);
    const [recent, setRecent] = useState<string[]>(() => readRecent(profile));
    const [channels, setChannels] = useState<LiveTvChannel[] | null>(null);
    const [rev, setRev] = useState(0);
    const [ime, setIme] = useState(false);
    const input = useRef<HTMLInputElement>(null);
    const backdrop = useBackdrop();
    const active = useScreenActive();

    useEffect(() => { if (active) backdrop.show(null); }, [active, backdrop]);
    // First focus on the on-screen keyboard (focusing the <input> would pop the Tizen IME).
    useEffect(() => { const h = requestAnimationFrame(() => focusByKey("skb:a")); return () => cancelAnimationFrame(h); }, []);

    // Hub `text` command reuses a live search entry with new params → follow it.
    useEffect(() => { if (params.initial) setQ(params.initial); }, [params.initial]);

    // Channels once (client-side filter).
    useEffect(() => {
        let alive = true;
        ctx.livetv.channels({}).then((c) => { if (alive) setChannels(c.filter((x) => !x.hidden)); }).catch(() => { if (alive) setChannels([]); });
        return () => { alive = false; };
    }, [ctx.livetv]);

    const needle = q.trim();
    const activeQ = needle.length >= MIN_CHARS;

    useEffect(() => {
        if (!activeQ) { setRes(IDLE); return; }
        let alive = true;
        setRes((r) => ({
            titles: r.titles.s === "ok" ? r.titles : { s: "loading" },
            music: r.music.s === "ok" ? r.music : { s: "loading" },
        }));
        const h = setTimeout(() => {
            ctx.media.mediaSearch(needle)
                .then((p) => { if (alive) setRes((r) => ({ ...r, titles: { s: "ok", data: p?.results ?? [] } })); })
                .catch((e: Error) => { if (alive) setRes((r) => ({ ...r, titles: { s: "error", message: e.message } })); });
            ctx.music.search(needle)
                .then((m) => { if (alive) setRes((r) => ({ ...r, music: { s: "ok", data: m } })); })
                .catch(() => { if (alive) setRes((r) => ({ ...r, music: { s: "ok", data: null } })); });
        }, DEBOUNCE_MS);
        return () => { alive = false; clearTimeout(h); };
    }, [ctx.media, ctx.music, needle, activeQ, rev]);

    const remember = useCallback(() => { if (activeQ) setRecent(pushRecent(profile, needle)); }, [activeQ, profile, needle]);

    const titles = res.titles.s === "ok" ? res.titles.data : [];
    const inLib = useMemo(() => titles.filter((c) => c.inLibrary), [titles]);
    const rest = useMemo(() => titles.filter((c) => !c.inLibrary), [titles]);
    const music = res.music.s === "ok" ? res.music.data : null;
    const chans = useMemo(() => {
        if (!activeQ || !channels) return [];
        const f = fold(needle);
        return channels.filter((c) => fold(c.name).includes(f) || (c.number ?? "") === needle || fold(c.group ?? "").includes(f)).slice(0, 40);
    }, [channels, needle, activeQ]);

    const loading = activeQ && (res.titles.s === "loading" || res.music.s === "loading");
    const nothing = activeQ && !loading && res.titles.s !== "error" && titles.length === 0 && chans.length === 0
        && (!music || (music.albums.length + music.artists.length + music.tracks.length === 0));

    const openTitle = (c: TitleCard) => { remember(); ctx.nav.push({ name: "title", kind: c.kind, tmdbId: c.tmdbId, seed: c }); };
    const posterPx = remPx(CARD_REM.poster);

    return (
        <div className="wsr" data-testid="screen-search">
            <div className="wsr-side">
                <h1 className="tv-h1">{t("screen.search")}</h1>
                <input ref={input} className="wsr-input" data-focusable="" data-focus-key="search:input" data-testid="search-input"
                    value={q} placeholder={t("wh.searchPlaceholder")} autoComplete="off" spellCheck={false} readOnly={!ime}
                    aria-label={t("wh.searchPlaceholder")}
                    onChange={(e) => setQ(e.target.value)}
                    onBlur={() => setIme(false)}
                    onKeyDown={(e) => {
                        if (e.key !== "Enter" && e.keyCode !== 13) return;
                        if (!ime) { setIme(true); setTimeout(() => { input.current?.blur(); input.current?.focus(); }, 0); return; }
                        remember(); setIme(false);
                    }} />
                <Keyboard id="skb" value={q} onChange={setQ} onDone={remember} />
                <p className="wsr-hint">{t("wh.searchHint")}</p>
            </div>
            <div className="wsr-main" data-scroll="search-results">
                {!activeQ && recent.length > 0 && (
                    <section className="wt-section">
                        <h2 className="wsr-recent-title">{t("wh.recentSearches")}</h2>
                        <Chips rowId="search:recent" items={recent.map((r) => ({ id: r, label: r, icon: "search" as const }))} value={null} onChange={setQ} wrap />
                    </section>
                )}
                {!activeQ && recent.length === 0 && <Empty icon="search" title={t("wh.searchEmptyTitle")} message={t("wh.searchHint")} />}
                {loading && titles.length === 0 && <LoadingRows rows={2} />}
                {res.titles.s === "error" && <ErrorState message={res.titles.message} onRetry={() => setRev((r) => r + 1)} />}
                {nothing && <Empty icon="search" title={t("search.none", { q: needle })} />}

                {inLib.length > 0 && (
                    <Row<TitleCard> rowId="search:lib" title={t("wh.inYourLibrary")} items={inLib} itemKey={cardKey} testId="search-row"
                        renderItem={(c) => <TitlePoster c={c} media={ctx.media} prefix="search:lib" onOpen={openTitle} />} />
                )}
                {rest.length > 0 && (
                    <Row<TitleCard> rowId="search:titles" title={t("wh.moviesShows")} items={rest} itemKey={cardKey} testId="search-row"
                        renderItem={(c) => <TitlePoster c={c} media={ctx.media} prefix="search:titles" onOpen={openTitle} />} />
                )}
                {music && music.albums.length > 0 && (
                    <Row<AlbumCard> rowId="search:albums" title={t("search.albums")} items={music.albums} itemKey={(a) => a.id} kind="square" testId="search-row"
                        renderItem={(a) => (
                            <PosterCard square focusKey={`search:album:${a.id}`} title={a.name} subtitle={a.artist ?? undefined} placeholderIcon="music"
                                image={ctx.music.coverUrl(a, Math.round(posterPx))} onSelect={() => { remember(); ctx.nav.push({ name: "album", id: a.id, seed: a }); }} />
                        )} />
                )}
                {music && music.artists.length > 0 && (
                    <Row<ArtistCard> rowId="search:artists" title={t("wh.artists")} items={music.artists} itemKey={(a) => a.id} kind="square" testId="search-row"
                        renderItem={(a) => (
                            <PosterCard square focusKey={`search:artist:${a.id}`} title={a.name} subtitle={t("wh.albumsCount", { n: a.albumCount })} placeholderIcon="user"
                                image={ctx.music.coverUrl(a, Math.round(posterPx))} onSelect={() => { remember(); ctx.nav.push({ name: "artist", id: a.id }); }} />
                        )} />
                )}
                {music && music.tracks.length > 0 && (
                    <Row<TrackCard> rowId="search:tracks" title={t("wh.tracks")} items={music.tracks} itemKey={(x) => x.id} kind="square" testId="search-row"
                        renderItem={(x) => (
                            <PosterCard square focusKey={`search:track:${x.id}`} title={x.title} subtitle={[x.artist, x.album].filter(Boolean).join(" · ") || undefined}
                                placeholderIcon="music" image={ctx.music.coverUrl(x, Math.round(posterPx))}
                                onSelect={() => { remember(); ctx.nav.push({ name: "album", id: x.albumId }); }} />
                        )} />
                )}
                {chans.length > 0 && (
                    <Row<LiveTvChannel> rowId="search:channels" title={t("wh.channels")} items={chans} itemKey={(c) => c.id} kind="landscape" testId="search-row"
                        renderItem={(c) => (
                            <LandscapeCard focusKey={`search:ch:${c.id}`} title={c.name} subtitle={[c.number, c.group].filter(Boolean).join(" · ") || undefined}
                                image={ctx.livetv.logoUrl(c)} placeholderIcon="livetv" alwaysShowTitle
                                onSelect={() => { remember(); ctx.nav.push({ name: "livePlay", channelId: c.id }); }} />
                        )} />
                )}
            </div>
        </div>
    );
}
