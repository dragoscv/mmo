import { describe, expect, it } from "vitest";
import type { ProgressEntry, SeasonEpisode, VersionedFile } from "@/lib/mmo/media-types";
import {
    authQuery, browserCaps, followerAction, formatTime, guestPath, hlsUrl, inviteExpiry, inviteLink, keyAction, keyBelongsToControl,
    nextPlayable, parseServerUrl, pickAudio, pickFile, pickSubtitle, playCommandArgs, playHref, readPlayerPrefs, resumePosition,
    roomApply, sortVersions, spriteGrid, spriteTile, subtitleOrder, tilePosition, DEFAULT_PREFS,
} from "./model";
import { activeCues, parseVtt } from "./vtt";
import { resolvePlayback, type TitleSource } from "./resolve";
import type { MediaSeasonResponse, MediaTitleResponse } from "@/lib/mmo/media-types";

const file = (id: string, rank: number, size = 1, extra: Partial<VersionedFile> = {}): VersionedFile => ({
    serverFileId: id, kind: "movie", tmdbId: 1, season: null, episode: null, path: `/m/${id}.mkv`, size, mtime: 0, updatedAt: 0,
    version: { resolution: null, hdr: null, edition: null, remux: false, label: id, rank }, ...extra,
});
const prog = (o: Partial<ProgressEntry>): ProgressEntry => ({
    profileId: "p", kind: "movie", tmdbId: 1, season: 0, episode: 0, positionSec: 0, durationSec: 0, completed: false, updatedAt: 0, ...o,
});

describe("hlsUrl", () => {
    const token = { kind: "token" as const, token: "tok en", userId: "u1" };
    it("builds the original-quality playlist with start, caps, audio and token auth", () => {
        const u = hlsUrl("https://srv.example/", "abc", token, { startSec: 125.9, audio: 2, caps: ["h264", "aac"] });
        expect(u).toBe("https://srv.example/video/stream/abc?q=original&start=125&caps=h264%2Caac&audio=2&t=tok%20en&u=u1");
    });
    it("omits start=0 and audio=0 and uses the invite for guests", () => {
        const u = hlsUrl("http://10.0.0.2:17899", "f1", { kind: "invite", invite: "r.1.m" });
        expect(u).toBe("http://10.0.0.2:17899/video/stream/f1?q=original&inv=r.1.m");
        expect(u).not.toContain("t=");
    });
    it("auth helpers", () => {
        expect(authQuery({ kind: "token", token: "a", userId: "" })).toBe("t=a");
        expect(guestPath("/video/intro/x", { kind: "invite", invite: "i" })).toBe("/video/intro/x?inv=i");
        expect(guestPath("/video/intro/x", token)).toBe("/video/intro/x");
    });
    it("browserCaps adds hevc/ac3/eac3 only when supported", () => {
        expect(browserCaps(() => false)).toEqual(["h264", "aac", "mp3"]);
        expect(browserCaps(() => true)).toEqual(["h264", "hevc", "aac", "mp3", "ac3", "eac3"]);
    });
});

describe("links", () => {
    it("playHref", () => {
        expect(playHref({ kind: "tv", tmdbId: 5, season: 1, episode: 2, startSec: 30.4 })).toBe("/media/play/tv/5?s=1&e=2&t=30");
        expect(playHref({ kind: "movie", tmdbId: 9 })).toBe("/media/play/movie/9");
    });
    it("inviteLink matches the TV QR format", () => {
        expect(inviteLink("https://mixai.ro", "https://x.trycloudflare.com/", "r.9.m"))
            .toBe("https://mixai.ro/together?server=https%3A%2F%2Fx.trycloudflare.com&inv=r.9.m");
    });
    it("parseServerUrl accepts http(s) only, no credentials", () => {
        expect(parseServerUrl("https://a.b/")).toBe("https://a.b");
        expect(parseServerUrl("http://192.168.1.2:17899")).toBe("http://192.168.1.2:17899");
        expect(parseServerUrl("javascript:alert(1)")).toBeNull();
        expect(parseServerUrl("ftp://a")).toBeNull();
        expect(parseServerUrl("https://u:p@a.b")).toBeNull();
        expect(parseServerUrl("nope")).toBeNull();
        expect(parseServerUrl(null)).toBeNull();
    });
    it("inviteExpiry", () => {
        expect(inviteExpiry("room.1700000000000.mac")).toBe(1700000000000);
        expect(inviteExpiry("bad")).toBeNull();
        expect(inviteExpiry("r.x.m")).toBeNull();
    });
});

