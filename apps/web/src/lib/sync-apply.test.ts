/**
 * Pure-logic tests for the per-field LWW merge applied by `applyTrackUpsert`.
 *
 * These tests exercise the field-clock semantics without touching Postgres
 * by stubbing the Drizzle query builders the function calls. We assert the
 * three guarantees that matter:
 *   1. A field is only written when the incoming `updatedAt` beats the
 *      stored per-field clock for THAT field (others can lag).
 *   2. Forbidden fields (`id`, `userId`, `sha256`, `fieldVersions`, …) are
 *      never written even if the payload includes them.
 *   3. Writes ignored by LWW report `{ skipped: true, changed: false }`.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { setDb, applyTrackUpsert, applyPlaylistUpsert, applyCuepointUpsert } from "@mmo/db";

// ---- Stub the @/db module BEFORE importing the unit under test ------------

type Row = { id: number; fv?: Record<string, string> | null; updatedAt?: Date | null };

const state: {
    nextRow: Row[];
    /** When non-null, each `select(...).limit()` call shifts one entry from this queue (for tests with multiple selects). */
    nextRowQueue: Row[][] | null;
    insertCalls: Array<Record<string, unknown>>;
    updateCalls: Array<Record<string, unknown>>;
    deleteCalls: number;
} = { nextRow: [], nextRowQueue: null, insertCalls: [], updateCalls: [], deleteCalls: 0 };

function makeMockDb() {
    const select = () => ({
        from: () => ({
            where: () => ({
                limit: async () => {
                    if (state.nextRowQueue && state.nextRowQueue.length > 0) {
                        return state.nextRowQueue.shift()!;
                    }
                    return state.nextRow;
                },
            }),
        }),
    });
    const insert = () => ({
        values: (v: Record<string, unknown>) => {
            state.insertCalls.push(v);
            return {
                returning: async () => [{ id: 999 }],
                onConflictDoUpdate: async () => undefined,
                onConflictDoNothing: async () => undefined,
            };
        },
    });
    const update = () => ({
        set: (v: Record<string, unknown>) => {
            state.updateCalls.push(v);
            return { where: async () => undefined };
        },
    });
    const del = () => ({
        where: async () => {
            state.deleteCalls++;
        },
    });

    return {
        select,
        insert,
        update,
        delete: del,
        query: { devices: { findFirst: async () => null } },
    };
}

// Drizzle's `eq` / `and` / `sql` are called for argument shape only — return
// opaque markers; our stub `where()` doesn't care about their content.
vi.mock("drizzle-orm", () => ({
    eq: () => ({ __op: "eq" }),
    and: (...xs: unknown[]) => ({ __op: "and", xs }),
    sql: Object.assign(() => "SQL", { raw: (s: string) => s }),
}));

// `./schema` is referenced by the unit only for column accessors; the
// stubbed query builders never read those values, so a proxy that returns
// itself for every property satisfies every chained access.
vi.mock("@mmo/db/schema", () => {
    const proxy: unknown = new Proxy({}, { get: () => proxy });
    return {
        tracks: proxy,
        playlists: proxy,
        playlistTracks: proxy,
        tags: proxy,
        trackTags: proxy,
        cuepoints: proxy,
        syncLog: proxy,
        devices: proxy,
        users: proxy,
        trackSources: proxy,
    };
});
vi.mock("@mmo/db/schema-projects", () => {
    const proxy: unknown = new Proxy({}, { get: () => proxy });
    return { PROJECT_TABLES: {}, PROJECT_SYNC_ENTITY: {}, projectSnapshots: proxy, projectAssets: proxy };
});
vi.mock("@mmo/db/schema-projects-normalized", () => ({ SUB_TABLES: {} }));

// (functions imported from @mmo/db at top; mocks above are hoisted by vitest)

