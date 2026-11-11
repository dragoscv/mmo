/**
 * Web background music engine (WP16-40) — port of tv-tizen `music-player.ts` for the `/media` surface.
 * Module-level singleton on two hidden `<audio>` elements (active + standby): the standby preloads the
 * next track and is swapped in when playback advances (gapless-ish). Separate from the DJ PlayerProvider.
 *
 *   webMusicPlayer.attach(music, media, profileId)   bind clients; restores the server queue (paused) once per profile
 *   play(tracks, index, {shuffle?}) / toggle / pause / resume / next / prev / seek / seekBy / skipTo
 *   enqueue(tracks, "next"|"end") / moveInQueue(from, to) / removeFromQueue(i) / setShuffle / cycleRepeat
 *   setVolume(0..1) / setMuted / setPlayback({crossfadeSec?, automix?}) / stop
 *   useWebMusicState() / useWebMusicProgress() / useWebMusicVolume() / useWebMusicPlayback()   React hooks
 *
 * Crossfade + automix (WP17-44, same planner as Android `Crossfader` / iOS MixaiCore, `mixPlan` in music-core):
 * the standby element is the helper deck. Shortly before the fade it is seeked to the incoming track's first
 * downbeat and set to the matched tempo (±6 %, pitch kept); the fade starts on a downbeat of the outgoing track,
 * lasts whole bars (equal power), then the helper becomes the active element and its rate glides back to 1.
 * Without tempo data it is a plain time-based crossfade; album continuations, repeat-one and crossfade 0 stay
 * gapless. Pause, seek, skip and stop cancel a planned or running fade and restore volume and rate.
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
    DEFAULT_PLAYBACK, cycleRepeat as nextRepeat, fadeInGain, fadeOutGain, glideRate, indexAfterMove, indexAfterRemove, mixPlan,
    moveItem, nextIndex, normalizePlayback, playThresholdSec, prevIndex, shuffleKeepFirst, trackKeyOf,
    type MixPlan, type MusicPlayback,
} from "./music-core";
import { playerBus, type PlayerCommand } from "./player-bus";
import { mediaUrl } from "./offline/keys";
import { installDesktopBridge, toDesktopNowPlaying } from "./desktop-bridge";

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
const PLAYBACK_KEY = "mixai:music:playback";
/** Fade / glide ramp step; also the precision of a downbeat-aligned fade start. */
const MIX_TICK_MS = 25;
/** The helper deck is seeked and tempo-matched this long before the fade. */
const MIX_ARM_SEC = 8;
/** Fast polling starts this long before the fade (`timeupdate` alone fires ~4 times a second). */
const MIX_NEAR_SEC = 1.5;
/** Worker that posts a message every N ms (N = last message received, 0 = stop). Page timers drop to 1 Hz in a hidden tab. */
const TICK_WORKER_SRC = "let t=null;onmessage=function(e){if(t!==null){clearInterval(t);t=null}if(e.data>0)t=setInterval(function(){postMessage(0)},e.data)}";

/** A running crossfade: `standby` plays `trackId` while the active element fades out. */
interface ActiveMix {
    trackId: string;
    /** Queue index of the incoming track. */
    index: number;
    plan: MixPlan;
    /** Real fade length (the plan's, or what is left of the outgoing track), seconds. */
    fadeSec: number;
    startedAt: number;
}

const clock = (): number => performance.now();

