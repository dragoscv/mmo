/**
 * Background music engine (WP16-33). ONE hidden `<audio>` owned at module level, so playback survives every
 * screen change (browse while listening). Screens call `musicPlayer.attach(ctx.music, ctx.media)` on mount.
 *
 *   musicPlayer.play(tracks, index, {shuffle?})   new queue, start at index
 *   musicPlayer.playIds(ids, index, {…}, lookup)  same from track ids (hub `play {trackIds}`, server 3.12)
 *   toggle / pause / resume / next / prev / seek(sec) / seekBy(d) / skipTo(i) / enqueue(tracks, "next"|"end")
 *   setShuffle(on) / cycleRepeat() / stop()
 *   useMusicState()      queue/index/current/playing/shuffle/repeat (re-renders on state changes only)
 *   useMusicProgress()   {position, duration} (re-renders ~4×/s while playing)
 *
 * Side effects: publishes `playerBus.setNowPlaying({kind:"audio"…})` (the Rail mini-player reads it), handles
 * bus commands (hub remote) while no video player is on top, pauses when a video/live player publishes,
 * media keys (play/pause, ±10 s on FF/REW, MediaTrackNext/Previous), PUT /media/music/queue (debounced 1.5 s,
 * position every 30 s), POST /media/plays (`tr_<id>`) once per play at 50 % or 4 min, restores the server queue
 * (paused) on first attach.
 */
import { useSyncExternalStore } from "react";
import type { ServerConfig } from "./config";
import { Emitter } from "./emitter";
import { ServerHttp, enc } from "./http";
import type { MediaClient } from "./media";
import type { MusicClient } from "./music";
import type { RepeatMode, TrackCard } from "./media-types";
import { orderTracks, resolvedIndex, trackHubMedia } from "./music-remote";
import { playerBus, type PlayerCommand } from "./player-bus";
import { keyFromEvent } from "./tv-keys";

export interface MusicState {
    queue: TrackCard[];
    /** Index of `current` in `queue` (-1 when empty). */
    index: number;
    current: TrackCard | null;
    playing: boolean;
    buffering: boolean;
    shuffle: boolean;
    repeat: RepeatMode;
    error: string | null;
    /** Restoring the server queue (first attach). */
    restoring: boolean;
}

export interface MusicProgress {
    position: number;
    duration: number;
}

export interface PlayOpts {
    shuffle?: boolean;
    /** Seconds into the first track. */
    startSec?: number;
    /** Repeat mode for the new queue (unchanged when omitted). */
    repeat?: RepeatMode;
}

/** Batch track lookup (`GET /media/music/tracks?ids=`); null/throw = unsupported → Subsonic fallback. */
export type TrackLookup = (ids: string[]) => Promise<TrackCard[] | null>;

const MAX_QUEUE = 2000;
const LOOKUP_CHUNK = 100;
const SAVE_DEBOUNCE_MS = 1500;
const SAVE_POSITION_EVERY_MS = 30_000;
const PLAY_THRESHOLD_SEC = 240;
const KEY_TRACK_NEXT = 10233;
const KEY_TRACK_PREV = 10232;

const EMPTY: MusicState = {
    queue: [], index: -1, current: null, playing: false, buffering: false, shuffle: false, repeat: "off", error: null, restoring: false,
};

export function trackKeyOf(id: string): string {
    return /^tr_\d+$/.test(id) ? id : `tr_${id}`;
}

function shuffled<T>(a: T[]): T[] {
    const out = a.slice();
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const t = out[i]!;
        out[i] = out[j]!;
        out[j] = t;
    }
    return out;
}

interface SubsonicSongBody {
    id: string; title?: string; artist?: string; artistId?: string; album?: string; albumId?: string; track?: number;
    discNumber?: number; year?: number; genre?: string; duration?: number; suffix?: string; bitRate?: number; coverArt?: string;
}

