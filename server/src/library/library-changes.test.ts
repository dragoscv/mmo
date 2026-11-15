/**
 * Route tests for the library change feed (favourites / cues / grids / crates),
 * run against a REAL SQLite file.
 *
 * They walk the conflict table of `docs/decks/crate-sync-design.md` §5 — the
 * "Done means" of phase 1 — plus the crate-entry ordering: a losing hot cue
 * becomes a memory cue labelled with its old slot, entries the phone adds and
 * the laptop reorders both survive, the crate trash is order-independent
 * against a concurrent add, and the cue relay to the cloud lands in the sync
 * queue with the loop end.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import http from "node:http";
import fs from "node:fs";
import express from "express";

vi.mock("../store", () => ({
    getSettings: () => ({ scanFolders: [], autoAnalyzeOnScan: false }),
    updateSettings: () => undefined,
    store: { get: () => undefined, set: () => undefined },
}));
// The library DB is opened at IMPORT time (`analyzer-store` builds its store at
// module load), i.e. before any module-level `const` of this file is
// initialised — so the mocked path must be built inside the factory from
// globals only (`process`), never read from a binding declared here.
vi.mock("../platform", () => ({
    platform: {
        getPath: () => process.env.MIXAI_TEST_DATA
            || `${process.env.TEMP ?? process.env.TMP ?? "/tmp"}/mixai-crate-sync-library-changes`,
        isElectron: false,
    },
}));
const dataDirOf = () => process.env.MIXAI_TEST_DATA
    || `${process.env.TEMP ?? process.env.TMP ?? "/tmp"}/mixai-crate-sync-library-changes`;

import { createLibraryRouter } from "./routes";
import { getLibraryDb, getLibrarySqlite } from "./db";
import { tracks, playlists } from "./schema";
import { pruneTombstones } from "./sync-changes";

/** Unique per process so a leftover DB from a previous run can never collide. */
const RUN = `${process.pid}-${Date.now()}`;

let server: http.Server;
let base = "";
let userSeq = 0;
let trackSeq = 0;
let currentUser = "";
const announcements: Array<{ userId: string; rev: number }> = [];

const newUser = () => (currentUser = `user-${RUN}-${++userSeq}`);
/** Entity id scoped to the current user. `track_cues.id` and entry ids are
 *  globally-unique device UUIDs (the design's rule), so two users must never
 *  share one — a literal reused across tests would collide on the primary key. */
const cid = (suffix: string) => `${currentUser}:${suffix}`;

