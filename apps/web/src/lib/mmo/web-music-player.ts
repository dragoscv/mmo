/**
 * Web background music engine (WP16-40) — port of tv-tizen `music-player.ts` for the `/media` surface.
 * Module-level singleton on two hidden `<audio>` elements (active + standby): the standby preloads the
 * next track and is swapped in when playback advances (gapless-ish). Separate from the DJ PlayerProvider.
 *
 *   webMusicPlayer.attach(music, media, profileId)   bind clients; restores the server queue (paused) once per profile
 *   play(tracks, index, {shuffle?}) / toggle / pause / resume / next / prev / seek / seekBy / skipTo
 *   enqueue(tracks, "next"|"end") / moveInQueue(from, to) / removeFromQueue(i) / setShuffle / cycleRepeat
 *   setVolume(0..1) / setMuted / stop
 *   useWebMusicState() / useWebMusicProgress() / useWebMusicVolume()   React hooks
 *
 * Side effects: publishes `playerBus.setNowPlaying({kind:"audio"})` (the hub forwards it), answers bus
 * commands (hub remote) while no video player is on top, pauses itself when any <video> starts or a
 * video/live player publishes, Media Session metadata + actions, PUT /media/music/queue (debounced 1.5 s,
 * position every 30 s), POST /media/plays once per play after 30 s or 50 %.
 */
import { useSyncExternalStore } from "react";
import { Emitter } from "./emitter";
import type { MediaClient } from "./media";
import type { MusicClient } from "./music";
import type { RepeatMode, TrackCard } from "./media-types";
import {
    cycleRepeat as nextRepeat, indexAfterMove, indexAfterRemove, moveItem, nextIndex, playThresholdSec, prevIndex,
    shuffleKeepFirst, trackKeyOf,
} from "./music-core";
import { playerBus, type PlayerCommand } from "./player-bus";
import { mediaUrl } from "./offline/keys";

export interface WebMusicState {
    queue: TrackCard[];
    /** Index of `current` in `queue` (-1 when empty). */
    index: number;
    current: TrackCard | null;
    playing: boolean;
    buffering: boolean;
    shuffle: boolean;
    repeat: RepeatMode;
    /** Last media error code (UI shows a generic message). */
    error: number | null;
    /** Restoring the server queue (first attach). */
    restoring: boolean;
    /** Stopped by the user: queue kept, mini-player hidden. */
    hidden: boolean;
}

export interface WebMusicProgress { position: number; duration: number }
export interface WebMusicVolume { volume: number; muted: boolean }

const MAX_QUEUE = 2000;
const SAVE_DEBOUNCE_MS = 1500;
const SAVE_POSITION_EVERY_MS = 30_000;
const VOLUME_KEY = "mixai:music:volume";

const EMPTY: WebMusicState = {
    queue: [], index: -1, current: null, playing: false, buffering: false, shuffle: false, repeat: "off", error: null,
    restoring: false, hidden: false,
};
const ZERO: WebMusicProgress = { position: 0, duration: 0 };
const DEFAULT_VOLUME: WebMusicVolume = { volume: 1, muted: false };

interface SubsonicSongBody {
    id: string; title?: string; artist?: string; artistId?: string; album?: string; albumId?: string; track?: number;
    discNumber?: number; year?: number; genre?: string; duration?: number; suffix?: string; bitRate?: number; coverArt?: string;
}

class WebMusicPlayer {
    private audio: HTMLAudioElement | null = null;
    private standby: HTMLAudioElement | null = null;
    private standbyId: string | null = null;
    private music: MusicClient | null = null;
    private media: MediaClient | null = null;
    private profileId: string | null = null;
    private state: WebMusicState = EMPTY;
    private progress: WebMusicProgress = ZERO;
    private vol: WebMusicVolume = DEFAULT_VOLUME;
    private readonly stateChanges = new Emitter<WebMusicState>();
    private readonly progressChanges = new Emitter<WebMusicProgress>();
    private readonly volumeChanges = new Emitter<WebMusicVolume>();
    /** Queue in original (unshuffled) order. */
    private original: TrackCard[] = [];
    private installed = false;
    private restoredFor: string | null = null;
    private saveTimer: ReturnType<typeof setTimeout> | null = null;
    private lastSaveAt = 0;
    private lastBusAt = 0;
    private lastPositionStateAt = 0;
    private pendingStart = 0;
    private loadedId: string | null = null;
    private listened = 0;
    private lastTime = 0;
    private playLogged = false;
    private errorSkips = 0;
    /** Track id → offline key of finished downloads (current server + profile); played from `/__offline/`. */
    private offline: ReadonlyMap<string, string> = new Map();

