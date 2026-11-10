// Run: cd apps/mixai; node --test "src/**/*.test.ts"
//
// Covers the two invariants of the grid store (WP19-37 review P1-12 / P1-13):
// a loaded track never inherits the previous track's markers, and an edit the engine
// rejects is rolled back instead of lingering as state the engine never accepted.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
    deckGridOr,
    gridActions,
    resetDeckGrid,
    setGridBridge,
    useGridStore,
    type GridBridge,
} from "./grid-store.ts";
import { gridFromDeck, type GridModel } from "./markers.ts";

type Sent = { deck: string; bpm: number; firstBeat: number; markers: { sec: number; bpm: number }[]; fixed?: boolean };

/** Bridge that records what crossed IPC and can be told to reject. */
function fakeBridge(): GridBridge & { sent: Sent[]; reject: string | null } {
    const b = {
        sent: [] as Sent[],
        reject: null as string | null,
        async setGridMarkers(deck: string, req: Omit<Sent, "deck">) {
            if (b.reject) throw new Error(b.reject);
            b.sent.push({ deck, ...req });
            return null;
        },
    };
    return b as GridBridge & { sent: Sent[]; reject: string | null };
}

const base = (): GridModel => gridFromDeck(120, 0.5);

let bridge = fakeBridge();

beforeEach(() => {
    useGridStore.setState({ grids: {}, errors: {} });
    bridge = fakeBridge();
    setGridBridge(bridge);
});

// ── P1-12: reset and seed on track load ──────────────────────────────────────

test("a deck's grid is keyed by track: a new track never shows the previous one's markers", async () => {
    await gridActions.addAtPlayhead("a", "track-1", base(), 16.5);
    assert.equal(useGridStore.getState().grids.a?.grid.markers.length, 1, "edited track-1");

    // The deck now holds track-2: the old grid must not be read…
    assert.equal(useGridStore.getState().grids.a?.trackId, "track-1");
    assert.equal(deckGridOr("a", "track-2", 128, 0).markers.length, 0, "stale grid is not reused");
    // …and the fallback for the *new* track is the new track's constant grid.
    assert.equal(deckGridOr("a", "track-2", 128, 0).bpm, 128);
    // The grid of the track that was actually edited is still there.
    assert.equal(deckGridOr("a", "track-1", 128, 0).markers.length, 1);
});

test("resetDeckGrid clears the deck, and seeds the new track's constant grid", () => {
    useGridStore.getState().setGrid("a", "track-1", { bpm: 120, firstBeat: 0.5, markers: [{ sec: 10, bpm: 128 }], fixed: false });
    useGridStore.setState((s) => ({ errors: { ...s.errors, a: "boom" } }));

    resetDeckGrid("a", "track-2", gridFromDeck(128, 0));
    const entry = useGridStore.getState().grids.a;
    assert.equal(entry?.trackId, "track-2");
    assert.equal(entry?.grid.markers.length, 0, "seeded grid has no markers");
    assert.equal(entry?.grid.bpm, 128);
    assert.equal(useGridStore.getState().errors.a, undefined, "a load clears the stale error");

    // Without a seed the deck is emptied (unknown BPM: the editor falls back to the snapshot).
    resetDeckGrid("a", null);
    assert.equal(useGridStore.getState().grids.a, undefined);
});

test("an edit after a load sends only the new track's grid to the engine", async () => {
    await gridActions.addAtPlayhead("a", "track-1", base(), 16.5);
    bridge.sent.length = 0;

    resetDeckGrid("a", "track-2", gridFromDeck(128, 0));
    await gridActions.toggleFixed("a", "track-2", gridFromDeck(128, 0));

    assert.equal(bridge.sent.length, 1);
    assert.deepEqual(bridge.sent[0]!.markers, [], "no markers from the previous track");
    assert.equal(bridge.sent[0]!.bpm, 128);
});