beforeAll(async () => {
    const app = express();
    app.use(express.json({ limit: "2mb" }));
    app.use("/library", createLibraryRouter(
        (req, res, next) => {
            if (req.headers["x-device-token"] === "tok") next();
            else res.status(401).json({ error: "Unauthorized" });
        },
        { onChanged: (userId, rev) => { announcements.push({ userId, rev }); } },
    ));
    // Surface route errors as JSON so a failure names its cause instead of
    // returning Express's HTML error page.
    app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        res.status(500).json({ error: err?.message ?? String(err), stack: err?.stack });
    });
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/library`;
});

afterAll(async () => {
    server?.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    try { fs.rmSync(dataDirOf(), { recursive: true, force: true }); } catch { /* best-effort */ }
});

function seedTrack(userId: string, extra: Record<string, unknown> = {}) {
    const db = getLibraryDb();
    return db.insert(tracks).values({
        userId,
        filepath: `/music/${RUN}-${++trackSeq}.mp3`,
        filename: `t${trackSeq}.mp3`,
        title: `T${trackSeq}`,
        ...extra,
    }).returning().get()!;
}

function headers(userId: string, deviceId: string) {
    return {
        "content-type": "application/json",
        "x-device-token": "tok",
        "x-user-id": userId,
        "x-device-id": deviceId,
    };
}

async function post(userId: string, changes: unknown[], deviceId = "dev-a") {
    const r = await fetch(`${base}/changes`, { method: "POST", headers: headers(userId, deviceId), body: JSON.stringify({ changes }) });
    const text = await r.text();
    if (!r.ok) throw new Error(`POST /changes -> ${r.status}: ${text.slice(0, 600)}`);
    return { status: r.status, body: JSON.parse(text) as { rev: number; results: Array<{ index: number; status: string; reason?: string; rev?: number }>; errors: unknown[] } };
}

async function pull(userId: string, since = 0) {
    const r = await fetch(`${base}/changes?since=${since}`, { headers: headers(userId, "dev-a") });
    const text = await r.text();
    if (!r.ok) throw new Error(`GET /changes -> ${r.status}: ${text.slice(0, 600)}`);
    return JSON.parse(text) as {
        rev: number; reset: boolean;
        tracks: Array<{ trackId: number; isFavorite: boolean; rev: number }>;
        cues: Array<{ id: string; trackId: number; kind: string; slot: number | null; startMs: number; endMs: number | null; label: string | null }>;
        grids: Array<{ trackId: number; bpm: number; firstBeatMs: number }>;
        crates: Array<{ externalId: string; name: string; rev: number }>;
        crateEntries: Array<{ entryId: string; crateExternalId: string; trackId: number; sortKey: string | null }>;
        tombstones: Array<{ entity: string; entityId: string; rev: number }>;
    };
}

const T = 1_700_000_000_000; // a fixed past instant — never cut to "now"

const cueChange = (entityId: string, startMs: number, over: Record<string, unknown> = {}) => ({
    entity: "cue", entityId, op: "upsert", changedAt: T + 1000,
    payload: { trackId: 1, kind: "hot", slot: 0, startMs, ...over },
});

describe("favourites", () => {
    it("later change wins, equal times break by device id", async () => {
        const u = newUser();
        const t = seedTrack(u);
        await post(u, [{ entity: "favorite", entityId: String(t.id), op: "upsert", changedAt: T + 1000, payload: { isFavorite: true } }], "dev-a");
        let feed = await pull(u);
        expect(feed.tracks.find((x) => x.trackId === t.id)?.isFavorite).toBe(true);

        // A later clear from another device wins.
        await post(u, [{ entity: "favorite", entityId: String(t.id), op: "upsert", changedAt: T + 2000, payload: { isFavorite: false } }], "dev-b");
        feed = await pull(u);
        expect(feed.tracks.find((x) => x.trackId === t.id)?.isFavorite).toBe(false);

        // Same clock: the lexicographically larger device id wins.
        await post(u, [{ entity: "favorite", entityId: String(t.id), op: "upsert", changedAt: T + 5000, payload: { isFavorite: true } }], "dev-a");
        const r = await post(u, [{ entity: "favorite", entityId: String(t.id), op: "upsert", changedAt: T + 5000, payload: { isFavorite: false } }], "dev-a");
        expect(r.body.results[0]!.status).toBe("superseded");
        feed = await pull(u);
        expect(feed.tracks.find((x) => x.trackId === t.id)?.isFavorite).toBe(true);
    });

    it("PUT is idempotent: a retry with the same value does not move the revision", async () => {
        const u = newUser();
        const t = seedTrack(u);
        const put = (favorite: boolean) => fetch(`${base}/tracks/${t.id}/favorite`, {
            method: "PUT", headers: headers(u, "dev-a"), body: JSON.stringify({ favorite }),
        });
        const a = await (await put(true)).json() as { rev: number; isFavorite: boolean };
        const b = await (await put(true)).json() as { rev: number; isFavorite: boolean };
        expect(a.isFavorite).toBe(true);
        expect(b.rev).toBe(a.rev);
        expect((await put(false)).status).toBe(200);
    });
});

describe("cues", () => {
    it("different cues of one track changed on two devices are both kept", async () => {
        const u = newUser();
        const t = seedTrack(u);
        await post(u, [{ ...cueChange(cid("cue-a"), 1000), payload: { trackId: t.id, kind: "hot", slot: 1, startMs: 1000 } }], "dev-a");
        await post(u, [{ ...cueChange(cid("cue-b"), 2000), payload: { trackId: t.id, kind: "hot", slot: 2, startMs: 2000 } }], "dev-b");
        const feed = await pull(u);
        expect(feed.cues.map((c) => c.id).sort()).toEqual([cid("cue-a"), cid("cue-b")].sort());
    });

    it("the same cue changed on two devices: the later change wins", async () => {
        const u = newUser();
        const t = seedTrack(u);
        await post(u, [{ entity: "cue", entityId: cid("cue-1"), op: "upsert", changedAt: T + 1000, payload: { trackId: t.id, kind: "memory", startMs: 5000 } }], "dev-a");
        await post(u, [{ entity: "cue", entityId: cid("cue-1"), op: "upsert", changedAt: T + 2000, payload: { trackId: t.id, kind: "memory", startMs: 9000 } }], "dev-b");
        await post(u, [{ entity: "cue", entityId: cid("cue-1"), op: "upsert", changedAt: T + 1500, payload: { trackId: t.id, kind: "memory", startMs: 1111 } }], "dev-a");
        const feed = await pull(u);
        expect(feed.cues).toHaveLength(1);
        expect(feed.cues[0]!.startMs).toBe(9000);
    });

    it("two cues claim one hot slot: the later keeps it, the earlier becomes a memory cue labelled with its slot", async () => {
        const u = newUser();
        const t = seedTrack(u);
        await post(u, [{ entity: "cue", entityId: cid("cue-old"), op: "upsert", changedAt: T + 1000, payload: { trackId: t.id, kind: "hot", slot: 3, startMs: 1000 } }], "dev-a");
        const r = await post(u, [{ entity: "cue", entityId: cid("cue-new"), op: "upsert", changedAt: T + 2000, payload: { trackId: t.id, kind: "hot", slot: 3, startMs: 2000 } }], "dev-b");
        expect(r.body.results[0]!.status).toBe("applied");

        const feed = await pull(u);
        const old = feed.cues.find((c) => c.id === cid("cue-old"))!;
        const fresh = feed.cues.find((c) => c.id === cid("cue-new"))!;
        expect(fresh.kind).toBe("hot");
        expect(fresh.slot).toBe(3);
        expect(old.kind).toBe("memory");
        expect(old.slot).toBeNull();
        expect(old.label).toBe("Hot 4"); // slot 3 is the fourth hot cue
        // Nothing was dropped: both cues still exist.
        expect(feed.cues).toHaveLength(2);
    });

    it("the losing cue keeps its own label when it had one", async () => {
        const u = newUser();
        const t = seedTrack(u);
        await post(u, [{ entity: "cue", entityId: cid("c1"), op: "upsert", changedAt: T + 1000, payload: { trackId: t.id, kind: "hot", slot: 0, startMs: 1000, label: "Drop" } }], "dev-a");
        await post(u, [{ entity: "cue", entityId: cid("c2"), op: "upsert", changedAt: T + 2000, payload: { trackId: t.id, kind: "hot", slot: 0, startMs: 2000 } }], "dev-b");
        const feed = await pull(u);
        const loser = feed.cues.find((c) => c.id === cid("c1"))!;
        expect(loser.kind).toBe("memory");
        expect(loser.label).toBe("Drop");
    });

    it("a cue deleted on A but edited LATER on B comes back", async () => {
        const u = newUser();
        const t = seedTrack(u);
        await post(u, [{ entity: "cue", entityId: cid("cue-1"), op: "upsert", changedAt: T + 1000, payload: { trackId: t.id, kind: "memory", startMs: 3000 } }], "dev-a");
        // An OLDER delete loses to the edit (equal times would break to dev-b).
        await post(u, [{ entity: "cue", entityId: cid("cue-1"), op: "delete", changedAt: T + 500, payload: null }], "dev-b");
        let feed = await pull(u);
        expect(feed.cues.map((c) => c.id)).toEqual([cid("cue-1")]);

        await post(u, [{ entity: "cue", entityId: cid("cue-1"), op: "upsert", changedAt: T + 3000, payload: { trackId: t.id, kind: "memory", startMs: 7000 } }], "dev-b");
        feed = await pull(u);
        expect(feed.cues).toHaveLength(1);
        expect(feed.cues[0]!.startMs).toBe(7000);
    });

    it("a cue edited on A but deleted LATER on B is gone (tombstone)", async () => {
        const u = newUser();
        const t = seedTrack(u);
        await post(u, [{ entity: "cue", entityId: cid("cue-1"), op: "upsert", changedAt: T + 1000, payload: { trackId: t.id, kind: "memory", startMs: 3000 } }], "dev-a");
        await post(u, [{ entity: "cue", entityId: cid("cue-1"), op: "delete", changedAt: T + 2000, payload: null }], "dev-b");
        const feed = await pull(u);
        expect(feed.cues).toHaveLength(0);
        expect(feed.tombstones.some((x) => x.entity === "cue" && x.entityId === cid("cue-1"))).toBe(true);
    });

    it("a loop is one row with an end", async () => {
        const u = newUser();
        const t = seedTrack(u);
        await post(u, [{ entity: "cue", entityId: cid("loop-1"), op: "upsert", changedAt: T + 1000, payload: { trackId: t.id, kind: "loop", startMs: 1000, endMs: 9000 } }], "dev-a");
        const feed = await pull(u);
        expect(feed.cues[0]).toMatchObject({ kind: "loop", startMs: 1000, endMs: 9000, slot: null });
    });

    it("a track the server does not have leaves the cue waiting (unknown, not applied)", async () => {
        const u = newUser();
        const r = await post(u, [{ entity: "cue", entityId: cid("ghost"), op: "upsert", changedAt: T + 1000, payload: { trackId: 999999, kind: "hot", slot: 0, startMs: 1 } }], "dev-a");
        expect(r.body.results[0]!.status).toBe("unknown");
        const feed = await pull(u);
        expect(feed.cues).toHaveLength(0);
    });
});

describe("grids", () => {
    it("the later grid wins as a whole", async () => {
        const u = newUser();
        const t = seedTrack(u);
        await post(u, [{ entity: "grid", entityId: String(t.id), op: "upsert", changedAt: T + 1000, payload: { bpm: 128, firstBeatMs: 100 } }], "dev-a");
        await post(u, [{ entity: "grid", entityId: String(t.id), op: "upsert", changedAt: T + 2000, payload: { bpm: 124, firstBeatMs: 250 } }], "dev-b");
        await post(u, [{ entity: "grid", entityId: String(t.id), op: "upsert", changedAt: T + 1500, payload: { bpm: 130, firstBeatMs: 0 } }], "dev-a");
        const feed = await pull(u);
        expect(feed.grids).toHaveLength(1);
        expect(feed.grids[0]).toMatchObject({ bpm: 124, firstBeatMs: 250 });
    });
});

describe("crates and their entries", () => {
    const crate = (ext: string, name: string, changedAt: number, over: Record<string, unknown> = {}) => ({
        entity: "crate", entityId: cid(ext), op: "upsert", changedAt, payload: { name, ...over },
    });
    const entry = (id: string, crateExt: string, trackId: number, changedAt: number, sortKey?: string) => ({
        entity: "crate_entry", entityId: cid(id), op: "upsert", changedAt,
        payload: { crateExternalId: cid(crateExt), trackId, ...(sortKey ? { sortKey } : {}) },
    });
    /** The ids the helpers above produced, for the expectations. */
    const eid = (id: string) => cid(id);

    it("entries come back in their order-key order", async () => {
        const u = newUser();
        const t1 = seedTrack(u);
        const t2 = seedTrack(u);
        await post(u, [crate("crate-1", "Warmup", T + 1000)], "dev-a");
        await post(u, [entry("e2", "crate-1", t2.id, T + 1000, "000000000600")], "dev-b");
        await post(u, [entry("e1", "crate-1", t1.id, T + 1000, "000000000400")], "dev-a");
        const feed = await pull(u);
        expect(feed.crateEntries.map((e) => e.entryId)).toEqual([eid("e1"), eid("e2")]);
    });

    it("an add on the phone and a reorder on the laptop both survive", async () => {
        const u = newUser();
        const t1 = seedTrack(u);
        const t2 = seedTrack(u);
        const t3 = seedTrack(u);
        await post(u, [crate("crate-1", "Warmup", T + 1000)], "dev-a");
        await post(u, [entry("e1", "crate-1", t1.id, T + 1000, "000000000400")], "dev-a");
        await post(u, [entry("e2", "crate-1", t2.id, T + 1000, "000000000600")], "dev-a");
        // The laptop moves e1 after e2, while the phone adds e3.
        await post(u, [entry("e1", "crate-1", t1.id, T + 2000, "000000000700")], "dev-b");
        await post(u, [entry("e3", "crate-1", t3.id, T + 2500, "000000000900")], "dev-c");
        const feed = await pull(u);
        expect(feed.crateEntries.map((e) => e.entryId)).toEqual([eid("e2"), eid("e1"), eid("e3")]);
    });

    it("the same entry moved twice: the later move wins", async () => {
        const u = newUser();
        const t1 = seedTrack(u);
        await post(u, [crate("crate-1", "Warmup", T + 1000)], "dev-a");
        await post(u, [entry("e1", "crate-1", t1.id, T + 1000, "000000000500")], "dev-a");
        await post(u, [entry("e1", "crate-1", t1.id, T + 3000, "000000000900")], "dev-b");
        await post(u, [entry("e1", "crate-1", t1.id, T + 2000, "000000000100")], "dev-a");
        const feed = await pull(u);
        expect(feed.crateEntries[0]!.sortKey).toBe("000000000900");
    });

    it("an entry with no order key is appended after the current tail", async () => {
        const u = newUser();
        const t1 = seedTrack(u);
        await post(u, [crate("crate-1", "Warmup", T + 1000)], "dev-a");
        await post(u, [entry("e1", "crate-1", t1.id, T + 1000, "000000000100")], "dev-a");
        await post(u, [entry("e2", "crate-1", t1.id, T + 2000)], "dev-b");
        const feed = await pull(u);
        expect(feed.crateEntries.map((e) => e.entryId)).toEqual([eid("e1"), eid("e2")]);
        expect(BigInt(feed.crateEntries[1]!.sortKey!)).toBeGreaterThan(BigInt("000000000100"));
    });

    it("a crate renamed on two devices: the later name wins", async () => {
        const u = newUser();
        await post(u, [crate("crate-1", "Warmup", T + 1000)], "dev-a");
        await post(u, [crate("crate-1", "Peak time", T + 2000)], "dev-b");
        await post(u, [crate("crate-1", "Old name", T + 1500)], "dev-a");
        const feed = await pull(u);
        expect(feed.crates[0]!.name).toBe("Peak time");
    });

    it("crate deleted on A, entry added LATER on B: the entry wins and the crate comes back", async () => {
        const u = newUser();
        const t1 = seedTrack(u);
        await post(u, [crate("crate-1", "Warmup", T + 1000)], "dev-a");
        await post(u, [{ entity: "crate", entityId: eid("crate-1"), op: "delete", changedAt: T + 2000, payload: null }], "dev-a");
        await post(u, [entry("e1", "crate-1", t1.id, T + 3000)], "dev-b");
        const feed = await pull(u);
        expect(feed.crateEntries.map((e) => e.entryId)).toEqual([eid("e1")]);
        expect(feed.crates.find((c) => c.externalId === eid("crate-1"))).toBeTruthy();
        expect(feed.tombstones.some((x) => x.entity === "crate")).toBe(false);
    });

    it("entry added on B but the crate was deleted LATER on A: the delete wins", async () => {
        const u = newUser();
        const t1 = seedTrack(u);
        await post(u, [crate("crate-1", "Warmup", T + 1000)], "dev-a");
        await post(u, [entry("e1", "crate-1", t1.id, T + 2000)], "dev-b");
        await post(u, [{ entity: "crate", entityId: eid("crate-1"), op: "delete", changedAt: T + 3000, payload: null }], "dev-a");
        const feed = await pull(u);
        expect(feed.tombstones.some((x) => x.entity === "crate" && x.entityId === eid("crate-1"))).toBe(true);
    });

    it("a manual playlist entry bumps no change-feed revision, a crate entry does", async () => {
        const u = newUser();
        const t1 = seedTrack(u);
        const db = getLibraryDb();
        const manual = db.insert(playlists).values({ userId: u, name: "Manual", type: "manual" }).returning().get()!;
        const before = (await pull(u)).rev;
        await fetch(`${base}/playlists/${manual.id}/tracks`, {
            method: "POST", headers: headers(u, "dev-a"), body: JSON.stringify({ trackIds: [t1.id] }),
        });
        expect((await pull(u)).rev).toBe(before);

        await post(u, [crate("crate-1", "Warmup", T + 1000)], "dev-a");
        await post(u, [entry("e1", "crate-1", t1.id, T + 1500)], "dev-a");
        const feed = await pull(u);
        const e = feed.crateEntries[0]!;
        expect(e.entryId).toBeTruthy();
        expect(e.sortKey).toBeTruthy();
    });
});

describe("the feed", () => {
    it("announces a new revision to the hub listener on every applied batch", async () => {
        const u = newUser();
        const t = seedTrack(u);
        announcements.length = 0;
        await post(u, [{ entity: "favorite", entityId: String(t.id), op: "upsert", changedAt: T + 1000, payload: { isFavorite: true } }], "dev-a");
        expect(announcements).toHaveLength(1);
        expect(announcements[0]!.userId).toBe(u);
        expect(announcements[0]!.rev).toBeGreaterThan(0);
    });

    it("since=0 answers the full state; a cursor below the pruned tombstones answers reset: true", async () => {
        const u = newUser();
        const t = seedTrack(u);
        await post(u, [{ entity: "cue", entityId: cid("cue-1"), op: "upsert", changedAt: T + 1000, payload: { trackId: t.id, kind: "memory", startMs: 10 } }], "dev-a");
        await post(u, [{ entity: "cue", entityId: cid("cue-1"), op: "delete", changedAt: T + 2000, payload: null }], "dev-a");
        const revAfterDelete = (await pull(u)).rev;

        const full = await pull(u, 0);
        expect(full.reset).toBe(false);

        // Prune every tombstone (retention 0) — the highest pruned revision is
        // remembered, so a cursor below it must be told to take the full state.
        const db = getLibraryDb();
        const removed = pruneTombstones(db, u, Date.now() + 1, 0);
        expect(removed).toBeGreaterThan(0);

        const stale = await pull(u, revAfterDelete - 1);
        expect(stale.reset).toBe(true);
        const fresh = await pull(u, revAfterDelete);
        expect(fresh.reset).toBe(false);
    });

    it("reports invalid changes without failing the batch, keeping the caller's indices", async () => {
        const u = newUser();
        const t = seedTrack(u);
        const r = await post(u, [
            { entity: "nope", entityId: "x", op: "upsert", changedAt: T },
            { entity: "favorite", entityId: String(t.id), op: "upsert", changedAt: T + 1000, payload: { isFavorite: true } },
        ], "dev-a");
        expect(r.body.errors).toHaveLength(1);
        expect(r.body.results).toHaveLength(1);
        expect(r.body.results[0]!.index).toBe(1);
    });
});

describe("the relay to the cloud", () => {
    it("a cue on a track with a whole-file hash lands in the sync queue with its loop end", async () => {
        const u = newUser();
        const sha = "c".repeat(64);
        const t = seedTrack(u, { sha256: sha });
        await post(u, [{ entity: "cue", entityId: cid("loop-9"), op: "upsert", changedAt: T + 1000, payload: { trackId: t.id, kind: "loop", startMs: 1200, endMs: 8400, label: "intro" } }], "dev-a");

        const sqlite = getLibrarySqlite();
        const rows = sqlite.prepare("SELECT entity, entity_id, op, payload FROM sync_queue WHERE entity = 'cuepoints' AND entity_id = ?").all(cid("loop-9")) as Array<{ entity: string; entity_id: string; op: string; payload: string }>;
        expect(rows).toHaveLength(1);
        const payload = JSON.parse(rows[0]!.payload) as Record<string, unknown>;
        expect(rows[0]!.op).toBe("upsert");
        expect(payload.trackSha256).toBe(sha);
        expect(payload.positionMs).toBe(1200);
        expect(payload.endMs).toBe(8400); // a loop is ONE row, not two
        expect(payload.kind).toBe("loop");
        expect(payload.label).toBe("intro");
    });

    it("a cue on a track without a whole-file hash is not relayed yet", async () => {
        const u = newUser();
        const t = seedTrack(u); // no sha256
        await post(u, [{ entity: "cue", entityId: cid("cue-nosha"), op: "upsert", changedAt: T + 1000, payload: { trackId: t.id, kind: "hot", slot: 0, startMs: 5 } }], "dev-a");
        const sqlite = getLibrarySqlite();
        const rows = sqlite.prepare("SELECT entity_id FROM sync_queue WHERE entity = 'cuepoints' AND entity_id = ?").all(cid("cue-nosha"));
        expect(rows).toHaveLength(0);
    });

    it("a cue delete is relayed as a tombstone to the cloud", async () => {
        const u = newUser();
        const t = seedTrack(u, { sha256: "b".repeat(64) });
        await post(u, [{ entity: "cue", entityId: cid("cue-del"), op: "upsert", changedAt: T + 1000, payload: { trackId: t.id, kind: "hot", slot: 0, startMs: 5 } }], "dev-a");
        await post(u, [{ entity: "cue", entityId: cid("cue-del"), op: "delete", changedAt: T + 2000, payload: null }], "dev-a");
        const sqlite = getLibrarySqlite();
        const rows = sqlite.prepare("SELECT op, payload FROM sync_queue WHERE entity = 'cuepoints' AND entity_id = ? ORDER BY id").all(cid("cue-del")) as Array<{ op: string; payload: string }>;
        expect(rows.map((r) => r.op)).toEqual(["upsert", "delete"]);
        expect((JSON.parse(rows[1]!.payload) as { trackSha256: string }).trackSha256).toBe("b".repeat(64));
    });
});