describe("file / version picking", () => {
    const files = [file("a", 2, 10), file("b", 5, 5), file("c", 5, 50), file("", 9)];
    it("picks the highest rank, then the bigger file, ignoring empty ids", () => {
        expect(pickFile(files)?.serverFileId).toBe("c");
    });
    it("honours an explicit file", () => {
        expect(pickFile(files, "a")?.serverFileId).toBe("a");
        expect(pickFile(files, "zzz")?.serverFileId).toBe("c");
    });
    it("sortVersions best first", () => {
        expect(sortVersions(files).map((f) => f.serverFileId)).toEqual(["c", "b", "a"]);
    });
    it("nextPlayable skips episodes without files and rolls into the next season", () => {
        const ep = (n: number, files: VersionedFile[]): SeasonEpisode => ({ seasonNumber: 1, episodeNumber: n, name: `E${n}`, stillPath: null, files, progress: null });
        const cur = [ep(1, [file("e1", 1)]), ep(2, []), ep(3, [])];
        const next = [{ ...ep(1, [file("s2e1", 1)]), seasonNumber: 2 }];
        expect(nextPlayable(cur, 1, 1, next)).toMatchObject({ season: 2, episode: 1 });
        expect(nextPlayable([...cur, ep(4, [file("e4", 1)])], 1, 1, null)).toMatchObject({ season: 1, episode: 4 });
        expect(nextPlayable(cur, 1, 3, null)).toBeNull();
    });
});

describe("resumePosition", () => {
    it("explicit t wins, including 0", () => {
        expect(resumePosition({ explicit: 0, progress: prog({ positionSec: 500, durationSec: 5000 }) })).toBe(0);
        expect(resumePosition({ explicit: 42.7 })).toBe(42);
    });
    it("uses progress past 10 s", () => {
        expect(resumePosition({ progress: prog({ positionSec: 600, durationSec: 6000 }) })).toBe(600);
        expect(resumePosition({ progress: prog({ positionSec: 8, durationSec: 6000 }) })).toBe(0);
    });
    it("restarts completed or nearly finished titles", () => {
        expect(resumePosition({ progress: prog({ positionSec: 600, durationSec: 6000, completed: true }) })).toBe(0);
        expect(resumePosition({ progress: prog({ positionSec: 5800, durationSec: 6000 }) })).toBe(0);
        expect(resumePosition({ progress: prog({ positionSec: 5700, durationSec: 0 }), durationSec: 5720 })).toBe(0);
    });
});

describe("resolvePlayback", () => {
    const title = (o: Partial<MediaTitleResponse>): MediaTitleResponse => ({
        title: { kind: "movie", tmdbId: 1, title: "T", posterPath: null, backdropPath: null, genreIds: [], genres: [], logoPath: null, recommendations: [], similar: [], runtime: 100 },
        availability: { offers: [], source: "none", attribution: [] }, files: [], progress: [], serverId: null, serverName: "s", ...o,
    });
    const src = (t: MediaTitleResponse | null, seasons: Record<number, MediaSeasonResponse> = {}): TitleSource => ({
        mediaTitle: async () => t,
        season: async (_id, n) => seasons[n] ?? null,
    });
    it("movie: best file + resume", async () => {
        const r = await resolvePlayback(src(title({ files: [file("a", 1), file("b", 3)], progress: [prog({ positionSec: 900, durationSec: 6000 })] })), { kind: "movie", tmdbId: 1 });
        expect(r.ok && r.value.file.serverFileId).toBe("b");
        expect(r.ok && r.value.startSec).toBe(900);
    });
    it("movie without files → no_file; unknown → not_found", async () => {
        expect(await resolvePlayback(src(title({})), { kind: "movie", tmdbId: 1 })).toEqual({ ok: false, error: "no_file" });
        expect(await resolvePlayback(src(null), { kind: "movie", tmdbId: 1 })).toEqual({ ok: false, error: "not_found" });
    });
    it("tv: nextUp episode with its position", async () => {
        const ep = { seasonNumber: 2, episodeNumber: 3, name: "x", stillPath: null, files: [file("s2e3", 1, 1, { season: 2, episode: 3 })], progress: null };
        const season: MediaSeasonResponse = { tmdbId: 1, seasonNumber: 2, name: "S2", posterPath: null, episodes: [ep], serverId: null };
        const r = await resolvePlayback(src(title({ nextUp: { season: 2, episode: 3, positionSec: 321 } }), { 2: season }), { kind: "tv", tmdbId: 1 });
        expect(r.ok && [r.value.file.serverFileId, r.value.season, r.value.episode, r.value.startSec]).toEqual(["s2e3", 2, 3, 321]);
    });
    it("tv: requested episode falls back to title files when the season call fails", async () => {
        const r = await resolvePlayback(src(title({ files: [file("x", 1, 1, { season: 1, episode: 4 })] })), { kind: "tv", tmdbId: 1, season: 1, episode: 4, startSec: 0 });
        expect(r.ok && r.value.file.serverFileId).toBe("x");
        expect(r.ok && r.value.startSec).toBe(0);
    });
});

