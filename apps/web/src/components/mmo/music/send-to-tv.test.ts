import { describe, expect, it, vi } from "vitest";
import type { HubDevice } from "@/lib/mmo/media-types";
import { buildQueueHandoff, handQueueToDevice, handoffResult, musicTargets } from "./send-to-tv";

const dev = (o: Partial<HubDevice>): HubDevice => ({
    deviceId: "d", name: "N", platform: "android-tv", caps: ["play", "music"], profileId: null, app: null, connectedAt: 0, guest: false, nowPlaying: null, ...o,
});
const q = (...ids: string[]) => ids.map((id) => ({ id }));
const base = { positionSec: 0, shuffle: false, repeat: "off" as const };

describe("musicTargets", () => {
    it("keeps devices with the music cap, drops this browser, guests and video-only devices", () => {
        const list = musicTargets([
            dev({ deviceId: "self" }),
            dev({ deviceId: "guest", guest: true }),
            dev({ deviceId: "old-tv", caps: ["play", "pause"] }),
            dev({ deviceId: "tizen", platform: "tizen" }),
            dev({ deviceId: "phone", platform: "ios", caps: ["music"] }),
            dev({ deviceId: "broken", caps: undefined as unknown as string[] }),
        ], "self");
        expect(list.map((d) => d.deviceId)).toEqual(["tizen", "phone"]);
    });
});

describe("buildQueueHandoff", () => {
    it("sends the whole queue, the current index and whole seconds; the TV never reshuffles", () => {
        const h = buildQueueHandoff({ queue: q("tr_1", "tr_2", "tr_3"), index: 1, positionSec: 61.8, shuffle: true, repeat: "all" });
        expect(h).toEqual({
            queue: { trackIds: ["tr_1", "tr_2", "tr_3"], index: 1, positionSec: 61, shuffle: true, repeat: "all" },
            command: { trackIds: ["tr_1", "tr_2", "tr_3"], index: 1, positionSec: 61, shuffle: false, repeat: "all" },
        });
    });

    it("drops ids the server does not know and re-points the index at the current track", () => {
        const h = buildQueueHandoff({ ...base, queue: q("local-a", "tr_1", "blob:x", "tr_2", "tr_3"), index: 3, positionSec: 12 });
        expect(h?.command).toEqual({ trackIds: ["tr_1", "tr_2", "tr_3"], index: 1, positionSec: 12, shuffle: false, repeat: "off" });
    });

    it("starts the next sendable track from 0 when the current one cannot be sent", () => {
        const h = buildQueueHandoff({ ...base, queue: q("tr_1", "local-a", "tr_2"), index: 1, positionSec: 90 });
        expect(h?.command.index).toBe(1);
        expect(h?.command.positionSec).toBe(0);
        expect(h?.queue.positionSec).toBe(0);
    });

    it("falls back to the last sendable track when nothing after the current one can be sent", () => {
        const h = buildQueueHandoff({ ...base, queue: q("tr_1", "tr_2", "local-a"), index: 2, positionSec: 30 });
        expect(h?.command).toMatchObject({ trackIds: ["tr_1", "tr_2"], index: 1, positionSec: 0 });
    });

    it("handles an index outside the queue and a bad position", () => {
        expect(buildQueueHandoff({ ...base, queue: q("tr_1", "tr_2"), index: -1 })?.command.index).toBe(0);
        expect(buildQueueHandoff({ ...base, queue: q("tr_1", "tr_2"), index: 9 })?.command.index).toBe(1);
        expect(buildQueueHandoff({ ...base, queue: q("tr_1"), index: 0, positionSec: Number.NaN })?.command.positionSec).toBe(0);
        expect(buildQueueHandoff({ ...base, queue: q("tr_1"), index: 0, positionSec: -5 })?.command.positionSec).toBe(0);
    });

    it("caps the queue at 2000 ids and keeps the index inside it", () => {
        const many = Array.from({ length: 2100 }, (_, i) => ({ id: `tr_${i}` }));
        const h = buildQueueHandoff({ ...base, queue: many, index: 2050, positionSec: 7 });
        expect(h?.command.trackIds).toHaveLength(2000);
        expect(h?.command.index).toBe(1999);
        expect(h?.command.positionSec).toBe(0);
    });

    it("returns null when there is nothing a TV could play", () => {
        expect(buildQueueHandoff({ ...base, queue: [], index: -1 })).toBeNull();
        expect(buildQueueHandoff({ ...base, queue: q("local-a", "x"), index: 0 })).toBeNull();
    });
});