class MusicPlayer {
    private audio: HTMLAudioElement | null = null;
    private music: MusicClient | null = null;
    private media: MediaClient | null = null;
    private state: MusicState = EMPTY;
    private progress: MusicProgress = { position: 0, duration: 0 };
    private readonly stateChanges = new Emitter<MusicState>();
    private readonly progressChanges = new Emitter<MusicProgress>();
    /** Queue in original (unshuffled) order. */
    private original: TrackCard[] = [];
    private installed = false;
    private restored = false;
    private saveTimer: ReturnType<typeof setTimeout> | null = null;
    private lastSaveAt = 0;
    private lastBusAt = 0;
    /** Seconds to seek to once the current source has metadata (restore / resume after stop). */
    private pendingStart = 0;
    private loadedId: string | null = null;
    private listened = 0;
    private lastTime = 0;
    private playLogged = false;
    private errorSkips = 0;
    /** After `stop()` the queue stays but nothing is published (no mini-player) until playback restarts. */
    private hidden = false;

    // ─── wiring ──────────────────────────────────────────────────────────

    /** Bind the data clients of the current connection/profile. A different client instance (profile switch,
     *  new server) stops playback and restores that profile's queue. */
    attach(music: MusicClient, media: MediaClient | null): void {
        if (this.music && this.music !== music) {
            this.stop();
            this.original = [];
            this.set({ ...EMPTY });
            this.restored = false;
        }
        this.music = music;
        this.media = media;
        this.install();
        if (!this.restored) {
            this.restored = true;
            void this.restore();
        }
    }

    private install(): void {
        if (this.installed || typeof window === "undefined") return;
        this.installed = true;
        playerBus.subscribe((cmd) => this.onBus(cmd));
        playerBus.onNowPlaying((np) => {
            if (np && np.kind !== "audio" && this.state.playing) this.pause();
            // A video player clears now-playing on unmount → bring the music chip back.
            if (!np && this.state.current && !this.hidden) setTimeout(() => { if (!playerBus.nowPlaying()) this.publish(true); }, 0);
        });
        window.addEventListener("keydown", (e) => this.onKey(e));
        try {
            const dev = typeof tizen !== "undefined" ? tizen?.tvinputdevice : undefined;
            for (const k of ["MediaTrackNext", "MediaTrackPrevious"]) { try { dev?.registerKey(k); } catch { /* unsupported */ } }
        } catch { /* not Tizen */ }
    }

    private el(): HTMLAudioElement {
        if (this.audio) return this.audio;
        const a = document.createElement("audio");
        a.preload = "auto";
        a.setAttribute("data-mixai-music", "");
        a.style.display = "none";
        document.body.appendChild(a);
        a.addEventListener("timeupdate", () => this.onTime());
        a.addEventListener("durationchange", () => this.setProgress());
        a.addEventListener("loadedmetadata", () => {
            if (this.pendingStart > 0 && Number.isFinite(a.duration) && this.pendingStart < a.duration - 2) a.currentTime = this.pendingStart;
            this.pendingStart = 0;
            this.setProgress();
        });
        a.addEventListener("playing", () => { this.errorSkips = 0; this.set({ playing: true, buffering: false, error: null }); });
        a.addEventListener("play", () => this.set({ playing: true }));
        a.addEventListener("pause", () => { this.set({ playing: false }); this.scheduleSave(); });
        a.addEventListener("waiting", () => this.set({ buffering: true }));
        a.addEventListener("ended", () => this.next(true));
        a.addEventListener("error", () => {
            if (!a.getAttribute("src")) return;
            this.set({ playing: false, buffering: false, error: `media ${a.error?.code ?? "?"}` });
            // Skip unplayable tracks, but never loop forever over a broken queue.
            if (++this.errorSkips <= 3 && this.state.index + 1 < this.state.queue.length) setTimeout(() => this.next(true), 1500);
        });
        this.audio = a;
        return a;
    }

    // ─── store ───────────────────────────────────────────────────────────

    getState(): MusicState { return this.state; }
    getProgress(): MusicProgress { return this.progress; }
    subscribeState(fn: () => void): () => void { return this.stateChanges.on(fn); }
    subscribeProgress(fn: () => void): () => void { return this.progressChanges.on(fn); }