    // ─── wiring ──────────────────────────────────────────────────────────

    /** Bind the clients of the current server + profile. A new client or profile stops playback and restores
     *  that profile's queue. */
    attach(music: MusicClient, media: MediaClient | null, profileId: string | null): void {
        const key = profileId ?? "default";
        if ((this.music && this.music !== music) || (this.profileId !== null && this.profileId !== key)) {
            this.stop();
            this.original = [];
            this.set({ ...EMPTY });
            this.restoredFor = null;
        }
        this.music = music;
        this.media = media;
        this.profileId = key;
        this.install();
        if (this.restoredFor !== key) {
            this.restoredFor = key;
            void this.restore();
        }
    }

    private install(): void {
        if (this.installed || typeof window === "undefined") return;
        this.installed = true;
        this.vol = readVolume();
        playerBus.subscribe((cmd) => this.onBus(cmd));
        playerBus.onNowPlaying((np) => {
            if (np && np.kind !== "audio" && this.state.playing) this.pause();
            // A video player clears now-playing on unmount → publish the music state again.
            if (!np && this.state.current && !this.state.hidden) setTimeout(() => { if (!playerBus.nowPlaying()) this.publish(true); }, 0);
        });
        // Any <video> on the page (trailers excluded: muted autoplay) pauses music.
        document.addEventListener("play", (e) => {
            const el = e.target;
            if (el instanceof HTMLVideoElement && !el.muted && this.state.playing) this.pause();
        }, true);
        this.installMediaSession();
    }

    /** Downloaded tracks of the current server + profile; those play from the device instead of the server. */
    setOffline(map: ReadonlyMap<string, string>): void { this.offline = map; }

    /** Whether `trackId` plays from a download on this device. */
    isOffline(trackId: string): boolean { return this.offline.has(trackId); }

    private srcOf(t: TrackCard): string {
        const key = this.offline.get(t.id);
        return key ? mediaUrl(key) : this.music!.streamUrl(t);
    }

    private makeAudio(): HTMLAudioElement {
        const a = document.createElement("audio");
        a.preload = "auto";
        a.setAttribute("data-mixai-web-music", "");
        a.hidden = true;
        document.body.appendChild(a);
        a.volume = this.vol.volume;
        a.muted = this.vol.muted;
        const mine = () => a === this.audio;
        a.addEventListener("timeupdate", () => { if (mine()) this.onTime(); });
        a.addEventListener("durationchange", () => { if (mine()) this.setProgress(); });
        a.addEventListener("loadedmetadata", () => {
            if (!mine()) return;
            if (this.pendingStart > 0 && Number.isFinite(a.duration) && this.pendingStart < a.duration - 2) a.currentTime = this.pendingStart;
            this.pendingStart = 0;
            this.setProgress();
        });
        a.addEventListener("playing", () => { if (mine()) { this.errorSkips = 0; this.set({ playing: true, buffering: false, error: null }); this.preloadNext(); } });
        a.addEventListener("play", () => { if (mine()) this.set({ playing: true }); });
        a.addEventListener("pause", () => { if (mine()) { this.set({ playing: false }); this.scheduleSave(); } });
        a.addEventListener("waiting", () => { if (mine()) this.set({ buffering: true }); });
        a.addEventListener("ended", () => { if (mine()) this.next(true); });
        a.addEventListener("error", () => {
            if (!mine() || !a.getAttribute("src")) return;
            this.set({ playing: false, buffering: false, error: a.error?.code ?? 0 });
            // Skip unplayable tracks, but never loop forever over a broken queue.
            if (++this.errorSkips <= 3 && this.state.index + 1 < this.state.queue.length) setTimeout(() => this.next(true), 1500);
        });
        return a;
    }