describe("Watch Together decisions", () => {
    const anchor = { playing: true, positionSec: 100, atServerMs: 10_000 };
    it("drift: none under 120 ms, rate nudge ≤ ±5 % under 1.5 s, seek above", () => {
        expect(followerAction(105.05, anchor, 15_000, false)).toEqual({ kind: "none" });
        const ahead = followerAction(105.5, anchor, 15_000, false);
        expect(ahead.kind).toBe("rate");
        if (ahead.kind === "rate") { expect(ahead.rate).toBeLessThan(1); expect(ahead.rate).toBeGreaterThanOrEqual(0.95); }
        const behind = followerAction(104.2, anchor, 15_000, false);
        if (behind.kind === "rate") expect(behind.rate).toBeLessThanOrEqual(1.05);
        expect(behind.kind).toBe("rate");
        expect(followerAction(107, anchor, 15_000, false)).toEqual({ kind: "seek", positionSec: 105 });
    });
    it("drift hysteresis keeps correcting between 40 and 120 ms", () => {
        expect(followerAction(105.08, anchor, 15_000, true).kind).toBe("rate");
        expect(followerAction(105.08, anchor, 15_000, false).kind).toBe("none");
    });
    it("roomApply schedules future anchors, joins running ones, pauses paused ones", () => {
        expect(roomApply(true, { playing: true, positionSec: 50, atServerMs: 2_000 }, 1_000, 49)).toEqual({ kind: "schedule", seekTo: 50, delayMs: 1_000 });
        expect(roomApply(true, { playing: true, positionSec: 50, atServerMs: 1_000 }, 3_000, 52.2)).toEqual({ kind: "play", seekTo: null });
        expect(roomApply(true, { playing: true, positionSec: 50, atServerMs: 1_000 }, 3_000, 40)).toEqual({ kind: "play", seekTo: 52 });
        expect(roomApply(false, { playing: false, positionSec: 50, atServerMs: 0 }, 3_000, 50.2)).toEqual({ kind: "pause", seekTo: null });
        expect(roomApply(false, { playing: false, positionSec: 50, atServerMs: 0 }, 3_000, 60)).toEqual({ kind: "pause", seekTo: 50 });
    });
    it("play command args match the TV handlers", () => {
        expect(playCommandArgs({ fileId: "f", kind: "tv", tmdbId: 3, season: 1, episode: 2, startSec: 61.8, title: "X" }))
            .toEqual({ fileId: "f", kind: "tv", tmdbId: 3, season: 1, episode: 2, startSec: 61, title: "X" });
        expect(playCommandArgs({ fileId: "f", kind: "movie", tmdbId: 3, startSec: 0 })).toEqual({ fileId: "f", kind: "movie", tmdbId: 3 });
    });
});