    private set(patch: Partial<MusicState>): void {
        const next = { ...this.state, ...patch };
        next.current = next.index >= 0 ? next.queue[next.index] ?? null : null;
        const changed = (Object.keys(next) as Array<keyof MusicState>).some((k) => next[k] !== this.state[k]);
        if (!changed) return;
        this.state = next;
        this.stateChanges.emit(next);
        this.publish(true);
    }

    private setProgress(): void {
        const a = this.audio;
        const position = a ? a.currentTime : 0;
        const d = a && Number.isFinite(a.duration) && a.duration > 0 ? a.duration : this.state.current?.durationSec ?? 0;
        const pos = this.pendingStart > 0 ? this.pendingStart : position;
        if (Math.abs(pos - this.progress.position) < 0.05 && d === this.progress.duration) return;
        this.progress = { position: pos, duration: d };
        this.progressChanges.emit(this.progress);
    }

    private publish(force: boolean): void {
        const now = Date.now();
        if (!force && now - this.lastBusAt < 1000) return;
        this.lastBusAt = now;
        const t = this.hidden ? null : this.state.current;
        if (!t) { if (playerBus.nowPlaying()?.kind === "audio") playerBus.setNowPlaying(null); return; }
        // Never overwrite a video/live player that is publishing right now.
        const cur = playerBus.nowPlaying();
        if (cur && cur.kind !== "audio") return;
        playerBus.setNowPlaying({
            kind: "audio",
            playing: this.state.playing,
            positionSec: this.progress.position,
            durationSec: this.progress.duration || t.durationSec || undefined,
            media: trackHubMedia(t),
            title: t.title,
            subtitle: [t.artist, t.album].filter(Boolean).join(" · ") || undefined,
            artUrl: this.music?.coverUrl(t, 200) ?? null,
            updatedAt: now,
        });
    }

    // ─── events ──────────────────────────────────────────────────────────

    private onTime(): void {
        const a = this.audio;
        if (!a) return;
        const t = a.currentTime;
        const d = t - this.lastTime;
        if (d > 0 && d < 2) this.listened += d;
        this.lastTime = t;
        this.setProgress();
        this.publish(false);
        const cur = this.state.current;
        const dur = this.progress.duration || cur?.durationSec || 0;
        if (cur && !this.playLogged && dur > 0 && this.listened >= Math.min(PLAY_THRESHOLD_SEC, dur * 0.5)) {
            this.playLogged = true;
            void this.media?.recordPlay({ trackKey: trackKeyOf(cur.id), durationSec: Math.round(this.listened) })?.catch(() => undefined);
        }
        if (this.state.playing && Date.now() - this.lastSaveAt > SAVE_POSITION_EVERY_MS) this.scheduleSave();
    }

    private onBus(cmd: PlayerCommand): boolean {
        if (!this.state.current) return false;
        switch (cmd.type) {
            case "pause": this.pause(); break;
            case "resume": this.resume(); break;
            case "toggle": this.toggle(); break;
            case "seek": this.seek(cmd.positionSec); break;
            case "seekBy": this.seekBy(cmd.deltaSec); break;
            case "stop": this.stop(); break;
            case "next": this.next(); break;
            case "previous": this.prev(); break;
            case "volume": { const a = this.el(); a.volume = Math.max(0, Math.min(1, cmd.level > 1 ? cmd.level / 100 : cmd.level)); break; }
            case "rate": break;
        }
        return true;
    }

    private onKey(e: KeyboardEvent): void {
        if (!this.state.current || e.defaultPrevented) return;
        if (e.keyCode === KEY_TRACK_NEXT) { this.next(); e.preventDefault(); return; }
        if (e.keyCode === KEY_TRACK_PREV) { this.prev(); e.preventDefault(); return; }
        switch (keyFromEvent(e)) {
            case "playpause": this.toggle(); break;
            case "play": this.resume(); break;
            case "pause": this.pause(); break;
            case "fastforward": this.seekBy(10); break;
            case "rewind": this.seekBy(-10); break;
            case "stop": this.pause(); break;
            default: return;
        }
        e.preventDefault();
    }

    // ─── transport ───────────────────────────────────────────────────────

