import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompanionLinkInfo, PlaylistSummary } from "@/lib/companion-library";

const getPlaylists = vi.fn<(link: CompanionLinkInfo, timeoutMs?: number) => Promise<PlaylistSummary[]>>();
const aggregateAcrossCompanions = vi.fn();
const warn = vi.fn();

vi.mock("@/lib/companion-library", () => ({
    aggregateAcrossCompanions: (...a: unknown[]) => aggregateAcrossCompanions(...a),
    companionLibrary: { getPlaylists: (...a: [CompanionLinkInfo, number?]) => getPlaylists(...a) },
}));
vi.mock("@/lib/logger", () => ({ log: { warn: (...a: unknown[]) => warn(...a) } }));

const link = (id: string, online = true): CompanionLinkInfo => ({
    apiUrl: `http://${id}`, token: "t", deviceId: id, userId: "u", name: `srv-${id}`, online, lastSeenAt: null,
});
const pl = (id: number, name: string, createdAt: string | null = null): PlaylistSummary => ({
    id, name, description: null, type: null, createdAt, trackCount: id * 2,
});

describe("getPlaylistsAggregated", () => {
    beforeEach(() => { vi.clearAllMocks(); });

    it("flattens playlists from every companion and tags each with its source", async () => {
        aggregateAcrossCompanions.mockImplementation(async (fn: (l: CompanionLinkInfo) => Promise<PlaylistSummary[]>) => {
            getPlaylists.mockImplementation(async (l) => l.deviceId === "A" ? [pl(1, "Zeta", "2026-01-01")] : [pl(2, "Alpha", "2026-02-01")]);
            const results = [];
            for (const l of [link("A"), link("B", false)]) results.push({ link: l, value: await fn(l) });
            return { results, errors: [{ deviceId: "C", name: "srv-C", error: "boom" }] };
        });
        const { getPlaylistsAggregated } = await import("./playlists-aggregate");
        const out = await getPlaylistsAggregated();
        expect(out.map((p) => [p.name, p.source.serverId, p.source.serverName, p.source.online])).toEqual([
            ["Alpha", "B", "srv-B", false],
            ["Zeta", "A", "srv-A", true],
        ]);
        expect(getPlaylists).toHaveBeenCalledTimes(2);
        expect(warn).toHaveBeenCalledWith("playlists.aggregate companion failed", { deviceId: "C", name: "srv-C" }, "boom");
    });

    it("returns [] when the aggregate itself throws", async () => {
        aggregateAcrossCompanions.mockRejectedValue(new Error("db"));
        const { getPlaylistsAggregated } = await import("./playlists-aggregate");
        expect(await getPlaylistsAggregated()).toEqual([]);
        expect(warn).toHaveBeenCalledWith("playlists.aggregate failed", undefined, expect.any(Error));
    });
});
