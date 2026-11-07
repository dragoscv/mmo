/**
 * /media/music — JSON music browse for TV/web clients (WP16-11).
 *
 *   GET /media/music/home?profile=                 → MusicHome
 *   GET /media/music/artists?letter=&offset=&limit= → Page<ArtistCard>
 *   GET /media/music/artists/:id                   → ArtistDetail
 *   GET /media/music/albums/:id                    → AlbumDetail
 *   GET /media/music/genres                        → {genres: GenreCard[]}
 *   GET /media/music/genres/:name?offset=&limit=   → Page<AlbumCard> & {genre}
 *   GET /media/music/search?q=                     → SearchResult
 *   GET /media/music/queue?profile=                → MusicQueue
 *   PUT /media/music/queue?profile=                {trackIds, index, positionSec, shuffle, repeat} → MusicQueue
 *   GET /media/music/lyrics/:trackId               → LyricsResult
 *   GET /media/music/radio?seed=tr_|al_|ar_&size=   → {seed, tracks: TrackCard[]}
 *   GET /media/music/playlists                     → {playlists: PlaylistCard[]}
 *   GET /media/music/tracks?offset=&limit=         → Page<TrackCard> (A–Z by title)
 *   GET /media/music/tracks?ids=tr_1,tr_2          → Page<TrackCard> in the requested order (max 500)
 *
 * Ids are Subsonic ids; `coverUrlPath` / `streamUrlPath` are relative to the server origin
 * (client appends its auth). Auth is the caller's concern (mount behind authMiddleware).
 */

import express from "express";
import { MusicError, MusicService } from "./music";

export interface MusicRouterDeps {
    music: MusicService;
    /**
     * Optional profile guard (PIN-locked profiles). Return the profile id to use, or null after
     * answering the request yourself (e.g. 403). Default: `?profile=` or "default".
     */
    resolveProfile?: (req: express.Request, res: express.Response) => string | null;
    log?: { error: (msg: string, err: unknown, fields?: Record<string, unknown>) => void };
}

const qs = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const qint = (v: unknown): number | undefined => {
    const s = qs(v);
    if (!s) return undefined;
    const n = Number(s);
    return Number.isInteger(n) ? n : undefined;
};

export function createMusicRouter(deps: MusicRouterDeps): express.Router {
    const { music } = deps;
    const router = express.Router();
    router.use(express.json({ limit: "512kb" }));

    const profileOf = (req: express.Request, res: express.Response): string | null =>
        deps.resolveProfile ? deps.resolveProfile(req, res) : (qs(req.query.profile) ?? "default").slice(0, 128);

    const wrap = (fn: (req: express.Request, res: express.Response) => void | Promise<void>): express.RequestHandler =>
        async (req, res) => {
            try {
                await fn(req, res);
            } catch (err: unknown) {
                if (err instanceof MusicError) { res.status(err.status).json({ error: err.message }); return; }
                deps.log?.error("[media/music] handler failed", err, { path: req.path });
                if (!res.headersSent) res.status(500).json({ error: "Internal error" });
            }
        };

    router.get("/home", wrap((req, res) => {
        const p = profileOf(req, res);
        if (p === null) return;
        res.json(music.home(p));
    }));

    router.get("/artists", wrap((req, res) => {
        res.json(music.artists({ letter: qs(req.query.letter), offset: qint(req.query.offset), limit: qint(req.query.limit) }));
    }));

    router.get("/artists/:id", wrap((req, res) => {
        res.json(music.artist(String(req.params.id)));
    }));

    router.get("/albums/:id", wrap((req, res) => {
        res.json(music.album(String(req.params.id)));
    }));

    router.get("/genres", wrap((_req, res) => {
        res.json({ genres: music.genres() });
    }));

    router.get("/genres/:name", wrap((req, res) => {
        res.json(music.genre(String(req.params.name), qint(req.query.offset), qint(req.query.limit)));
    }));

    router.get("/albums", wrap((req, res) => {
        res.json(music.albums({ letter: qs(req.query.letter), offset: qint(req.query.offset), limit: qint(req.query.limit) }));
    }));

    router.get("/playlists/:id", wrap((req, res) => {
        res.json(music.playlist(String(req.params.id)));
    }));

    router.get("/playlists", wrap((_req, res) => {
        res.json({ playlists: music.playlistsList() });
    }));

    router.get("/tracks", wrap((req, res) => {
        const ids = qs(req.query.ids);
        if (ids !== undefined) {
            const list = ids.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
            res.json(music.tracks({ ids: list }));
            return;
        }
        res.json(music.tracks({ offset: qint(req.query.offset), limit: qint(req.query.limit) }));
    }));

    router.get("/radio", wrap((req, res) => {
        const seed = qs(req.query.seed);
        if (!seed) { res.status(400).json({ error: "seed required" }); return; }
        res.json(music.radio(seed, qint(req.query.size)));
    }));

    router.get("/random", wrap((req, res) => {
        res.json({ tracks: music.randomTracks(qint(req.query.size)) });
    }));

    router.get("/search", wrap((req, res) => {
        const q = qs(req.query.q);
        if (!q) { res.status(400).json({ error: "q required" }); return; }
        res.json(music.search(q));
    }));

    router.get("/queue", wrap((req, res) => {
        const p = profileOf(req, res);
        if (p === null) return;
        res.json(music.getQueue(p));
    }));

    router.put("/queue", wrap((req, res) => {
        const p = profileOf(req, res);
        if (p === null) return;
        res.json(music.setQueue(p, req.body));
    }));

    router.get("/lyrics/:trackId", wrap(async (req, res) => {
        res.json(await music.lyricsAsync(String(req.params.trackId)));
    }));

    return router;
}