    private load(index: number, autoplay: boolean, startAt = 0): void {
        const t = this.state.queue[index];
        if (!t || !this.music) return;
        const a = this.el();
        this.hidden = false;
        this.listened = 0;
        this.lastTime = startAt;
        this.playLogged = false;
        this.pendingStart = startAt;
        this.loadedId = t.id;
        a.src = this.music.streamUrl(t);
        this.set({ index, error: null, buffering: autoplay });
        this.progress = { position: startAt, duration: t.durationSec || 0 };
        this.progressChanges.emit(this.progress);
        if (autoplay) a.play().catch(() => this.set({ playing: false, buffering: false }));
        this.scheduleSave();
    }

    play(tracks: TrackCard[], index = 0, opts: PlayOpts = {}): void {
        if (tracks.length === 0) return;
        const list = tracks.slice(0, MAX_QUEUE);
        this.original = list.slice();
        let start = Math.max(0, Math.min(index, list.length - 1));
        let queue = list;
        const shuffle = opts.shuffle ?? false;
        if (shuffle) {
            const first = opts.shuffle && index === 0 ? Math.floor(Math.random() * list.length) : start;
            const head = list[first]!;
            queue = [head, ...shuffled(list.filter((_, i) => i !== first))];
            start = 0;
        }
        this.set({ queue, shuffle, restoring: false, ...(opts.repeat ? { repeat: opts.repeat } : {}) });
        this.load(start, true, Math.max(0, opts.startSec ?? 0));
    }

    /**
     * Remote play (hub `play {trackIds, index, positionSec?, shuffle?, repeat?}`): resolves the ids — batch
     * `lookup` first, Subsonic `getSong` for whatever it did not return — then replaces the queue and plays.
     * With `shuffle` the requested track stays first. Resolves to the number of queued tracks (0 = nothing playable).
     */
    async playIds(ids: string[], index: number, opts: PlayOpts, lookup: TrackLookup | null): Promise<number> {
        const m = this.music;
        if (!m) throw new Error("music_unavailable");
        const wanted = ids.slice(0, MAX_QUEUE);
        const found: TrackCard[] = [];
        if (lookup) {
            for (let i = 0; i < wanted.length; i += LOOKUP_CHUNK) {
                const r = await lookup(wanted.slice(i, i + LOOKUP_CHUNK)).catch(() => null);
                if (!r) break; // older server: no batch route → fallback for the rest
                found.push(...r);
            }
        }
        const first = orderTracks(wanted, found);
        let slots = first.tracks;
        if (first.missing.length > 0) {
            const extra = await this.resolveTracks(m, first.missing);
            slots = orderTracks(wanted, [...found, ...extra]).tracks;
        }
        if (this.music !== m) throw new Error("music_unavailable");
        const tracks = slots.filter((t): t is TrackCard => t !== null);
        if (tracks.length === 0) return 0;
        const start = resolvedIndex(slots, index);
        const exact = slots[index] != null;
        if (opts.shuffle) {
            // Keep the requested track first (play() randomises the head only when index is 0).
            const head = tracks[start]!;
            this.original = tracks.slice();
            const queue = [head, ...shuffled(tracks.filter((_, i) => i !== start))];
            this.set({ queue, shuffle: true, restoring: false, ...(opts.repeat ? { repeat: opts.repeat } : {}) });
            this.load(0, true, exact ? Math.max(0, opts.startSec ?? 0) : 0);
        } else {
            this.play(tracks, start, { repeat: opts.repeat, startSec: exact ? opts.startSec : 0 });
        }
        return tracks.length;
    }

    /** Hub transport fallback when no video player is on top; false when nothing is loaded. */
    remote(cmd: PlayerCommand): boolean { return this.onBus(cmd); }

    get hasTrack(): boolean { return this.state.current !== null; }

    toggle(): void { if (this.state.playing) this.pause(); else this.resume(); }

    pause(): void { this.audio?.pause(); }

    resume(): void {
        const cur = this.state.current;
        if (!cur) return;
        const a = this.el();
        if (this.loadedId !== cur.id || !a.getAttribute("src")) { this.load(this.state.index, true, this.progress.position); return; }
        a.play().catch(() => undefined);
    }

