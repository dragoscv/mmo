/**
 * Tests for the companion's CloudSyncClient transport.
 *
 * We don't depend on a real SQLite or the cloud here — `SyncStorage` is
 * an abstract interface, so a tiny in-memory fake gives us deterministic
 * coverage for the push/pull/cursor logic.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CloudSyncClient, type SyncChange, type SyncState, type SyncStorage } from "./cloud-sync-client";

class FakeStorage implements SyncStorage {
    state: SyncState = {
        apiUrl: "https://example.test",
        deviceToken: "tok",
        lastPullCursor: 0,
    };
    queue: Array<SyncChange & { _queueId: number }> = [];
    private nextId = 1;
    applied: Array<SyncChange & { id: number }> = [];
    ackCalls: number[][] = [];

    enqueue(c: SyncChange) {
        this.queue.push({ ...c, _queueId: this.nextId++ });
    }

    async load() { return this.state; }
    async save(s: SyncState) { this.state = s; }
    async drainDirty(limit: number) {
        // Peek only — mirrors the real SQLite implementation.
        return this.queue.slice(0, limit);
    }
    async ackDirty(ids: number[]) {
        this.ackCalls.push(ids);
        const set = new Set(ids);
        this.queue = this.queue.filter((c) => !set.has(c._queueId));
    }
    async applyRemote(c: SyncChange & { id: number }) { this.applied.push(c); }
}

const ORIGINAL_FETCH = globalThis.fetch;

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = ORIGINAL_FETCH;
});

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
    globalThis.fetch = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        return handler(typeof input === "string" ? input : input.toString(), init);
    }) as typeof fetch;
}

describe("CloudSyncClient", () => {
    it("does nothing when there are no dirty changes and no remote pages", async () => {
        const storage = new FakeStorage();
        mockFetch(() => new Response(JSON.stringify({ changes: [], nextCursor: 0, hasMore: false }), { status: 200 }));
        const client = new CloudSyncClient(storage);
        const r = await client.tick();
        expect(r).toEqual({ pushed: 0, pulled: 0 });
    });

    it("pushes queued changes with bearer auth and clears the queue", async () => {
        const storage = new FakeStorage();
        storage.enqueue({
            entity: "tracks",
            entityId: "abc",
            op: "upsert",
            payload: { title: "X" },
            updatedAt: new Date().toISOString(),
        });
        const seen: { url: string; auth?: string; body?: string }[] = [];
        mockFetch((url, init) => {
            seen.push({
                url,
                auth: (init?.headers as Record<string, string> | undefined)?.authorization,
                body: typeof init?.body === "string" ? init.body : undefined,
            });
            if (init?.method === "POST") {
                return new Response(JSON.stringify({ ok: true, applied: 1 }), { status: 200 });
            }
            return new Response(JSON.stringify({ changes: [], nextCursor: 0, hasMore: false }), { status: 200 });
        });

        const client = new CloudSyncClient(storage);
        const r = await client.tick();
        expect(r.pushed).toBe(1);
        expect(storage.queue).toHaveLength(0);
        const post = seen.find((s) => s.url.endsWith("/api/sync") && s.body);
        expect(post?.auth).toBe("Bearer tok");
        expect(post?.body).toContain("\"entity\":\"tracks\"");
    });

    it("pulls multiple pages and advances the cursor", async () => {
        const storage = new FakeStorage();
        let call = 0;
        mockFetch((url, init) => {
            if (init?.method === "POST") {
                return new Response(JSON.stringify({ ok: true }), { status: 200 });
            }
            call++;
            if (call === 1) {
                return new Response(JSON.stringify({
                    changes: [{ id: 1, entity: "tracks", entityId: "a", op: "upsert", payload: {}, updatedAt: "x" }],
                    nextCursor: 1,
                    hasMore: true,
                }), { status: 200 });
            }
            return new Response(JSON.stringify({
                changes: [{ id: 2, entity: "tracks", entityId: "b", op: "upsert", payload: {}, updatedAt: "y" }],
                nextCursor: 2,
                hasMore: false,
            }), { status: 200 });
        });
        const client = new CloudSyncClient(storage);
        const r = await client.tick();
        expect(r.pulled).toBe(2);
        expect(storage.applied.map((a) => a.entityId)).toEqual(["a", "b"]);
        expect(storage.state.lastPullCursor).toBe(2);
    });

    it("surfaces server errors as thrown Error", async () => {
        const storage = new FakeStorage();
        storage.enqueue({
            entity: "tracks", entityId: "a", op: "upsert", payload: {}, updatedAt: "x",
        });
        mockFetch(() => new Response(JSON.stringify({ error: "paywall" }), { status: 402 }));
        const client = new CloudSyncClient(storage);
        await expect(client.tick()).rejects.toThrow(/push failed: 402/);
    });

    it("preserves the queue when push fails (no data loss on network drop)", async () => {
        const storage = new FakeStorage();
        storage.enqueue({
            entity: "tracks", entityId: "abc", op: "upsert", payload: { title: "X" }, updatedAt: "x",
        });
        mockFetch((_url, init) => {
            if (init?.method === "POST") return new Response("boom", { status: 500 });
            return new Response(JSON.stringify({ changes: [], nextCursor: 0, hasMore: false }), { status: 200 });
        });
        const client = new CloudSyncClient(storage);
        await expect(client.tick()).rejects.toThrow(/push failed: 500/);
        // The queue MUST still hold the change so the next tick retries.
        expect(storage.queue).toHaveLength(1);
        expect(storage.ackCalls).toEqual([]);
    });

    it("acks the queue only after a successful push", async () => {
        const storage = new FakeStorage();
        storage.enqueue({ entity: "tracks", entityId: "a", op: "upsert", payload: {}, updatedAt: "x" });
        storage.enqueue({ entity: "tracks", entityId: "b", op: "upsert", payload: {}, updatedAt: "y" });
        mockFetch((_url, init) => {
            if (init?.method === "POST") return new Response(JSON.stringify({ ok: true }), { status: 200 });
            return new Response(JSON.stringify({ changes: [], nextCursor: 0, hasMore: false }), { status: 200 });
        });
        const client = new CloudSyncClient(storage);
        const r = await client.tick();
        expect(r.pushed).toBe(2);
        expect(storage.queue).toHaveLength(0);
        expect(storage.ackCalls).toHaveLength(1);
        expect(storage.ackCalls[0]).toHaveLength(2);
    });

    it("ignores re-entrant ticks while one is in flight", async () => {
        const storage = new FakeStorage();
        // Block the first network call indefinitely so tick #1 stays in flight.
        const blocker = new Promise<Response>(() => { /* never resolves */ });
        let calls = 0;
        mockFetch(() => {
            calls++;
            if (calls === 1) return blocker;
            return new Response(JSON.stringify({ changes: [], nextCursor: 0, hasMore: false }), { status: 200 });
        });
        const client = new CloudSyncClient(storage);
        const t1 = client.tick();
        // Yield enough microtasks for tick #1 to reach `await fetch(...)` and
        // therefore set inFlight=true before we start tick #2.
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        const t2 = await client.tick();
        expect(t2).toEqual({ pushed: 0, pulled: 0 });
        // Number of fetch invocations must be exactly 1 — t2 short-circuited.
        expect(calls).toBe(1);
        // Don't await t1; it intentionally never resolves.
        void t1;
    });
});