describe("keyboard map", () => {
    it.each([
        [" ", { type: "toggle" }], ["k", { type: "toggle" }], ["K", { type: "toggle" }],
        ["ArrowLeft", { type: "seekBy", delta: -10 }], ["j", { type: "seekBy", delta: -10 }],
        ["ArrowRight", { type: "seekBy", delta: 10 }], ["l", { type: "seekBy", delta: 10 }],
        ["ArrowUp", { type: "volumeBy", delta: 0.1 }], ["ArrowDown", { type: "volumeBy", delta: -0.1 }],
        ["m", { type: "mute" }], ["f", { type: "fullscreen" }], ["c", { type: "subtitles" }], ["Escape", { type: "back" }],
        ["5", { type: "seekPercent", pct: 50 }],
    ])("%s", (key, want) => { expect(keyAction({ key })).toEqual(want); });
    it("ignores modifiers and unknown keys", () => {
        expect(keyAction({ key: "f", ctrlKey: true })).toBeNull();
        expect(keyAction({ key: "q" })).toBeNull();
    });
    it("lets focused controls keep their own keys", () => {
        expect(keyBelongsToControl(" ", "BUTTON", null, false)).toBe(true);
        expect(keyBelongsToControl("k", "BUTTON", null, false)).toBe(false);
        expect(keyBelongsToControl("ArrowLeft", "DIV", "slider", false)).toBe(true);
        expect(keyBelongsToControl("ArrowDown", "BUTTON", "radio", false)).toBe(true);
        expect(keyBelongsToControl("ArrowDown", "BUTTON", null, false)).toBe(false);
        expect(keyBelongsToControl("ArrowDown", "DIV", "radiogroup", false)).toBe(true);
        expect(keyBelongsToControl("m", "INPUT", null, false)).toBe(true);
        expect(keyBelongsToControl("Escape", "INPUT", null, false)).toBe(false);
    });
});

describe("tracks + prefs", () => {
    const info = {
        audioTracks: [{ index: 1, codec: "eac3", channels: 6, lang: "eng", title: null }, { index: 2, codec: "aac", channels: 2, lang: "ron", title: null }],
        subtitleTracks: [
            { index: 3, codec: "subrip", lang: "eng", title: null, forced: false },
            { index: 4, codec: "hdmv_pgs_subtitle", lang: "ron", title: null, forced: false },
            { index: 5, codec: "subrip", lang: "ron", title: null, forced: false },
            { index: 6, codec: "subrip", lang: "eng", title: null, forced: true },
        ],
    };
    it("pickAudio by language, default 0", () => {
        expect(pickAudio(info.audioTracks, { ...DEFAULT_PREFS, audioLang: "ro" })).toBe(1);
        expect(pickAudio(info.audioTracks, DEFAULT_PREFS)).toBe(0);
    });
    it("pickSubtitle skips bitmap tracks and falls back to forced", () => {
        expect(pickSubtitle(info, { ...DEFAULT_PREFS, subLang: "ro" }, 0)).toBe(2);
        expect(pickSubtitle(info, DEFAULT_PREFS, 0)).toBe(3);
        expect(pickSubtitle(info, { ...DEFAULT_PREFS, subForcedOnly: true }, 0)).toBe(3);
        expect(subtitleOrder(info.subtitleTracks)).toEqual([3, 0, 2]);
    });
    it("readPlayerPrefs validates values and honours the legacy autoplay key", () => {
        expect(readPlayerPrefs({ prefs: { autoplay: false, subSize: "huge", subBg: "box" } })).toMatchObject({ autoplayNext: false, subSize: "medium", subBg: "box" });
        expect(readPlayerPrefs(null)).toEqual(DEFAULT_PREFS);
    });
});

describe("sprite + format + vtt", () => {
    it("sprite grid mirrors the server", () => {
        expect(spriteGrid(20)).toBeNull();
        const g = spriteGrid(7200)!;
        expect(g).toEqual({ intervalSec: 50, cells: 144 });
        expect(spriteTile(g, 125)).toBe(2);
        expect(spriteTile(g, 1e9)).toBe(143);
        expect(tilePosition(13)).toBe(`${100 / 11}% ${100 / 11}%`);
    });
    it("formatTime", () => {
        expect(formatTime(83)).toBe("1:23");
        expect(formatTime(3723)).toBe("1:02:03");
        expect(formatTime(Number.NaN)).toBe("0:00");
    });
    it("parses short VTT stamps and finds active cues", () => {
        const cues = parseVtt("WEBVTT\n\n00:01.000 --> 00:03.500\n<i>Hello</i> &amp; bye\n\n1\n00:00:02.000 --> 00:00:04.000 line:90%\nSecond");
        expect(cues).toHaveLength(2);
        expect(activeCues(cues, 2.5)).toEqual(["Hello & bye", "Second"]);
        expect(activeCues(cues, 5)).toEqual([]);
    });
});