    next(auto = false): void {
        const { queue, index, repeat } = this.state;
        if (queue.length === 0) return;
        if (auto && repeat === "one") { this.seek(0); this.audio?.play().catch(() => undefined); return; }
        let n = index + 1;
        if (n >= queue.length) {
            if (repeat !== "all") {
                if (auto) { this.audio?.pause(); this.seek(0); }
                return;
            }
            n = 0;
        }
        this.load(n, true);
    }

    prev(): void {
        const a = this.audio;
        if (a && a.currentTime > 3) { this.seek(0); return; }
        if (this.state.index > 0) this.load(this.state.index - 1, true);
        else if (this.state.repeat === "all" && this.state.queue.length > 1) this.load(this.state.queue.length - 1, true);
        else this.seek(0);
    }

    seek(sec: number): void {
        const a = this.audio;
        if (!a || this.loadedId !== this.state.current?.id) { this.pendingStart = Math.max(0, sec); this.setProgress(); return; }
        const d = Number.isFinite(a.duration) ? a.duration : Infinity;
        a.currentTime = Math.max(0, Math.min(d - 0.5, sec));
        this.lastTime = a.currentTime;
        this.setProgress();
    }

    seekBy(delta: number): void { this.seek((this.audio?.currentTime ?? this.progress.position) + delta); }

    skipTo(i: number): void {
        if (i < 0 || i >= this.state.queue.length) return;
        this.load(i, true);
    }

    enqueue(tracks: TrackCard[], where: "next" | "end" = "end"): void {
        if (tracks.length === 0) return;
        const { queue, index } = this.state;
        if (queue.length === 0) { this.play(tracks, 0); this.pause(); return; }
        const room = Math.max(0, MAX_QUEUE - queue.length);
        const add = tracks.slice(0, room);
        const q = where === "next" ? [...queue.slice(0, index + 1), ...add, ...queue.slice(index + 1)] : [...queue, ...add];
        this.original = [...this.original, ...add];
        this.set({ queue: q });
        this.scheduleSave();
    }

    setShuffle(on: boolean): void {
        const { queue, index, current } = this.state;
        if (on === this.state.shuffle) return;
        if (!current) { this.set({ shuffle: on }); return; }
        if (on) {
            this.original = queue.slice();
            const rest = queue.filter((_, i) => i !== index);
            this.set({ queue: [current, ...shuffled(rest)], index: 0, shuffle: true });
        } else {
            const base = this.original.length > 0 ? this.original : queue;
            const i = base.findIndex((t) => t.id === current.id);
            this.set({ queue: base.slice(), index: i >= 0 ? i : 0, shuffle: false });
        }
        this.scheduleSave();
    }

    cycleRepeat(): void {
        const r = this.state.repeat;
        this.set({ repeat: r === "off" ? "all" : r === "all" ? "one" : "off" });
        this.scheduleSave();
    }

    /** Stops and unloads the source (queue kept; the mini-player chip disappears). */
    stop(): void {
        const a = this.audio;
        if (a) {
            this.pendingStart = 0;
            a.pause();
            a.removeAttribute("src");
            a.load();
        }
        this.loadedId = null;
        this.hidden = true;
        this.scheduleSave();
        this.set({ playing: false, buffering: false });
        if (playerBus.nowPlaying()?.kind === "audio") playerBus.setNowPlaying(null);
    }

    // ─── server queue ────────────────────────────────────────────────────