test("both engine load paths reset the deck's grid", async () => {
    // The bridge is the engine module itself; import it lazily so the store keeps the fake.
    const { engine } = await import("../bridge/engine.ts");
    setGridBridge(bridge); // engine.ts installs itself on import — put the fake back.

    useGridStore.getState().setGrid("a", "old", { bpm: 120, firstBeat: 0, markers: [{ sec: 8, bpm: 130 }], fixed: false });
    await engine.loadTrack({ deck: "a", source: "x.mp3", trackId: "new", bpm: 124 });
    assert.equal(useGridStore.getState().grids.a?.trackId, "new");
    assert.equal(useGridStore.getState().grids.a?.grid.markers.length, 0);
    assert.equal(useGridStore.getState().grids.a?.grid.bpm, 124);

    useGridStore.getState().setGrid("b", "old", { bpm: 120, firstBeat: 0, markers: [{ sec: 8, bpm: 130 }], fixed: false });
    await engine.loadTrackStream({ deck: "b", trackId: 42, bpm: 126 });
    assert.equal(useGridStore.getState().grids.b?.trackId, "42");
    assert.equal(useGridStore.getState().grids.b?.grid.markers.length, 0);
});

// ── P1-13: optimistic IPC is rolled back ─────────────────────────────────────

test("an accepted edit stays, and is what crossed IPC", async () => {
    const after = await gridActions.addAtPlayhead("a", "t", base(), 16.5);
    assert.equal(after.markers.length, 1);
    assert.equal(bridge.sent.length, 1);
    assert.deepEqual(bridge.sent[0]!.markers, after.markers);
    assert.equal(useGridStore.getState().errors.a, undefined);
});

test("a rejected edit is rolled back and surfaced, it does not linger in the store", async () => {
    await gridActions.addAtPlayhead("a", "t", base(), 16.5);
    const accepted = useGridStore.getState().grids.a!.grid;

    bridge.reject = "deck_set_grid_markers: bpm out of range";
    const after = await gridActions.retune("a", "t", base(), 0, 300);

    assert.deepEqual(after, accepted, "the call resolves with the grid the engine accepted");
    assert.deepEqual(useGridStore.getState().grids.a!.grid, accepted, "store rolled back");
    assert.match(useGridStore.getState().errors.a!, /bpm out of range/);
});

test("a rejected first edit leaves the deck with no grid at all", async () => {
    bridge.reject = "nope";
    await gridActions.toggleFixed("a", "t", base());
    assert.equal(useGridStore.getState().grids.a, undefined, "nothing was ever accepted");
    assert.equal(useGridStore.getState().errors.a, "nope");

    // The next successful edit clears the error.
    bridge.reject = null;
    await gridActions.toggleFixed("a", "t", base());
    assert.equal(useGridStore.getState().errors.a, undefined);
    assert.equal(useGridStore.getState().grids.a?.grid.fixed, true);
});

test("the error is readable: trimmed, never empty, and dismissable", async () => {
    bridge.reject = "x".repeat(500);
    await gridActions.toggleFixed("a", "t", base());
    const msg = useGridStore.getState().errors.a!;
    assert.ok(msg.length <= 200 && msg.endsWith("…"), `truncated, got ${msg.length}`);

    useGridStore.getState().dismissError("a");
    assert.equal(useGridStore.getState().errors.a, undefined);
});

test("a late rejection does not clobber a newer edit", async () => {
    let release: (() => void) | null = null;
    const slow: GridBridge = {
        setGridMarkers: () =>
            new Promise((_, rej) => {
                release = () => rej(new Error("late"));
            }),
    };
    setGridBridge(slow);
    const pending = gridActions.addAtPlayhead("a", "t", base(), 16.5);

    // A second edit lands (through a bridge that accepts) before the first rejects.
    setGridBridge(bridge);
    await gridActions.toggleFixed("a", "t", base());
    const newest = useGridStore.getState().grids.a!.grid;

    release!();
    await pending;
    assert.deepEqual(useGridStore.getState().grids.a!.grid, newest, "newest edit survives the late rejection");
});

test("without an engine (design mode) the edit is simply kept", async () => {
    setGridBridge(null);
    const after = await gridActions.addAtPlayhead("a", "t", base(), 16.5);
    assert.equal(after.markers.length, 1);
    assert.equal(useGridStore.getState().grids.a?.grid.markers.length, 1);
    assert.equal(useGridStore.getState().errors.a, undefined);
});

test("nearest() ignores a grid belonging to another track", async () => {
    await gridActions.addAtPlayhead("a", "t1", base(), 16.5);
    const at = useGridStore.getState().grids.a!.grid.markers[0]!.sec;
    assert.equal(gridActions.nearest("a", "t1", base(), at, 0.2), 0);
    assert.equal(gridActions.nearest("a", "t2", base(), at, 0.2), -1);
});