/** Tempo changes keep the pitch (standard + prefixed property names). */
function keepPitch(a: HTMLAudioElement): void {
    const el = a as HTMLAudioElement & { mozPreservesPitch?: boolean; webkitPreservesPitch?: boolean };
    el.preservesPitch = true;
    el.mozPreservesPitch = true;
    el.webkitPreservesPitch = true;
}

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
    private playback: MusicPlayback = DEFAULT_PLAYBACK;
    private readonly stateChanges = new Emitter<WebMusicState>();
    private readonly progressChanges = new Emitter<WebMusicProgress>();
    private readonly volumeChanges = new Emitter<WebMusicVolume>();
    private readonly playbackChanges = new Emitter<MusicPlayback>();
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
    /** Running crossfade (the standby element is audible). */
    private mix: ActiveMix | null = null;
    /** Track id the standby element is seeked + tempo-matched for (fade planned, not started). */
    private armedId: string | null = null;
    /** A planned fade starts within `MIX_NEAR_SEC`: poll fast. */
    private near = false;
    /** Rate of the active element gliding back to 1 after a tempo-matched handoff. */
    private glide: { from: number; startedAt: number; sec: number } | null = null;
    private mixTimer: ReturnType<typeof setInterval> | null = null;
    /** Tick source that keeps its pace in a hidden tab; `undefined` = not tried, `null` = unavailable (plain timer). */
    private tickWorker: Worker | null | undefined = undefined;
    private ticking = false;
    /** Whether `audio.volume` can be set (iOS Safari ignores it → no crossfade there). */
    private canFade: boolean | null = null;
    /** Track id whose fade-in the browser refused to start (autoplay policy): that transition stays gapless. */
    private mixRefusedId: string | null = null;

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
        const playback = readPlayback();
        if (playback.crossfadeSec !== this.playback.crossfadeSec || playback.automix !== this.playback.automix) {
            this.playback = playback;
            this.playbackChanges.emit(playback);
        }
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
        // MixAI Music desktop shell: OS media controls / tray / mini player (no-op in browsers).
        installDesktopBridge(
            this,
            (fn) => { const a = this.stateChanges.on(fn); const b = this.progressChanges.on(fn); return () => { a(); b(); }; },
            () => toDesktopNowPlaying(this.state, this.progress, this.state.current ? this.music?.coverUrl(this.state.current, 512) ?? null : null),
        );
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
        keepPitch(a);
        const mine = () => a === this.audio;
        // The helper deck also drives a running fade (timers alone are throttled in a hidden window).
        a.addEventListener("timeupdate", () => { if (mine()) this.onTime(); else if (this.mix) this.mixTick(); });
        a.addEventListener("durationchange", () => { if (mine()) this.setProgress(); });
        a.addEventListener("loadedmetadata", () => {
            if (!mine()) return;
            if (this.pendingStart > 0 && Number.isFinite(a.duration) && this.pendingStart < a.duration - 2) a.currentTime = this.pendingStart;
            this.pendingStart = 0;
            this.setProgress();
        });
        a.addEventListener("playing", () => { if (mine()) { this.errorSkips = 0; this.set({ playing: true, buffering: false, error: null }); this.preloadNext(); } });
        a.addEventListener("play", () => { if (mine()) this.set({ playing: true }); });
        a.addEventListener("pause", () => {
            if (!mine()) return;
            if (this.mix) {
                // The outgoing track reached its end mid-fade ("pause" precedes "ended"): the handoff follows.
                if (a.ended) return;
                this.cancelMix();
            }
            this.set({ playing: false });
            this.scheduleSave();
        });
        a.addEventListener("waiting", () => { if (mine()) this.set({ buffering: true }); });
        a.addEventListener("ended", () => {
            if (!mine()) return;
            if (this.mix) this.completeMix(); else this.next(true);
        });
        a.addEventListener("error", () => {
            if (!mine() || !a.getAttribute("src")) return;
            // The outgoing track broke mid-fade: the incoming one is already playing, hand over to it.
            if (this.mix) { this.completeMix(); return; }
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
    getPlayback(): MusicPlayback { return this.playback; }
    subscribeState(fn: () => void): () => void { return this.stateChanges.on(fn); }
    subscribeProgress(fn: () => void): () => void { return this.progressChanges.on(fn); }
    subscribeVolume(fn: () => void): () => void { return this.volumeChanges.on(fn); }
    subscribePlayback(fn: () => void): () => void { return this.playbackChanges.on(fn); }

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
        // The real rate: it differs from 1 while a tempo-matched track glides back to native speed.
        const rate = this.audio?.playbackRate;
        try { navigator.mediaSession.setPositionState({ duration, position, playbackRate: rate && rate > 0 ? rate : 1 }); } catch { /* invalid state */ }
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
        this.mixTick();
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

    // ─── crossfade + automix ─────────────────────────────────────────────

    /** Crossfade length (0..12 s, 0 = gapless) and automix on/off; persisted on this device. */
    setPlayback(patch: Partial<MusicPlayback>): void {
        const next = normalizePlayback({ ...this.playback, ...patch });
        if (next.crossfadeSec === this.playback.crossfadeSec && next.automix === this.playback.automix) return;
        this.playback = next;
        try { localStorage.setItem(PLAYBACK_KEY, JSON.stringify(next)); } catch { /* private mode */ }
        // A running fade stops only when crossfade is switched off; a planned one is planned again with the new settings.
        if (next.crossfadeSec === 0 || !this.mix) this.cancelMix();
        this.playbackChanges.emit(next);
    }

    /** Queue index that follows the current track by itself (`null` = nothing to mix into). */
    private autoNext(): number | null {
        const { queue, index, repeat } = this.state;
        if (repeat === "one") return null;
        const n = nextIndex(index, queue.length, repeat, true);
        return n === null || n === index ? null : n;
    }

    private volumeSettable(a: HTMLAudioElement): boolean {
        if (this.canFade === null) {
            const prev = a.volume;
            a.volume = prev > 0.5 ? 0.25 : 0.75;
            this.canFade = a.volume !== prev;
            a.volume = prev;
        }
        return this.canFade;
    }

    private syncMixTimer(): void {
        const need = this.mix !== null || this.glide !== null || this.near;
        if (need === this.ticking) return;
        this.ticking = need;
        const w = this.ticker();
        if (w) w.postMessage(need ? MIX_TICK_MS : 0);
        else if (need) this.mixTimer = setInterval(() => this.mixTick(), MIX_TICK_MS);
        else if (this.mixTimer !== null) { clearInterval(this.mixTimer); this.mixTimer = null; }
    }

    private ticker(): Worker | null {
        if (this.tickWorker !== undefined) return this.tickWorker;
        this.tickWorker = null;
        try {
            if (typeof Worker === "undefined" || typeof Blob === "undefined" || typeof URL.createObjectURL !== "function") return null;
            const w = new Worker(URL.createObjectURL(new Blob([TICK_WORKER_SRC], { type: "text/javascript" })));
            w.onmessage = () => { if (this.ticking) this.mixTick(); };
            // Blocked (CSP) or crashed: continue on a page timer.
            w.onerror = () => {
                this.tickWorker = null;
                if (this.ticking && this.mixTimer === null) this.mixTimer = setInterval(() => this.mixTick(), MIX_TICK_MS);
            };
            this.tickWorker = w;
        } catch { /* no workers here: page timer */ }
        return this.tickWorker;
    }

    /** One step of the crossfade machinery; driven by `timeupdate` and, near / during a fade or glide, a fast timer. */
    private mixTick(): void {
        if (this.glide) this.stepGlide();
        if (this.mix) this.stepFade(this.mix); else this.planMix();
        this.syncMixTimer();
    }

    /** Arms the helper deck ahead of the fade and starts the fade when the outgoing track reaches the planned position. */
    private planMix(): void {
        const a = this.audio;
        const h = this.standby;
        const cur = this.state.current;
        const n = this.autoNext();
        const next = n === null ? null : this.state.queue[n];
        if (!a || !h || !cur || n === null || !next || this.playback.crossfadeSec <= 0 || !this.state.playing || a.paused
            || next.id === cur.id || this.standbyId !== next.id || this.loadedId !== cur.id || this.mixRefusedId === next.id
            || !this.volumeSettable(h)) {
            this.cancelMix();
            return;
        }
        const dur = Number.isFinite(a.duration) && a.duration > 0 ? a.duration : cur.durationSec;
        const plan = mixPlan(cur, next, this.playback.crossfadeSec, { automix: this.playback.automix, durationSec: dur });
        const until = plan.fadeStartSec - a.currentTime;
        // Not close yet, or too late for a fade worth hearing (the track then ends gapless).
        if (plan.mode === "none" || until > MIX_ARM_SEC || until <= -plan.fadeSec / 2) { this.cancelMix(); return; }
        if (this.armedId !== next.id) {
            if (h.readyState < 1) return; // no metadata yet: next tick
            h.playbackRate = plan.rate;
            if (Math.abs(h.currentTime - plan.inStartSec) > 0.01) h.currentTime = plan.inStartSec;
            this.armedId = next.id;
        }
        this.near = until <= MIX_NEAR_SEC;
        // A download or stream that did not buffer in time is never faded in: it starts gapless at the track end.
        // Half a tick early at most, so the start lands within ±half a tick of the downbeat.
        if (until > MIX_TICK_MS / 2000 || h.readyState < 3) return;
        const m: ActiveMix = { trackId: next.id, index: n, plan, fadeSec: Math.max(0.05, Math.min(plan.fadeSec, dur - a.currentTime)), startedAt: clock() };
        h.playbackRate = plan.rate;
        h.muted = this.vol.muted;
        h.volume = 0;
        this.mix = m;
        this.near = false;
        h.play().catch(() => { if (this.mix === m) { this.mixRefusedId = m.trackId; this.cancelMix(); } });
    }

    /** Equal-power ramp; hands over to the incoming track when the fade is complete. */
    private stepFade(m: ActiveMix): void {
        const a = this.audio;
        const h = this.standby;
        if (!a || !h) { this.cancelMix(); return; }
        // The incoming track failed to load mid-fade: back to the outgoing one; the normal skip logic handles the rest.
        if (h.error) { this.cancelMix(); this.standbyId = null; return; }
        const t = (clock() - m.startedAt) / 1000 / m.fadeSec;
        if (t >= 1) { this.completeMix(); return; }
        a.volume = this.vol.volume * fadeOutGain(t);
        h.volume = this.vol.volume * fadeInGain(t);
    }

    /** Handoff: the helper deck becomes the active element (no seek, no gap); a matched tempo glides back to 1. */
    private completeMix(): void {
        const m = this.mix;
        const old = this.audio;
        const a = this.standby;
        const t = m ? this.state.queue[m.index] : undefined;
        if (!m || !old || !a || !t || t.id !== m.trackId) { this.cancelMix(); return; }
        this.mix = null;
        this.armedId = null;
        this.near = false;
        this.audio = a;
        this.standby = old;
        this.standbyId = null;
        old.pause();
        old.removeAttribute("src");
        old.load();
        old.playbackRate = 1;
        old.volume = this.vol.volume;
        a.volume = this.vol.volume;
        this.listened = 0;
        this.lastTime = a.currentTime;
        this.playLogged = false;
        this.pendingStart = 0;
        this.loadedId = t.id;
        this.errorSkips = 0;
        this.glide = m.plan.glideSec > 0 && a.playbackRate !== 1 ? { from: a.playbackRate, startedAt: clock(), sec: m.plan.glideSec } : null;
        if (!this.glide) a.playbackRate = 1;
        if (a.paused) a.play().catch(() => this.set({ playing: false, buffering: false }));
        // Progress of the new track first: the state change below publishes it (hub, Media Session, desktop shell).
        this.progress = { position: a.currentTime, duration: Number.isFinite(a.duration) && a.duration > 0 ? a.duration : t.durationSec || 0 };
        this.set({ index: m.index, error: null, buffering: a.readyState < 3, hidden: false, playing: true });
        this.progressChanges.emit(this.progress);
        this.updatePositionState(true);
        this.preloadNext();
        this.scheduleSave();
        this.syncMixTimer();
    }

    /** Drops a planned or running fade: helper silent and back at native speed, the active element at full volume. */
    private cancelMix(): void {
        const m = this.mix;
        this.near = false;
        if (!m && this.armedId === null) return;
        this.mix = null;
        this.armedId = null;
        const h = this.standby;
        if (h) {
            if (m) h.pause();
            h.playbackRate = 1;
            if (h.readyState >= 1) h.currentTime = 0;
        }
        for (const a of [this.audio, h]) if (a) a.volume = this.vol.volume;
        this.syncMixTimer();
    }

    private stepGlide(): void {
        const g = this.glide;
        const a = this.audio;
        if (!g || !a) { this.glide = null; return; }
        const r = glideRate(g.from, (clock() - g.startedAt) / 1000, g.sec);
        if (r === 1) { this.endGlide(); return; }
        // Small steps only (a new rate re-syncs the browser's time stretcher).
        if (Math.abs(r - a.playbackRate) >= 0.001) a.playbackRate = r;
        if (Date.now() - this.lastPositionStateAt >= 1000) this.updatePositionState(true);
    }

    private endGlide(): void {
        if (!this.glide) return;
        this.glide = null;
        if (this.audio) this.audio.playbackRate = 1;
        this.updatePositionState(true);
        this.syncMixTimer();
    }

    /** After a queue / repeat change: keep a running fade and the preloaded track when the next track is still the same. */
    private afterQueueEdit(): void {
        const m = this.mix;
        const n = this.autoNext();
        if (m) {
            if (n !== null && this.state.queue[n]?.id === m.trackId) { m.index = n; return; }
            this.cancelMix();
        }
        const { queue, index, repeat } = this.state;
        const p = nextIndex(index, queue.length, repeat === "one" ? "off" : repeat, false);
        if (p !== null && this.standbyId !== null && queue[p]?.id === this.standbyId) return;
        this.cancelMix();
        this.standbyId = null;
        this.preloadNext();
    }

    // ─── transport ───────────────────────────────────────────────────────

    /** Loads the next track into the standby element so `next` can swap it in without a network round-trip. */
    private preloadNext(): void {
        if (this.mix) return;
        const { queue, index, repeat } = this.state;
        const n = nextIndex(index, queue.length, repeat === "one" ? "off" : repeat, false);
        const t = n === null ? null : queue[n];
        if (!t || !this.music || t.id === this.state.current?.id || this.standbyId === t.id) return;
        if (!this.standby) this.standby = this.makeAudio();
        this.armedId = null;
        this.near = false;
        this.standby.playbackRate = 1;
        this.standby.volume = this.vol.volume;
        this.standby.src = this.srcOf(t);
        this.standby.load();
        this.standbyId = t.id;
    }

    private load(index: number, autoplay: boolean, startAt = 0): void {
        const t = this.state.queue[index];
        if (!t || !this.music) return;
        this.cancelMix();
        this.endGlide();
        this.mixRefusedId = null;
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
        if (a.playbackRate !== 1) a.playbackRate = 1;
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

    pause(): void {
        this.cancelMix();
        this.audio?.pause();
    }

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
        this.cancelMix();
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
        this.set({ queue: q });
        this.afterQueueEdit();
        this.scheduleSave();
    }

    moveInQueue(from: number, to: number): void {
        const { queue, index } = this.state;
        if (from < 0 || from >= queue.length || to < 0 || to >= queue.length || from === to) return;
        this.set({ queue: moveItem(queue, from, to), index: indexAfterMove(index, from, to) });
        if (!this.state.shuffle) this.original = this.state.queue.slice();
        this.afterQueueEdit();
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
            this.set({ queue: queue.filter((_, k) => k !== i), index: indexAfterRemove(index, i) });
            this.afterQueueEdit();
        }
        if (removed) this.original = this.original.filter((t) => t !== removed);
        this.scheduleSave();
    }

    setShuffle(on: boolean): void {
        const { queue, index, current } = this.state;
        if (on === this.state.shuffle) return;
        if (!current) { this.standbyId = null; this.set({ shuffle: on }); return; }
        if (on) {
            this.original = queue.slice();
            this.set({ queue: shuffleKeepFirst(queue, index), index: 0, shuffle: true });
        } else {
            const base = this.original.length > 0 ? this.original : queue;
            const i = base.findIndex((t) => t.id === current.id);
            this.set({ queue: base.slice(), index: i >= 0 ? i : 0, shuffle: false });
        }
        this.afterQueueEdit();
        this.scheduleSave();
    }

    cycleRepeat(): void {
        this.set({ repeat: nextRepeat(this.state.repeat) });
        // Repeat-one never crossfades; repeat-all changes what follows the last track.
        this.afterQueueEdit();
        this.scheduleSave();
    }

    setVolume(v: number): void {
        const volume = Math.max(0, Math.min(1, Number.isFinite(v) ? v : 1));
        this.applyVolume({ volume, muted: volume === 0 ? this.vol.muted : false });
    }

    setMuted(muted: boolean): void { this.applyVolume({ ...this.vol, muted }); }

    private applyVolume(v: WebMusicVolume): void {
        this.vol = v;
        for (const a of [this.audio, this.standby]) if (a) { a.muted = v.muted; if (!this.mix) a.volume = v.volume; }
        // Mid-fade the two elements keep their share of the new level.
        if (this.mix) this.stepFade(this.mix);
        try { localStorage.setItem(VOLUME_KEY, JSON.stringify(v)); } catch { /* private mode */ }
        this.volumeChanges.emit(v);
    }

    /** Stops and unloads the source (queue kept; the mini-player disappears). */
    stop(): void {
        this.cancelMix();
        this.endGlide();
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
            const tracks = await loadCards(m, q.trackIds.slice(from, q.index + 100));
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

/** Full cards (with the tempo data automix needs) from `/media/music/tracks?ids=` (server 3.12+), else Subsonic `getSong`. */
async function loadCards(m: MusicClient, ids: string[]): Promise<TrackCard[]> {
    try {
        const full = await m.tracksByIds(ids);
        // A server older than 3.12 ignores `ids` and answers the first A–Z page: only trust an answer made of the asked ids.
        const asked = new Set(ids);
        if (full.length > 0 && full.every((t) => asked.has(t.id))) return full;
    } catch { /* older server: per-id fallback below */ }
    return resolveTracks(m, ids);
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

function readPlayback(): MusicPlayback {
    try {
        const raw = localStorage.getItem(PLAYBACK_KEY);
        if (raw) return normalizePlayback(JSON.parse(raw));
    } catch { /* ignore */ }
    return DEFAULT_PLAYBACK;
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

export function useWebMusicPlayback(): MusicPlayback {
    return useSyncExternalStore((fn) => webMusicPlayer.subscribePlayback(fn), () => webMusicPlayer.getPlayback(), () => DEFAULT_PLAYBACK);
}
