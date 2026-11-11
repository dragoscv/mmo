/**
 * Crossfade + automix of the web music engine (`web-music-player.ts`) on fake `<audio>` elements: the helper deck
 * is tempo-matched and seeked before the fade, the fade starts at the planned position with equal-power volumes,
 * the handoff swaps the elements and glides the rate back to 1, and pause / skip / settings cancel it cleanly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrackCard } from "./media-types";
import type { MusicClient } from "./music";

type Listener = () => void;

class FakeAudio {
    currentTime = 0;
    duration = Number.NaN;
    paused = true;
    ended = false;
    volume = 1;
    muted = false;
    playbackRate = 1;
    preservesPitch = false;
    readyState = 0;
    preload = "";
    hidden = false;
    error: { code: number } | null = null;
    plays = 0;
    private readonly attrs = new Map<string, string>();
    private readonly listeners = new Map<string, Listener[]>();

    get src(): string { return this.attrs.get("src") ?? ""; }
    set src(v: string) { this.attrs.set("src", v); this.readyState = 0; this.currentTime = 0; this.ended = false; }
    setAttribute(k: string, v: string): void { this.attrs.set(k, v); }
    getAttribute(k: string): string | null { return this.attrs.get(k) ?? null; }
    removeAttribute(k: string): void { this.attrs.delete(k); }
    addEventListener(type: string, fn: Listener): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
    fire(type: string): void { for (const fn of this.listeners.get(type) ?? []) fn(); }
    load(): void { if (!this.attrs.has("src")) { this.readyState = 0; this.paused = true; } }
    play(): Promise<void> { this.plays++; this.paused = false; this.ended = false; this.fire("play"); return Promise.resolve(); }
    pause(): void { if (this.paused) return; this.paused = true; this.fire("pause"); }
    /** Metadata + enough data to play. */
    ready(duration: number): void { this.duration = duration; this.readyState = 4; this.fire("loadedmetadata"); }
    /** Playback reached `sec`. */
    at(sec: number): void { this.currentTime = sec; this.fire("timeupdate"); }
    finish(): void { this.currentTime = this.duration; this.paused = true; this.ended = true; this.fire("pause"); this.fire("ended"); }
}

function card(id: string, o: Partial<TrackCard> = {}): TrackCard {
    return {
        id, title: id, albumId: `al_${id}`, durationSec: 200, format: "flac", hasLyrics: false, hasSyncedLyrics: false,
        coverArt: id, coverUrlPath: "", streamUrlPath: `/rest/stream.view?id=${id}`, ...o,
    };
}

const A = card("tr_1", { bpm: 120, firstBeatSec: 0.5 });
const B = card("tr_2", { bpm: 122, firstBeatSec: 0.48, durationSec: 180 });
const C = card("tr_3", { bpm: 121, firstBeatSec: 0.2 });
const RATE = 120 / 122;

let created: FakeAudio[] = [];
let positionStates: Array<{ duration: number; position: number; playbackRate: number }> = [];
let stored: Map<string, string>;

async function boot(playback?: { crossfadeSec?: number; automix?: boolean }) {
    const { webMusicPlayer: p } = await import("./web-music-player");
    const music = {
        streamUrl: (t: { id: string }) => `https://srv.test/stream/${t.id}`,
        coverUrl: () => null,
        queue: async () => null,
        setQueue: async () => null,
        tracksByIds: async () => [],
    } as unknown as MusicClient;
    p.attach(music, null, "p1");
    if (playback) p.setPlayback(playback);
    return p;
}

/** Plays `tracks`, returns the active element (playing, 200 s) and the preloaded helper (buffered). */
function start(p: Awaited<ReturnType<typeof boot>>, tracks: TrackCard[]) {
    p.play(tracks, 0);
    const out = created[0] as FakeAudio;
    out.ready(200);
    out.fire("playing");
    const helper = created[1] as FakeAudio;
    helper.ready(tracks[1]?.durationSec ?? 200);
    return { out, helper };
}

beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
    created = [];
    positionStates = [];
    stored = new Map();
    const doc = {
        createElement: () => { const a = new FakeAudio(); created.push(a); return a; },
        body: { appendChild: () => undefined },
        addEventListener: () => undefined,
    };
    vi.stubGlobal("document", doc);
    vi.stubGlobal("window", { document: doc });
    vi.stubGlobal("HTMLVideoElement", class {});
    // No worker tick source here: the engine falls back to the (fake) page timer.
    vi.stubGlobal("Worker", undefined);
    vi.stubGlobal("localStorage", {
        getItem: (k: string) => stored.get(k) ?? null,
        setItem: (k: string, v: string) => { stored.set(k, v); },
        removeItem: (k: string) => { stored.delete(k); },
    });
    vi.stubGlobal("navigator", {
        mediaSession: {
            metadata: null, playbackState: "none", setActionHandler: () => undefined,
            setPositionState: (s: { duration: number; position: number; playbackRate: number }) => { positionStates.push(s); },
        },
    });
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe("web music engine: crossfade + automix", () => {
    it("defaults to no crossfade with automix on (as on Android and iOS) and persists changes", async () => {
        const p = await boot();
        expect(p.getPlayback()).toEqual({ crossfadeSec: 0, automix: true });
        p.setPlayback({ crossfadeSec: 30 });
        expect(p.getPlayback()).toEqual({ crossfadeSec: 12, automix: true });
        p.setPlayback({ automix: false });
        expect(JSON.parse(stored.get("mixai:music:playback") ?? "null")).toEqual({ crossfadeSec: 12, automix: false });
    });

    it("reads the stored settings on the first attach", async () => {
        stored.set("mixai:music:playback", JSON.stringify({ crossfadeSec: 3, automix: false }));
        const p = await boot();
        expect(p.getPlayback()).toEqual({ crossfadeSec: 3, automix: false });
    });

    it("beat-matched: arms the helper deck, fades on the downbeat, hands over and glides the rate back to 1", async () => {
        const p = await boot({ crossfadeSec: 8 });
        const { out, helper } = start(p, [A, B, C]);
        expect(helper.src).toBe("https://srv.test/stream/tr_2");
        expect(helper.preservesPitch).toBe(true);

        // Far from the fade (downbeat 190.5 s): nothing is touched.
        out.at(150);
        expect([helper.playbackRate, helper.currentTime, helper.plays]).toEqual([1, 0, 0]);

        // Within 8 s: matched tempo + first downbeat of the incoming track, still silent and paused.
        out.at(185);
        expect(helper.playbackRate).toBeCloseTo(RATE, 9);
        expect(helper.currentTime).toBe(0.48);
        expect(helper.plays).toBe(0);
        out.at(190.3);
        expect(helper.plays).toBe(0);

        // The outgoing downbeat: the helper starts at volume 0.
        out.at(190.5);
        expect(helper.plays).toBe(1);
        expect([helper.volume, out.volume]).toEqual([0, 1]);
        expect(p.getState().current?.id).toBe("tr_1");

        // Half of the 8 s fade: equal power on both decks.
        vi.advanceTimersByTime(4000);
        expect(helper.volume).toBeCloseTo(Math.SQRT1_2, 2);
        expect(out.volume).toBeCloseTo(Math.SQRT1_2, 2);
        expect(p.getState().current?.id).toBe("tr_1");

        // Fade complete (before the outgoing track ends): the helper is the active element.
        helper.currentTime = 0.48 + 8 * RATE;
        vi.advanceTimersByTime(4100);
        expect(p.getState().current?.id).toBe("tr_2");
        expect(p.getState().index).toBe(1);
        expect(p.getState().playing).toBe(true);
        expect(helper.volume).toBe(1);
        expect(helper.paused).toBe(false);
        expect(out.paused).toBe(true);
        // The old deck is silent and already preloads the track after that one.
        expect(out.src).toBe("https://srv.test/stream/tr_3");
        expect(out.plays).toBe(1);
        expect([out.volume, out.playbackRate]).toEqual([1, 1]);
        expect(p.getProgress().position).toBeCloseTo(0.48 + 8 * RATE, 6);
        // The OS position state follows the real rate.
        expect(positionStates.at(-1)?.playbackRate).toBeGreaterThan(RATE - 0.001);
        expect(positionStates.at(-1)?.playbackRate).toBeLessThan(0.99);

        // Glide: half way back after 4 s, native speed after 8 s.
        vi.advanceTimersByTime(3900);
        expect(helper.playbackRate).toBeGreaterThan(RATE + 0.007);
        expect(helper.playbackRate).toBeLessThan(RATE + 0.0095);
        vi.advanceTimersByTime(4200);
        expect(helper.playbackRate).toBe(1);
        expect(positionStates.at(-1)?.playbackRate).toBe(1);
    });

    it("keeps the user volume through the fade", async () => {
        const p = await boot({ crossfadeSec: 8 });
        p.setVolume(0.5);
        const { out, helper } = start(p, [A, B]);
        out.at(185);
        out.at(190.5);
        vi.advanceTimersByTime(4000);
        expect(helper.volume).toBeCloseTo(0.5 * Math.SQRT1_2, 2);
        p.setVolume(0.8);
        expect(out.volume).toBeCloseTo(0.8 * Math.SQRT1_2, 2);
        vi.advanceTimersByTime(4100);
        expect([helper.volume, out.volume]).toEqual([0.8, 0.8]);
    });

    it("a manual next during the fade cancels it: full volume, native rate, track from its start", async () => {
        const p = await boot({ crossfadeSec: 8 });
        const { out, helper } = start(p, [A, B, C]);
        out.at(185);
        out.at(190.5);
        vi.advanceTimersByTime(3000);
        expect(helper.volume).toBeGreaterThan(0.4);
        helper.currentTime = 3.4;

        p.next();
        expect(p.getState().current?.id).toBe("tr_2");
        expect([helper.volume, helper.playbackRate, helper.currentTime, helper.paused]).toEqual([1, 1, 0, false]);
        expect(out.paused).toBe(true);
        expect(out.volume).toBe(1);
        // No late handoff or ramp from the cancelled fade.
        vi.advanceTimersByTime(9000);
        expect(p.getState().index).toBe(1);
        expect([helper.volume, helper.playbackRate]).toEqual([1, 1]);
    });

    it("skipping to another track during the fade silences the helper deck", async () => {
        const p = await boot({ crossfadeSec: 8 });
        const { out, helper } = start(p, [A, B, C]);
        out.at(185);
        out.at(190.5);
        vi.advanceTimersByTime(3000);
        expect(helper.paused).toBe(false);

        p.skipTo(2);
        expect(p.getState().current?.id).toBe("tr_3");
        expect(out.src).toBe("https://srv.test/stream/tr_3");
        expect([out.volume, out.playbackRate]).toEqual([1, 1]);
        expect([helper.paused, helper.playbackRate, helper.volume]).toEqual([true, 1, 1]);
        vi.advanceTimersByTime(9000);
        expect(p.getState().index).toBe(2);
    });

    it("pause during the fade cancels it and keeps the outgoing track", async () => {
        const p = await boot({ crossfadeSec: 8 });
        const { out, helper } = start(p, [A, B]);
        out.at(185);
        out.at(190.5);
        vi.advanceTimersByTime(2000);

        p.pause();
        expect(p.getState().playing).toBe(false);
        expect(p.getState().current?.id).toBe("tr_1");
        expect([helper.paused, helper.volume, helper.playbackRate, helper.currentTime]).toEqual([true, 1, 1, 0]);
        expect(out.volume).toBe(1);
        vi.advanceTimersByTime(9000);
        expect(p.getState().current?.id).toBe("tr_1");
    });

    it("a seek back before the fade point disarms the helper deck", async () => {
        const p = await boot({ crossfadeSec: 8 });
        const { out, helper } = start(p, [A, B]);
        out.at(185);
        expect(helper.playbackRate).toBeCloseTo(RATE, 9);
        p.seek(60);
        expect([helper.playbackRate, helper.currentTime, helper.plays]).toEqual([1, 0, 0]);
        expect(out.currentTime).toBe(60);
    });

    it("plain crossfade without tempo data: native rate, from the start, last 6 s", async () => {
        const p = await boot({ crossfadeSec: 6 });
        const { out, helper } = start(p, [card("tr_8"), card("tr_9")]);
        out.at(193.9);
        expect(helper.plays).toBe(0);
        out.at(194);
        expect(helper.plays).toBe(1);
        expect([helper.playbackRate, helper.currentTime, helper.volume]).toEqual([1, 0, 0]);
        vi.advanceTimersByTime(3000);
        expect(helper.volume).toBeCloseTo(Math.SQRT1_2, 2);
        // The outgoing track ends: handoff without a glide.
        out.finish();
        expect(p.getState().current?.id).toBe("tr_9");
        expect([helper.volume, helper.playbackRate, helper.paused]).toEqual([1, 1, false]);
    });

    it("automix off: tracks with tempo data get the plain crossfade", async () => {
        const p = await boot({ crossfadeSec: 8, automix: false });
        const { out, helper } = start(p, [A, B]);
        out.at(190.5);
        expect(helper.plays).toBe(0);
        out.at(192);
        expect(helper.plays).toBe(1);
        expect([helper.playbackRate, helper.currentTime]).toEqual([1, 0]);
    });

    it("crossfade 0: no overlap, the next track starts when the current one ends", async () => {
        const p = await boot({ crossfadeSec: 0 });
        const { out, helper } = start(p, [A, B]);
        out.at(185);
        out.at(199.5);
        expect([helper.plays, helper.playbackRate, helper.currentTime, helper.volume]).toEqual([0, 1, 0, 1]);
        out.finish();
        expect(p.getState().current?.id).toBe("tr_2");
        expect(helper.plays).toBe(1);
        expect([helper.volume, helper.playbackRate]).toEqual([1, 1]);
    });

    it("turning crossfade off mid-fade restores the outgoing track", async () => {
        const p = await boot({ crossfadeSec: 8 });
        const { out, helper } = start(p, [A, B]);
        out.at(185);
        out.at(190.5);
        vi.advanceTimersByTime(2000);
        p.setPlayback({ crossfadeSec: 0 });
        expect([helper.paused, helper.playbackRate, out.volume]).toEqual([true, 1, 1]);
        expect(p.getState().current?.id).toBe("tr_1");
    });

    it("repeat one never crossfades", async () => {
        const p = await boot({ crossfadeSec: 8 });
        const { out, helper } = start(p, [A, B]);
        p.cycleRepeat();
        p.cycleRepeat();
        expect(p.getState().repeat).toBe("one");
        out.at(185);
        out.at(191);
        expect([helper.plays, helper.playbackRate]).toEqual([0, 1]);
    });

    it("an album played in order stays gapless", async () => {
        const p = await boot({ crossfadeSec: 8 });
        const t1 = card("tr_21", { albumId: "al_9", track: 1, bpm: 120, firstBeatSec: 0.5 });
        const t2 = card("tr_22", { albumId: "al_9", track: 2, bpm: 120, firstBeatSec: 0.5 });
        const { out, helper } = start(p, [t1, t2]);
        out.at(185);
        out.at(193);
        expect([helper.plays, helper.playbackRate, helper.currentTime]).toEqual([0, 1, 0]);
    });

    it("a next track that has not buffered is not faded in", async () => {
        const p = await boot({ crossfadeSec: 8 });
        p.play([A, B], 0);
        const out = created[0] as FakeAudio;
        out.ready(200);
        out.fire("playing");
        const helper = created[1] as FakeAudio;
        out.at(185);
        out.at(191);
        expect([helper.plays, helper.playbackRate]).toEqual([0, 1]);
        out.finish();
        expect(p.getState().current?.id).toBe("tr_2");
    });

    it("ticks from a worker when there is one (page timers stall in a hidden tab) and stops it afterwards", async () => {
        const posted: number[] = [];
        const workers: Array<{ onmessage: (() => void) | null }> = [];
        vi.stubGlobal("Worker", class {
            onmessage: (() => void) | null = null;
            onerror: (() => void) | null = null;
            constructor() { workers.push(this); }
            postMessage(ms: number): void { posted.push(ms); }
        });
        const tick = () => workers[0]?.onmessage?.();
        const p = await boot({ crossfadeSec: 8 });
        const { out, helper } = start(p, [A, B]);
        out.at(185);
        expect(posted).toEqual([]);
        // Within 1.5 s of the downbeat: fast ticks start.
        out.at(189.5);
        expect(posted).toEqual([25]);
        out.currentTime = 190.5;
        tick();
        expect(helper.plays).toBe(1);
        // The page timer is not used: only worker messages move the fade.
        vi.advanceTimersByTime(4000);
        expect(helper.volume).toBe(0);
        tick();
        expect(helper.volume).toBeCloseTo(Math.SQRT1_2, 2);
        vi.advanceTimersByTime(4100);
        tick();
        expect(p.getState().current?.id).toBe("tr_2");
        expect(posted).toEqual([25]);
        // Glide over: the worker is told to stop.
        vi.advanceTimersByTime(8100);
        tick();
        expect(helper.playbackRate).toBe(1);
        expect(posted).toEqual([25, 0]);
    });
});