    private el(): HTMLAudioElement {
        if (!this.audio) this.audio = this.makeAudio();
        return this.audio;
    }

    // ─── store ───────────────────────────────────────────────────────────

    getState(): WebMusicState { return this.state; }
    getProgress(): WebMusicProgress { return this.progress; }
    getVolume(): WebMusicVolume { return this.vol; }
    subscribeState(fn: () => void): () => void { return this.stateChanges.on(fn); }
    subscribeProgress(fn: () => void): () => void { return this.progressChanges.on(fn); }
    subscribeVolume(fn: () => void): () => void { return this.volumeChanges.on(fn); }

    private set(patch: Partial<WebMusicState>): void {
        const next = { ...this.state, ...patch };
        next.current = next.index >= 0 ? next.queue[next.index] ?? null : null;
        const changed = (Object.keys(next) as Array<keyof WebMusicState>).some((k) => next[k] !== this.state[k]);
        if (!changed) return;
        const trackChanged = next.current?.id !== this.state.current?.id;
        this.state = next;
        this.stateChanges.emit(next);
        this.publish(true);
        this.updateMediaSession(trackChanged);
    }

    private setProgress(): void {
        const a = this.audio;
        const d = a && Number.isFinite(a.duration) && a.duration > 0 ? a.duration : this.state.current?.durationSec ?? 0;
        const pos = this.pendingStart > 0 ? this.pendingStart : a ? a.currentTime : 0;
        if (Math.abs(pos - this.progress.position) < 0.05 && d === this.progress.duration) return;
        this.progress = { position: pos, duration: d };
        this.progressChanges.emit(this.progress);
        this.updatePositionState(false);
    }

    private publish(force: boolean): void {
        const now = Date.now();
        if (!force && now - this.lastBusAt < 1000) return;
        this.lastBusAt = now;
        const t = this.state.hidden ? null : this.state.current;
        if (!t) { if (playerBus.nowPlaying()?.kind === "audio") playerBus.setNowPlaying(null); return; }
        // Never overwrite a video/live player that is publishing right now.
        const cur = playerBus.nowPlaying();
        if (cur && cur.kind !== "audio") return;
        playerBus.setNowPlaying({
            kind: "audio",
            playing: this.state.playing,
            positionSec: this.progress.position,
            durationSec: this.progress.duration || t.durationSec || undefined,
            media: { kind: "track", fileId: t.id, title: t.title, durationSec: t.durationSec },
            title: t.title,
            subtitle: [t.artist, t.album].filter(Boolean).join(" · ") || undefined,
            artUrl: this.music?.coverUrl(t, 200) ?? null,
            updatedAt: now,
        });
    }

    // ─── Media Session ───────────────────────────────────────────────────

    private installMediaSession(): void {
        if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
        const ms = navigator.mediaSession;
        const on = (action: MediaSessionAction, fn: MediaSessionActionHandler) => { try { ms.setActionHandler(action, fn); } catch { /* unsupported */ } };
        on("play", () => this.resume());
        on("pause", () => this.pause());
        on("stop", () => this.stop());
        on("previoustrack", () => this.prev());
        on("nexttrack", () => this.next());
        on("seekbackward", (d) => this.seekBy(-(d.seekOffset ?? 10)));
        on("seekforward", (d) => this.seekBy(d.seekOffset ?? 10));
        on("seekto", (d) => { if (typeof d.seekTime === "number") this.seek(d.seekTime); });
    }

