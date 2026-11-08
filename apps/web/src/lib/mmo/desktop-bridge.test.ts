import { afterEach, describe, expect, it, vi } from "vitest";
import { DESKTOP_COMMANDS, runDesktopCommand, sameNowPlaying, toDesktopNowPlaying, type DesktopPlayer } from "./desktop-bridge";
import type { WebMusicState } from "./web-music-player";
import type { TrackCard } from "./media-types";

const track = { id: "tr_1", title: "Song", artist: "Band", album: "LP", durationSec: 200 } as TrackCard;
const state = (over: Partial<WebMusicState> = {}): WebMusicState => ({
    queue: [track], index: 0, current: track, playing: true, buffering: false, shuffle: false, repeat: "off", error: null,
    restoring: false, hidden: false, ...over,
});

function player(): DesktopPlayer & { calls: string[] } {
    const calls: string[] = [];
    const rec = (n: string) => (...a: unknown[]) => { calls.push(a.length ? `${n}:${a.join(",")}` : n); };
    return {
        calls, toggle: rec("toggle"), resume: rec("resume"), pause: rec("pause"), next: rec("next"), prev: rec("prev"),
        stop: rec("stop"), seek: rec("seek"), seekBy: rec("seekBy"), setVolume: rec("setVolume"),
    };
}

afterEach(() => vi.unstubAllGlobals());

describe("desktop bridge", () => {
    it("maps the player state, empty when hidden or idle", () => {
        expect(toDesktopNowPlaying(state(), { position: 12, duration: 0 }, "https://x/c.jpg")).toEqual({
            title: "Song", artist: "Band", album: "LP", artUrl: "https://x/c.jpg", playing: true, positionSec: 12, durationSec: 200,
        });
        expect(toDesktopNowPlaying(state({ hidden: true }), { position: 1, duration: 9 }, null).title).toBeNull();
        expect(toDesktopNowPlaying(state({ current: null, index: -1 }), { position: 0, duration: 0 }, null).playing).toBe(false);
    });

    it("skips pushes that the OS can extrapolate", () => {
        const a = toDesktopNowPlaying(state(), { position: 10, duration: 200 }, null);
        expect(sameNowPlaying(null, a, 0)).toBe(false);
        expect(sameNowPlaying(a, { ...a, positionSec: 13 }, 3)).toBe(true);
        expect(sameNowPlaying(a, { ...a, positionSec: 40 }, 3)).toBe(false);
        expect(sameNowPlaying(a, { ...a, playing: false }, 0)).toBe(false);
        expect(sameNowPlaying(a, { ...a, title: "Other" }, 0)).toBe(false);
    });

    it("runs every shell command and rejects unknown or unsafe ones", () => {
        const p = player();
        for (const c of DESKTOP_COMMANDS) runDesktopCommand(p, c, 5);
        expect(p.calls).toEqual(["toggle", "resume", "pause", "next", "prev", "stop", "seek:5", "seekBy:5", "setVolume:1"]);
        expect(runDesktopCommand(p, "seekTo", Number.NaN)).toBe(false);
        expect(runDesktopCommand(p, "seekTo", "5")).toBe(false);
        expect(runDesktopCommand(p, "eval")).toBe(false);
        runDesktopCommand(p, "seekTo", -4);
        expect(p.calls.at(-1)).toBe("seek:0");
    });
});
