import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { SqliteSyncStorage } from "./sqlite-sync-storage";
import type { SyncChange } from "./cloud-sync-client";

let db: Database.Database;
let storage: SqliteSyncStorage;

beforeEach(() => {
    db = new Database(":memory:");
    storage = new SqliteSyncStorage(db, {
        seed: { apiUrl: "https://muzicai.ro", deviceToken: "tok-abc" },
    });
});

const change = (over: Partial<SyncChange> = {}): SyncChange => ({
    entity: "tracks",
    entityId: "sha-1",
    op: "upsert",
    payload: { title: "X" },
    updatedAt: "2026-01-01T00:00:00Z",
    ...over,
});

describe("SqliteSyncStorage — state row", () => {
    it("seeds the singleton state row on first construction", async () => {
        const s = await storage.load();
        expect(s).toEqual({ apiUrl: "https://muzicai.ro", deviceToken: "tok-abc", lastPullCursor: 0 });
    });

    it("does not re-seed an existing state row on re-open", async () => {
        // Mutate the seeded row, then construct a new storage with a different
        // seed — the original values must survive.
        await storage.save({ apiUrl: "https://muzicai.ro", deviceToken: "tok-abc", lastPullCursor: 42 });
        const second = new SqliteSyncStorage(db, {
            seed: { apiUrl: "https://other", deviceToken: "tok-xyz" },
        });
        const s = await second.load();
        expect(s).toEqual({ apiUrl: "https://muzicai.ro", deviceToken: "tok-abc", lastPullCursor: 42 });
    });

    it("save() persists cursor advances", async () => {
        await storage.save({ apiUrl: "https://muzicai.ro", deviceToken: "tok-abc", lastPullCursor: 100 });
        const s = await storage.load();
        expect(s?.lastPullCursor).toBe(100);
    });

    it("load() returns null when the state row is missing", async () => {
        const blank = new Database(":memory:");
        const s = new SqliteSyncStorage(blank);
        expect(await s.load()).toBeNull();
    });
});

describe("SqliteSyncStorage — push queue", () => {
    it("enqueue + drainDirty round-trip preserves all fields", async () => {
        storage.enqueue(change({ entityId: "abc", payload: { title: "X" } }));
        const drained = await storage.drainDirty(10);
        expect(drained).toHaveLength(1);
        expect(drained[0]).toMatchObject({
            entity: "tracks",
            entityId: "abc",
            op: "upsert",
            updatedAt: "2026-01-01T00:00:00Z",
        });
        expect(drained[0].payload).toEqual({ title: "X" });
    });

    it("drainDirty returns FIFO and respects the limit (peek-only, ack required)", async () => {
        for (let i = 0; i < 5; i++) storage.enqueue(change({ entityId: `e${i}` }));
        const first = await storage.drainDirty(3);
        expect(first.map((c) => c.entityId)).toEqual(["e0", "e1", "e2"]);
        // Without ack, the next drain still sees everything (queue retains rows).
        const peekAgain = await storage.drainDirty(10);
        expect(peekAgain.map((c) => c.entityId)).toEqual(["e0", "e1", "e2", "e3", "e4"]);
        // After acking the first batch, only the remaining rows come back.
        await storage.ackDirty(first.map((c) => c._queueId));
        const rest = await storage.drainDirty(10);
        expect(rest.map((c) => c.entityId)).toEqual(["e3", "e4"]);
    });

    it("drainDirty alone does NOT remove rows; ackDirty does", async () => {
        storage.enqueue(change({ entityId: "a" }));
        storage.enqueue(change({ entityId: "b" }));
        const peek1 = await storage.drainDirty(10);
        const peek2 = await storage.drainDirty(10);
        expect(peek2).toHaveLength(2);
        await storage.ackDirty(peek1.map((c) => c._queueId));
        const after = await storage.drainDirty(10);
        expect(after).toEqual([]);
    });

    it("ackDirty on empty list is a no-op", async () => {
        await expect(storage.ackDirty([])).resolves.toBeUndefined();
    });

    it("drainDirty on an empty queue returns []", async () => {
        const out = await storage.drainDirty(10);
        expect(out).toEqual([]);
    });

    it("preserves complex JSON payloads (numbers, booleans, nested)", async () => {
        const payload = { bpm: 124.5, isProcessed: true, fields: { key: "8A", energy: 7 } };
        storage.enqueue(change({ payload }));
        const out = await storage.drainDirty(10);
        expect(out[0].payload).toEqual(payload);
    });
});

describe("SqliteSyncStorage — applyRemote", () => {
    it("does not throw on any known entity (stubs swallow + log)", async () => {
        for (const entity of ["tracks", "playlists", "cuepoints", "tags", "track_tags", "playlist_tracks"] as const) {
            await expect(
                storage.applyRemote({ ...change({ entity }), id: 1 } as SyncChange & { id: number }),
            ).resolves.not.toThrow();
        }
    });

    it("logs and continues when applyRemote receives an unknown entity", async () => {
        const seen: string[] = [];
        const s = new SqliteSyncStorage(new Database(":memory:"), {
            seed: { apiUrl: "u", deviceToken: "t" },
            logger: (msg) => { seen.push(msg); },
        });
        await s.applyRemote({
            id: 1, entity: "unknown" as never, entityId: "x", op: "upsert", payload: {}, updatedAt: "z",
        });
        expect(seen.some((m) => m.includes("unknown entity"))).toBe(true);
    });
});