    private updateMediaSession(trackChanged: boolean): void {
        if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
        const ms = navigator.mediaSession;
        const t = this.state.hidden ? null : this.state.current;
        if (!t) { ms.metadata = null; ms.playbackState = "none"; return; }
        ms.playbackState = this.state.playing ? "playing" : "paused";
        if (!trackChanged && ms.metadata) return;
        if (typeof MediaMetadata === "undefined") return;
        const artwork = [96, 256, 512]
            .map((size) => ({ src: this.music?.coverUrl(t, size) ?? "", sizes: `${size}x${size}` }))
            .filter((a) => a.src);
        ms.metadata = new MediaMetadata({ title: t.title, artist: t.artist ?? "", album: t.album ?? "", artwork });
        this.updatePositionState(true);
    }

    private updatePositionState(force: boolean): void {
        if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
        const now = Date.now();
        if (!force && now - this.lastPositionStateAt < 5000) return;
        this.lastPositionStateAt = now;
        const { position, duration } = this.progress;
        if (!(duration > 0) || position > duration) return;
        try { navigator.mediaSession.setPositionState({ duration, position, playbackRate: 1 }); } catch { /* invalid state */ }
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
        if (cur && !this.playLogged && this.listened >= playThresholdSec(dur)) {
            this.playLogged = true;
            void this.media?.recordPlay({ trackKey: trackKeyOf(cur.id), durationSec: Math.round(this.listened) })?.catch(() => undefined);
        }
        if (this.state.playing && Date.now() - this.lastSaveAt > SAVE_POSITION_EVERY_MS) this.scheduleSave();
    }

    private onBus(cmd: PlayerCommand): boolean {
        if (!this.state.current || this.state.hidden) return false;
        switch (cmd.type) {
            case "pause": this.pause(); break;
            case "resume": this.resume(); break;
            case "toggle": this.toggle(); break;
            case "seek": this.seek(cmd.positionSec); break;
            case "seekBy": this.seekBy(cmd.deltaSec); break;
            case "stop": this.stop(); break;
            case "next": this.next(); break;
            case "previous": this.prev(); break;
            case "volume": this.setVolume(cmd.level > 1 ? cmd.level / 100 : cmd.level); break;
            case "rate": break;
        }
        return true;
    }

    // ─── transport ───────────────────────────────────────────────────────

    /** Loads the next track into the standby element so `next` can swap it in without a network round-trip. */
    private preloadNext(): void {
        const { queue, index, repeat } = this.state;
        const n = nextIndex(index, queue.length, repeat === "one" ? "off" : repeat, false);
        const t = n === null ? null : queue[n];
        if (!t || !this.music || t.id === this.state.current?.id || this.standbyId === t.id) return;
        if (!this.standby) this.standby = this.makeAudio();
        this.standby.src = this.srcOf(t);
        this.standby.load();
        this.standbyId = t.id;
    }

    private load(index: number, autoplay: boolean, startAt = 0): void {
        const t = this.state.queue[index];
        if (!t || !this.music) return;
        let a = this.el();
        if (this.standby && this.standbyId === t.id && startAt === 0) {
            // Swap: the preloaded element becomes active, the old one turns into the standby.
            a.pause();
            const old = a;
            a = this.standby;
            this.audio = a;
            this.standby = old;
            this.standbyId = null;
            old.removeAttribute("src");
            old.load();
            a.currentTime = 0;
        } else {
            a.src = this.srcOf(t);
        }
        this.listened = 0;
        this.lastTime = startAt;
        this.playLogged = false;
        this.pendingStart = startAt;
        this.loadedId = t.id;
        this.set({ index, error: null, buffering: autoplay, hidden: false });
        this.progress = { position: startAt, duration: t.durationSec || 0 };
        this.progressChanges.emit(this.progress);
        if (autoplay) a.play().catch(() => this.set({ playing: false, buffering: false }));
        this.scheduleSave();
    }