    private scheduleSave(): void {
        if (!this.music) return;
        if (this.saveTimer) clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => { this.saveTimer = null; void this.save(); }, SAVE_DEBOUNCE_MS);
    }

    private async save(): Promise<void> {
        const m = this.music;
        if (!m) return;
        this.lastSaveAt = Date.now();
        const ids = this.state.queue.map((t) => t.id).filter((id) => /^tr_\d+$/.test(id));
        const curId = this.state.current?.id;
        const idx = curId ? Math.max(0, ids.indexOf(curId)) : 0;
        try {
            await m.setQueue({
                trackIds: ids, index: ids.length ? idx : 0, positionSec: Math.floor(this.audio?.currentTime ?? this.progress.position),
                shuffle: this.state.shuffle, repeat: this.state.repeat,
            });
        } catch { /* offline — next change retries */ }
    }

    private async restore(): Promise<void> {
        const m = this.music;
        if (!m || this.state.current) return;
        this.set({ restoring: true });
        try {
            const q = await m.queue();
            if (!q || q.trackIds.length === 0 || this.music !== m || this.state.current) return;
            const from = Math.max(0, q.index - 20);
            const ids = q.trackIds.slice(from, q.index + 100);
            const tracks = await this.resolveTracks(m, ids);
            if (this.music !== m || this.state.current || tracks.length === 0) return;
            const curId = q.trackIds[q.index];
            const index = Math.max(0, tracks.findIndex((t) => t.id === curId));
            this.original = tracks.slice();
            this.pendingStart = q.positionSec;
            this.progress = { position: q.positionSec, duration: tracks[index]?.durationSec ?? 0 };
            this.set({ queue: tracks, index, shuffle: q.shuffle, repeat: q.repeat, playing: false });
            this.progressChanges.emit(this.progress);
        } catch { /* no queue */ } finally {
            this.set({ restoring: false });
        }
    }

    /** Subsonic `getSong` per id (4 in parallel) → TrackCard. The URL is signed by `MusicClient.streamUrl`,
     *  which signs whatever `streamUrlPath` it is given. */
    private async resolveTracks(m: MusicClient, ids: string[]): Promise<TrackCard[]> {
        const out: Array<TrackCard | null> = new Array(ids.length).fill(null);
        let i = 0;
        const worker = async () => {
            while (i < ids.length) {
                const k = i++;
                const id = ids[k]!;
                try {
                    const r = await fetch(m.streamUrl({ id, streamUrlPath: `/rest/getSong.view?id=${encodeURIComponent(id)}` }));
                    const j = (await r.json()) as { "subsonic-response"?: { status?: string; song?: SubsonicSongBody } };
                    const s = j["subsonic-response"]?.song;
                    if (s) out[k] = songToCard(s);
                } catch { /* skip */ }
            }
        };
        await Promise.all([worker(), worker(), worker(), worker()]);
        return out.filter((t): t is TrackCard => t !== null);
    }
}

function songToCard(s: SubsonicSongBody): TrackCard {
    const cover = s.coverArt ?? s.id;
    return {
        id: s.id, title: s.title ?? s.id, artist: s.artist ?? null, artistId: s.artistId ?? null, album: s.album ?? null,
        albumId: s.albumId ?? "", track: s.track ?? null, disc: s.discNumber ?? null, year: s.year ?? null, genre: s.genre ?? null,
        durationSec: s.duration ?? 0, format: s.suffix ?? "", bitrate: s.bitRate ?? null, hasLyrics: false, hasSyncedLyrics: false,
        coverArt: cover, coverUrlPath: `/rest/getCoverArt.view?id=${encodeURIComponent(cover)}&size=400`,
        streamUrlPath: `/rest/stream.view?id=${encodeURIComponent(s.id)}`,
    };
}

export const musicPlayer = new MusicPlayer();

/** `GET /media/music/tracks?ids=a,b` (server 3.12, `{items}` in request order). An older server ignores `ids`
 *  and answers a page of unrelated tracks — `orderTracks` drops those and the Subsonic fallback fills in. */
export function trackLookup(cfg: ServerConfig, headers: () => Record<string, string>): TrackLookup {
    const http = new ServerHttp(cfg, headers);
    return async (ids) => {
        const r = await http.get<{ items?: TrackCard[] }>(`/media/music/tracks?ids=${ids.map(enc).join(",")}&limit=${ids.length}`, { allow404: true });
        return Array.isArray(r?.items) ? r.items : null;
    };
}

export function useMusicState(): MusicState {
    return useSyncExternalStore((fn) => musicPlayer.subscribeState(fn), () => musicPlayer.getState(), () => musicPlayer.getState());
}

export function useMusicProgress(): MusicProgress {
    return useSyncExternalStore((fn) => musicPlayer.subscribeProgress(fn), () => musicPlayer.getProgress(), () => musicPlayer.getProgress());
}