const change = (over: Partial<{ payload: Record<string, unknown>; updatedAt: string; op: "upsert" | "delete" }> = {}) => ({
    entity: "tracks" as const,
    entityId: "sha-abc",
    op: "upsert" as const,
    updatedAt: "2026-05-10T10:00:00.000Z",
    payload: { bpm: 128, rating: 4 },
    ...over,
});

beforeEach(() => {
    state.nextRow = [];
    state.nextRowQueue = null;
    state.insertCalls = [];
    state.updateCalls = [];
    state.deleteCalls = 0;
    setDb(makeMockDb());
});

describe("applyTrackUpsert (per-field LWW)", () => {
    it("inserts a new row and stamps every field's clock to updatedAt", async () => {
        state.nextRow = []; // no existing row
        const res = await applyTrackUpsert("user-1", change());
        expect(res.changed).toBe(true);
        expect(state.insertCalls).toHaveLength(1);
        const v = state.insertCalls[0];
        expect(v.userId).toBe("user-1");
        expect(v.sha256).toBe("sha-abc");
        expect(v.bpm).toBe(128);
        expect(v.rating).toBe(4);
        expect(v.fieldVersions).toEqual({
            bpm: "2026-05-10T10:00:00.000Z",
            rating: "2026-05-10T10:00:00.000Z",
        });
    });

    it("accepts a field whose stored clock is older than the incoming updatedAt", async () => {
        state.nextRow = [{ id: 7, fv: { bpm: "2026-05-10T09:00:00.000Z" } }];
        const res = await applyTrackUpsert("u", change({ payload: { bpm: 130 } }));
        expect(res.changed).toBe(true);
        expect(state.updateCalls).toHaveLength(1);
        const v = state.updateCalls[0];
        expect(v.bpm).toBe(130);
        expect((v.fieldVersions as Record<string, string>).bpm).toBe("2026-05-10T10:00:00.000Z");
    });

    it("rejects a field whose stored clock is newer (LWW loser)", async () => {
        state.nextRow = [{ id: 7, fv: { bpm: "2026-05-10T11:00:00.000Z" } }];
        const res = await applyTrackUpsert("u", change({ payload: { bpm: 130 } }));
        expect(res.changed).toBe(false);
        expect(res.skipped).toBe(true);
        expect(state.updateCalls).toHaveLength(0);
    });

    it("merges: accepts the per-field winners, rejects the losers in the same payload", async () => {
        state.nextRow = [
            {
                id: 7,
                fv: {
                    bpm: "2026-05-10T11:00:00.000Z", // newer — loser
                    rating: "2026-05-10T09:00:00.000Z", // older — winner
                },
            },
        ];
        const res = await applyTrackUpsert("u", change({ payload: { bpm: 130, rating: 5, mood: "uplifting" } }));
        expect(res.changed).toBe(true);
        expect(state.updateCalls).toHaveLength(1);
        const v = state.updateCalls[0];
        expect(v.bpm).toBeUndefined(); // rejected
        expect(v.rating).toBe(5);
        expect(v.mood).toBe("uplifting");
        const fv = v.fieldVersions as Record<string, string>;
        expect(fv.bpm).toBe("2026-05-10T11:00:00.000Z"); // unchanged
        expect(fv.rating).toBe("2026-05-10T10:00:00.000Z");
        expect(fv.mood).toBe("2026-05-10T10:00:00.000Z");
    });

    it("ignores forbidden fields even when the payload includes them", async () => {
        state.nextRow = [];
        const res = await applyTrackUpsert(
            "u",
            change({
                payload: {
                    id: 99999,
                    userId: "evil",
                    sha256: "spoof",
                    fieldVersions: { bpm: "2099-01-01T00:00:00.000Z" },
                    bpm: 128,
                },
            }),
        );
        expect(res.changed).toBe(true);
        const v = state.insertCalls[0];
        expect(v.userId).toBe("u"); // from arg, not payload
        expect(v.sha256).toBe("sha-abc"); // from entityId, not payload
        // Forbidden client-supplied fieldVersions never leaks in
        const fv = v.fieldVersions as Record<string, string>;
        expect(fv.bpm).toBe("2026-05-10T10:00:00.000Z");
        expect(Object.keys(fv)).toEqual(["bpm"]);
    });

    it("delete is per-field LWW on isHidden", async () => {
        state.nextRow = [{ id: 7, fv: { isHidden: "2026-05-10T11:00:00.000Z" } }];
        const res = await applyTrackUpsert("u", change({ op: "delete", payload: {} }));
        expect(res.skipped).toBe(true); // newer hide already in place
        expect(state.updateCalls).toHaveLength(0);

        state.nextRow = [{ id: 7, fv: { isHidden: "2026-05-10T09:00:00.000Z" } }];
        const res2 = await applyTrackUpsert("u", change({ op: "delete", payload: {} }));
        expect(res2.changed).toBe(true);
        expect((state.updateCalls[0] as { isHidden: boolean }).isHidden).toBe(true);
    });

    it("a payload with only-loser fields is a no-op", async () => {
        state.nextRow = [{ id: 7, fv: { bpm: "2026-05-10T11:00:00.000Z" } }];
        const res = await applyTrackUpsert("u", change({ payload: { bpm: 999 } }));
        expect(res.changed).toBe(false);
        expect(res.skipped).toBe(true);
        expect(state.updateCalls).toHaveLength(0);
    });
});