    play(tracks: TrackCard[], index = 0, opts: { shuffle?: boolean } = {}): void {
        if (tracks.length === 0) return;
        const list = tracks.slice(0, MAX_QUEUE);
        this.original = list.slice();
        const shuffle = opts.shuffle ?? false;
        let start = Math.max(0, Math.min(index, list.length - 1));
        let queue = list;
        if (shuffle) {
            queue = shuffleKeepFirst(list, opts.shuffle && index === 0 ? Math.floor(Math.random() * list.length) : start);
            start = 0;
        }
        this.standbyId = null;
        this.set({ queue, shuffle, restoring: false });
        this.load(start, true);
    }

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
        const n = nextIndex(index, queue.length, repeat, auto);
        if (n === null) {
            if (auto) { this.audio?.pause(); this.seek(0); }
            return;
        }
        if (n === index && auto) { this.seek(0); this.audio?.play().catch(() => undefined); return; }
        this.load(n, true);
    }

    prev(): void {
        const p = prevIndex(this.state.index, this.state.queue.length, this.state.repeat, this.audio?.currentTime ?? this.progress.position);
        if (p === "restart") this.seek(0);
        else this.load(p, true);
    }

    seek(sec: number): void {
        const a = this.audio;
        if (!a || this.loadedId !== this.state.current?.id) { this.pendingStart = Math.max(0, sec); this.setProgress(); return; }
        const d = Number.isFinite(a.duration) ? a.duration : Infinity;
        a.currentTime = Math.max(0, Math.min(d - 0.5, sec));
        this.lastTime = a.currentTime;
        this.setProgress();
        this.updatePositionState(true);
    }

    seekBy(delta: number): void { this.seek((this.audio?.currentTime ?? this.progress.position) + delta); }

    skipTo(i: number): void {
        if (i < 0 || i >= this.state.queue.length) return;
        this.load(i, true);
    }

    enqueue(tracks: TrackCard[], where: "next" | "end" = "end"): void {
        if (tracks.length === 0) return;
        const { queue, index } = this.state;
        if (queue.length === 0) { this.play(tracks, 0); return; }
        const add = tracks.slice(0, Math.max(0, MAX_QUEUE - queue.length));
        const q = where === "next" ? [...queue.slice(0, index + 1), ...add, ...queue.slice(index + 1)] : [...queue, ...add];
        this.original = [...this.original, ...add];
        this.standbyId = null;
        this.set({ queue: q });
        this.preloadNext();
        this.scheduleSave();
    }

    moveInQueue(from: number, to: number): void {
        const { queue, index } = this.state;
        if (from < 0 || from >= queue.length || to < 0 || to >= queue.length || from === to) return;
        this.standbyId = null;
        this.set({ queue: moveItem(queue, from, to), index: indexAfterMove(index, from, to) });
        if (!this.state.shuffle) this.original = this.state.queue.slice();
        this.preloadNext();
        this.scheduleSave();
    }

    removeFromQueue(i: number): void {
        const { queue, index } = this.state;
        if (i < 0 || i >= queue.length) return;
        const removed = queue[i];
        if (i === index) {
            if (queue.length === 1) { this.stop(); this.original = []; this.set({ queue: [], index: -1 }); this.scheduleSave(); return; }
            const q = queue.filter((_, k) => k !== i);
            const n = Math.min(i, q.length - 1);
            const wasPlaying = this.state.playing;
            this.standbyId = null;
            this.set({ queue: q, index: n });
            this.load(n, wasPlaying);
        } else {
            this.standbyId = null;
            this.set({ queue: queue.filter((_, k) => k !== i), index: indexAfterRemove(index, i) });
            this.preloadNext();
        }
        if (removed) this.original = this.original.filter((t) => t !== removed);
        this.scheduleSave();
    }

    setShuffle(on: boolean): void {
        const { queue, index, current } = this.state;
        if (on === this.state.shuffle) return;
        this.standbyId = null;
        if (!current) { this.set({ shuffle: on }); return; }
        if (on) {
            this.original = queue.slice();
            this.set({ queue: shuffleKeepFirst(queue, index), index: 0, shuffle: true });
        } else {
            const base = this.original.length > 0 ? this.original : queue;
            const i = base.findIndex((t) => t.id === current.id);
            this.set({ queue: base.slice(), index: i >= 0 ? i : 0, shuffle: false });
        }
        this.preloadNext();
        this.scheduleSave();
    }

    cycleRepeat(): void {
        this.set({ repeat: nextRepeat(this.state.repeat) });
        this.scheduleSave();
    }

    setVolume(v: number): void {
        const volume = Math.max(0, Math.min(1, Number.isFinite(v) ? v : 1));
        this.applyVolume({ volume, muted: volume === 0 ? this.vol.muted : false });
    }

    setMuted(muted: boolean): void { this.applyVolume({ ...this.vol, muted }); }

    private applyVolume(v: WebMusicVolume): void {
        this.vol = v;
        for (const a of [this.audio, this.standby]) if (a) { a.volume = v.volume; a.muted = v.muted; }
        try { localStorage.setItem(VOLUME_KEY, JSON.stringify(v)); } catch { /* private mode */ }
        this.volumeChanges.emit(v);
    }

    /** Stops and unloads the source (queue kept; the mini-player disappears). */
    stop(): void {
        for (const a of [this.audio, this.standby]) {
            if (!a) continue;
            a.pause();
            a.removeAttribute("src");
            a.load();
        }
        this.pendingStart = 0;
        this.standbyId = null;
        this.loadedId = null;
        this.scheduleSave();
        this.set({ playing: false, buffering: false, hidden: true });
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
                trackIds: ids, index: ids.length ? idx : 0, positionSec: Math.floor(this.audio?.currentTime || this.progress.position),
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
            const tracks = await resolveTracks(m, q.trackIds.slice(from, q.index + 100));
            if (this.music !== m || this.state.current || tracks.length === 0) return;
            const curId = q.trackIds[q.index];
            const index = Math.max(0, tracks.findIndex((t) => t.id === curId));
            this.original = tracks.slice();
            this.pendingStart = q.positionSec;
            this.progress = { position: q.positionSec, duration: tracks[index]?.durationSec ?? 0 };
            this.set({ queue: tracks, index, shuffle: q.shuffle, repeat: q.repeat, playing: false, hidden: false });
            this.progressChanges.emit(this.progress);
        } catch { /* no queue */ } finally {
            this.set({ restoring: false });
        }
    }
}

