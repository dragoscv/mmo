import { describe, expect, it, vi } from "vitest";
import {
    LISTEN_MIGRATED_FLAG,
    MAX_ENTRIES,
    PLAYER_STORAGE_KEY,
    migrateListenHistory,
    readLegacyHistory,
} from "./listen-history-migration";

function memStorage(seed: Record<string, string> = {}): Storage {
    const m = new Map(Object.entries(seed));
    return {
        get length() { return m.size; },
        clear: () => m.clear(),
        getItem: (k) => m.get(k) ?? null,
        key: (i) => [...m.keys()][i] ?? null,
        removeItem: (k) => { m.delete(k); },
        setItem: (k, v) => { m.set(k, String(v)); },
    };
}

const blob = (playHistory: unknown) => ({ [PLAYER_STORAGE_KEY]: JSON.stringify({ playHistory, volume: 0.8 }) });

describe("readLegacyHistory", () => {
    it("returns [] when the key is absent or malformed", () => {
        expect(readLegacyHistory(memStorage())).toEqual([]);
        expect(readLegacyHistory(memStorage({ [PLAYER_STORAGE_KEY]: "{nope" }))).toEqual([]);
        expect(readLegacyHistory(memStorage(blob("not-an-array")))).toEqual([]);
    });

    it("keeps positive integer ids, rounds durations, caps at MAX_ENTRIES", () => {
        const hist = Array.from({ length: MAX_ENTRIES + 10 }, (_, i) => ({ id: i + 1, duration: 100.6 }));
        hist.unshift({ id: -1, duration: 1 } as never, { id: "x", duration: 2 } as never, { id: 7 } as never);
        const out = readLegacyHistory(memStorage(blob(hist)));
        expect(out).toHaveLength(MAX_ENTRIES);
        expect(out[0]).toEqual({ trackId: 7, durationSec: undefined });
        expect(out[1]).toEqual({ trackId: 1, durationSec: 101 });
    });
});

describe("migrateListenHistory", () => {
    it("uploads oldest-first with source web + completed, then sets the flag", async () => {
        const storage = memStorage(blob([{ id: 3, duration: 30 }, { id: 2 }, { id: 1, duration: 10 }]));
        const record = vi.fn(async () => ({ ok: true }));
        const r = await migrateListenHistory(record, storage);
        expect(r).toEqual({ status: "done", attempted: 3, recorded: 3 });
        expect(record.mock.calls.map((c) => (c as unknown as [{ trackId: number }])[0].trackId)).toEqual([1, 2, 3]);
        expect((record.mock.calls[0] as unknown as [Record<string, unknown>])[0]).toMatchObject({ source: "web", completed: true, durationSec: 10 });
        expect(storage.getItem(LISTEN_MIGRATED_FLAG)).toBeTruthy();
    });

    it("is a no-op once the flag is set", async () => {
        const storage = memStorage({ ...blob([{ id: 1 }]), [LISTEN_MIGRATED_FLAG]: "2026-01-01" });
        const record = vi.fn(async () => ({ ok: true }));
        expect(await migrateListenHistory(record, storage)).toMatchObject({ status: "skipped" });
        expect(record).not.toHaveBeenCalled();
    });

    it("sets the flag even with an empty history (nothing to retry)", async () => {
        const storage = memStorage();
        const r = await migrateListenHistory(vi.fn(async () => ({ ok: true })), storage);
        expect(r.status).toBe("done");
        expect(storage.getItem(LISTEN_MIGRATED_FLAG)).toBeTruthy();
    });

    it("skips unknown tracks but still completes", async () => {
        const storage = memStorage(blob([{ id: 1 }, { id: 2 }]));
        const record = vi.fn(async ({ trackId }: { trackId: number }) => trackId === 1 ? { ok: false, error: "unknown-track" } : { ok: true });
        const r = await migrateListenHistory(record, storage);
        expect(r).toEqual({ status: "done", attempted: 2, recorded: 1 });
        expect(storage.getItem(LISTEN_MIGRATED_FLAG)).toBeTruthy();
    });

    it("leaves the flag unset when signed out or on a transient failure", async () => {
        const s1 = memStorage(blob([{ id: 1 }]));
        expect((await migrateListenHistory(vi.fn(async () => ({ ok: false, error: "unauthenticated" })), s1)).status).toBe("unauthenticated");
        expect(s1.getItem(LISTEN_MIGRATED_FLAG)).toBeNull();

        const s2 = memStorage(blob([{ id: 1 }]));
        expect((await migrateListenHistory(vi.fn(async () => { throw new Error("net"); }), s2)).status).toBe("failed");
        expect(s2.getItem(LISTEN_MIGRATED_FLAG)).toBeNull();
    });

    it("skips without storage (server)", async () => {
        expect(await migrateListenHistory(vi.fn(async () => ({ ok: true })), undefined)).toMatchObject({ status: "skipped" });
    });
});