describe("applyPlaylistUpsert (row-level LWW on delete)", () => {
    const plChange = (over: Partial<{ op: "upsert" | "delete"; updatedAt: string }> = {}) => ({
        entity: "playlists" as const,
        entityId: "pl-ext-1",
        op: "delete" as const,
        updatedAt: "2026-05-10T10:00:00.000Z",
        payload: null,
        ...over,
    });

    it("rejects a stale tombstone (cloud has a newer write)", async () => {
        state.nextRow = [{ id: 42, updatedAt: new Date("2026-05-10T11:00:00.000Z") }];
        const res = await applyPlaylistUpsert("u", plChange());
        expect(res.changed).toBe(false);
        expect(res.skipped).toBe(true);
        expect(state.deleteCalls).toBe(0);
    });

    it("accepts a fresh delete (cloud row is older)", async () => {
        state.nextRow = [{ id: 42, updatedAt: new Date("2026-05-10T09:00:00.000Z") }];
        const res = await applyPlaylistUpsert("u", plChange());
        expect(res.changed).toBe(true);
        expect(state.deleteCalls).toBe(1);
    });

    it("delete on missing row is a skip, not an error", async () => {
        state.nextRow = [];
        const res = await applyPlaylistUpsert("u", plChange());
        expect(res.changed).toBe(false);
        expect(res.skipped).toBe(true);
        expect(state.deleteCalls).toBe(0);
    });
});

describe("applyCuepointUpsert (row-level LWW on delete)", () => {
    const cpChange = (over: Partial<{ op: "upsert" | "delete"; updatedAt: string }> = {}) => ({
        entity: "cuepoints" as const,
        entityId: "cue-ext-1",
        op: "delete" as const,
        updatedAt: "2026-05-10T10:00:00.000Z",
        payload: { trackSha256: "sha-abc" },
        ...over,
    });

    it("rejects a stale tombstone", async () => {
        // First select() → tracks lookup; second → cuepoints lookup.
        state.nextRowQueue = [
            [{ id: 1 }],
            [{ id: 99, updatedAt: new Date("2026-05-10T11:00:00.000Z") }],
        ];
        const res = await applyCuepointUpsert("u", cpChange());
        expect(res.skipped).toBe(true);
        expect(state.deleteCalls).toBe(0);
    });

    it("accepts a fresh delete", async () => {
        state.nextRowQueue = [
            [{ id: 1 }],
            [{ id: 99, updatedAt: new Date("2026-05-10T09:00:00.000Z") }],
        ];
        const res = await applyCuepointUpsert("u", cpChange());
        expect(res.changed).toBe(true);
        expect(state.deleteCalls).toBe(1);
    });
});