/** Subsonic `getSong` per id (4 in parallel) → TrackCard (`streamUrl` signs any path it is given). */
async function resolveTracks(m: MusicClient, ids: string[]): Promise<TrackCard[]> {
    const out: Array<TrackCard | null> = new Array<TrackCard | null>(ids.length).fill(null);
    let i = 0;
    const worker = async () => {
        while (i < ids.length) {
            const k = i++;
            const id = ids[k] as string;
            try {
                const r = await fetch(m.streamUrl({ id, streamUrlPath: `/rest/getSong.view?id=${encodeURIComponent(id)}` }));
                const j = (await r.json()) as { "subsonic-response"?: { song?: SubsonicSongBody } };
                const s = j["subsonic-response"]?.song;
                if (s) out[k] = songToCard(s);
            } catch { /* skip */ }
        }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    return out.filter((t): t is TrackCard => t !== null);
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

function readVolume(): WebMusicVolume {
    try {
        const raw = localStorage.getItem(VOLUME_KEY);
        const j = raw ? (JSON.parse(raw) as Partial<WebMusicVolume>) : null;
        if (j && typeof j.volume === "number") return { volume: Math.max(0, Math.min(1, j.volume)), muted: j.muted === true };
    } catch { /* ignore */ }
    return DEFAULT_VOLUME;
}

export const webMusicPlayer = new WebMusicPlayer();

export function useWebMusicState(): WebMusicState {
    return useSyncExternalStore((fn) => webMusicPlayer.subscribeState(fn), () => webMusicPlayer.getState(), () => EMPTY);
}

export function useWebMusicProgress(): WebMusicProgress {
    return useSyncExternalStore((fn) => webMusicPlayer.subscribeProgress(fn), () => webMusicPlayer.getProgress(), () => ZERO);
}

export function useWebMusicVolume(): WebMusicVolume {
    return useSyncExternalStore((fn) => webMusicPlayer.subscribeVolume(fn), () => webMusicPlayer.getVolume(), () => DEFAULT_VOLUME);
}
