import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { MmoClient, ProbedVideo, SubsonicAlbum } from "../lib/api";
import { groupShows, isEpisode, type Show } from "../lib/shows";
import { t } from "../i18n/messages";
import { AlbumCard, ShowCard, SkeletonCard, VideoCard } from "./cards";

interface Props {
    client: MmoClient;
    /** The Home `listVideos()` result — filtered client-side. */
    videos: ProbedVideo[];
    onPlayVideo: (v: ProbedVideo) => void;
    onOpenShow: (s: Show) => void;
    onOpenAlbum: (a: SubsonicAlbum) => void;
}

const DEBOUNCE_MS = 400;
const MIN_CHARS = 2;

export function SearchScreen({ client, videos, onPlayVideo, onOpenShow, onOpenAlbum }: Props) {
    const [q, setQ] = useState("");
    const [albums, setAlbums] = useState<{ state: "idle" | "loading" | "ok"; data: SubsonicAlbum[] }>({ state: "idle", data: [] });
    const input = useRef<HTMLInputElement>(null);

    useEffect(() => { const h = setTimeout(() => input.current?.focus(), 60); return () => clearTimeout(h); }, []);

    const needle = q.trim().toLowerCase();
    const active = needle.length >= MIN_CHARS;
    const movies = useMemo(() => (active ? videos.filter((v) => !isEpisode(v) && v.parsed.title.toLowerCase().includes(needle)) : []), [videos, needle, active]);
    const shows = useMemo(() => (active ? groupShows(videos).filter((s) => s.key.includes(needle)) : []), [videos, needle, active]);

    // Albums via the server (debounced).
    useEffect(() => {
        if (!active) { setAlbums({ state: "idle", data: [] }); return; }
        let alive = true;
        setAlbums((a) => ({ state: "loading", data: a.data }));
        const h = setTimeout(() => {
            client.search(q.trim())
                .then((r) => { if (alive) setAlbums({ state: "ok", data: r.albums }); })
                .catch(() => { if (alive) setAlbums({ state: "ok", data: [] }); });
        }, DEBOUNCE_MS);
        return () => { alive = false; clearTimeout(h); };
    }, [client, q, active]);

    const submit = (e: FormEvent) => { e.preventDefault(); input.current?.blur(); };
    const nothing = active && albums.state === "ok" && movies.length === 0 && shows.length === 0 && albums.data.length === 0;

    return (
        <div className="screen">
            <h1 className="screen-title">{t("search.title")}</h1>
            <form className="search-form" onSubmit={submit}>
                <input ref={input} data-focusable data-testid="search-input" value={q} onChange={(e) => setQ(e.target.value)}
                    placeholder={t("search.placeholder")} autoComplete="off" />
            </form>
            <p className="screen-sub">{t("search.hint")}</p>
            <div className="rows">
                {nothing && <div className="empty" data-testid="search-empty">{t("search.none", { q: q.trim() })}</div>}
                {movies.length > 0 && (
                    <section className="row">
                        <h2 className="row-title">{t("search.movies")}</h2>
                        <div className="row-track">{movies.map((v) => <VideoCard key={v.fileId} v={v} client={client} onClick={() => onPlayVideo(v)} />)}</div>
                    </section>
                )}
                {shows.length > 0 && (
                    <section className="row">
                        <h2 className="row-title">{t("search.shows")}</h2>
                        <div className="row-track">{shows.map((s) => <ShowCard key={s.key} show={s} client={client} onClick={() => onOpenShow(s)} />)}</div>
                    </section>
                )}
                {active && (albums.state === "loading" || albums.data.length > 0) && (
                    <section className="row">
                        <h2 className="row-title">{t("search.albums")}</h2>
                        <div className="row-track" aria-busy={albums.state === "loading"}>
                            {albums.state === "loading" && albums.data.length === 0
                                ? Array.from({ length: 4 }, (_, i) => <SkeletonCard key={i} />)
                                : albums.data.map((a) => <AlbumCard key={a.id} a={a} client={client} onClick={() => onOpenAlbum(a)} />)}
                        </div>
                    </section>
                )}
            </div>
        </div>
    );
}
