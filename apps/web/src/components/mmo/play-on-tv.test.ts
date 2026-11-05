import { describe, expect, it, vi } from "vitest";

vi.mock("./mmo-provider", () => ({ useMmo: () => ({}) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import type { HubDevice } from "@/lib/mmo/media-types";
import { castableDevices, isTv } from "./play-on-tv";

const dev = (o: Partial<HubDevice>): HubDevice => ({
    deviceId: "d", name: "N", platform: "web", caps: ["play"], profileId: null, app: null, connectedAt: 0, guest: false, nowPlaying: null, ...o,
});

describe("castableDevices", () => {
    it("excludes this browser, guests and devices without play; TVs first", () => {
        const list = castableDevices([
            dev({ deviceId: "self", name: "Me" }),
            dev({ deviceId: "g", guest: true }),
            dev({ deviceId: "x", caps: ["pause"] }),
            dev({ deviceId: "b", name: "Browser", platform: "web" }),
            dev({ deviceId: "t", name: "Living room", platform: "tizen" }),
        ], "self");
        expect(list.map((d) => d.deviceId)).toEqual(["t", "b"]);
    });
    it("isTv", () => {
        expect(isTv({ platform: "android-tv" })).toBe(true);
        expect(isTv({ platform: "web" })).toBe(false);
    });
});