describe("handoffResult", () => {
    it.each([
        [{ ok: true }, { ok: true }],
        [{}, { ok: true }],
        [null, { ok: false, reason: "rejected" }],
        [{ ok: false, error: "timeout" }, { ok: false, reason: "timeout" }],
        [{ ok: false, error: "offline" }, { ok: false, reason: "offline" }],
        [{ ok: false, error: "no_such_device" }, { ok: false, reason: "offline" }],
        [{ ok: false, error: "tracks_not_found" }, { ok: false, reason: "not_found" }],
        [{ ok: false, error: "no_tracks" }, { ok: false, reason: "not_found" }],
        [{ ok: false, error: "music_unavailable" }, { ok: false, reason: "rejected", detail: "music_unavailable" }],
        [{ ok: false }, { ok: false, reason: "rejected" }],
    ])("%j → %j", (ack, want) => {
        expect(handoffResult(ack)).toEqual(want);
    });
});

describe("handQueueToDevice", () => {
    const input = { queue: q("tr_1", "tr_2"), index: 1, positionSec: 42.4, shuffle: true, repeat: "one" as const };

    it("saves the queue first, then sends one `play` with the same ids to the picked device", async () => {
        const calls: string[] = [];
        const saveQueue = vi.fn(async () => { calls.push("save"); });
        const command = vi.fn(async () => { calls.push("cmd"); return { ok: true }; });
        const r = await handQueueToDevice({ saveQueue, command }, "tv-1", input);
        expect(r).toEqual({ ok: true });
        expect(calls).toEqual(["save", "cmd"]);
        expect(saveQueue).toHaveBeenCalledWith({ trackIds: ["tr_1", "tr_2"], index: 1, positionSec: 42, shuffle: true, repeat: "one" });
        expect(command).toHaveBeenCalledTimes(1);
        expect(command).toHaveBeenCalledWith("tv-1", "play", { trackIds: ["tr_1", "tr_2"], index: 1, positionSec: 42, shuffle: false, repeat: "one" });
    });

    it("still hands off when the server save fails", async () => {
        const command = vi.fn(async () => ({ ok: true }));
        const r = await handQueueToDevice({ saveQueue: async () => { throw new Error("offline"); }, command }, "tv-1", input);
        expect(r).toEqual({ ok: true });
        expect(command).toHaveBeenCalledTimes(1);
    });

    it("does not touch the server or the TV for an empty queue", async () => {
        const saveQueue = vi.fn(async () => undefined);
        const command = vi.fn(async () => ({ ok: true }));
        expect(await handQueueToDevice({ saveQueue, command }, "tv-1", { ...input, queue: [] })).toEqual({ ok: false, reason: "empty" });
        expect(saveQueue).not.toHaveBeenCalled();
        expect(command).not.toHaveBeenCalled();
    });

    it("reports the TV's refusal and a thrown transport error", async () => {
        const saveQueue = async () => undefined;
        expect(await handQueueToDevice({ saveQueue, command: async () => ({ ok: false, error: "tracks_not_found" }) }, "tv-1", input))
            .toEqual({ ok: false, reason: "not_found" });
        expect(await handQueueToDevice({ saveQueue, command: async () => { throw new Error("boom"); } }, "tv-1", input))
            .toEqual({ ok: false, reason: "offline" });
    });
});
