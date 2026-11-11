// Run: cd apps/mixai; node --test src/state/wave-sync.test.ts
//
// Review P1-5 / P2-13: the band waves must follow the track the ENGINE reports, also in a window
// that did not load it (a pop-out has its own store), and a fetch asked for while another one
// is in flight must not be dropped.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { DeckId, MixerState } from "../bridge/types.ts";
import { useMixerStore } from "./mixer-store.ts";
import { startWaveSync, useWaveStore } from "./wave-store.ts";

/** Wire form of a one-point wave whose low lane holds `tag` (so a test can tell waves apart). */
function wave(tag: number): ArrayBuffer {
    return new Uint8Array([150, 0, 0, 0, 1, 0, 0, 0, tag, 0, 0]).buffer;
}

/** Engine double: answers `deck_waveform_bands` when the test says so. */
function fakeEngine() {
    const pending: { deck: DeckId; resolve: (buf: ArrayBuffer | null) => void }[] = [];
    return {
        pending,
        calls: 0,
        fetch(deck: DeckId): Promise<ArrayBuffer | null> {
            this.calls += 1;
            return new Promise((resolve) => pending.push({ deck, resolve }));
        },
        /** Answer the oldest open fetch. */
        answer(tag: number): void {
            const p = pending.shift();
            assert.ok(p, "no fetch is open");
            p.resolve(wave(tag));
        },
    };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/** An engine snapshot: the current state with deck `a` changed. */
function snapshot(patch: Partial<MixerState["decks"][number]>): void {
    const s = useMixerStore.getState();
    s.hydrate({ ...s, decks: s.decks.map((d) => (d.id === "a" ? { ...d, ...patch } : { ...d })) });
}

const initial = useMixerStore.getState();
let stop: (() => void) | null = null;

beforeEach(() => {
    stop?.();
    stop = null;
    useMixerStore.setState({ decks: initial.decks, waveforms: initial.waveforms });
    useWaveStore.setState({ bands: { a: null, b: null, c: null, d: null } });
});

test("a window that did not load the track refetches when the engine reports another track", async () => {
    const eng = fakeEngine();
    snapshot({ loaded: true, trackId: "t1" });
    stop = startWaveSync((d) => eng.fetch(d));
    assert.equal(eng.calls, 1, "a deck that is already loaded is fetched at start");
    eng.answer(1);
    await tick();
    assert.equal(useWaveStore.getState().bands.a?.trackId, "t1");

    // Another window loads t2: this one only sees the snapshot (no peaks, no loader).
    snapshot({ trackId: "t2" });
    await tick();
    assert.equal(eng.calls, 2, "the track change alone starts a fetch");
    eng.answer(2);
    await tick();
    assert.equal(useWaveStore.getState().bands.a?.trackId, "t2");
    assert.equal(useWaveStore.getState().bands.a?.low[0], 2);

    // The same snapshot again fetches nothing.
    snapshot({ position: 3 });
    await tick();
    assert.equal(eng.calls, 2);
});

test("a load in this window fetches once, when it ends, not on the optimistic metadata", async () => {
    const eng = fakeEngine();
    snapshot({ loaded: true, trackId: "t1" });
    stop = startWaveSync((d) => eng.fetch(d));
    eng.answer(1);
    await tick();

    // What the loader does: metadata, then the peaks are cleared, then the decode runs.
    useMixerStore.getState().patchDeck("a", { trackId: "t2", loaded: true });
    useMixerStore.getState().setWaveform("a", []);
    await tick();
    assert.equal(eng.calls, 1, "the engine still holds the previous track's wave");
    assert.equal(useWaveStore.getState().bands.a, null, "the old wave is cleared");
    // Engine snapshots during the decode still name the old track, then the new one.
    snapshot({ trackId: "t1" });
    snapshot({ trackId: "t2" });
    await tick();
    assert.equal(eng.calls, 1);

    useMixerStore.getState().setWaveform("a", [0.5]);
    assert.equal(eng.calls, 2);
    eng.answer(2);
    await tick();
    assert.equal(useWaveStore.getState().bands.a?.trackId, "t2");
});

test("a fetch asked for while one is in flight runs afterwards instead of being dropped", async () => {
    const eng = fakeEngine();
    snapshot({ loaded: true, trackId: "t1" });
    stop = startWaveSync((d) => eng.fetch(d));
    assert.equal(eng.calls, 1);

    // Before the first answer arrives the track changes (another window loaded t2).
    snapshot({ trackId: "t2" });
    await tick();
    assert.equal(eng.calls, 1, "one fetch at a time per deck");
    eng.answer(1); // the answer for t1: stale
    await tick();
    assert.equal(useWaveStore.getState().bands.a, null, "a wave fetched for another track is not shown");
    assert.equal(eng.calls, 2, "the dropped request is run again");
    eng.answer(2);
    await tick();
    assert.equal(useWaveStore.getState().bands.a?.trackId, "t2");
    assert.equal(useWaveStore.getState().bands.a?.low[0], 2);
});

test("after stop nothing is fetched or stored", async () => {
    const eng = fakeEngine();
    snapshot({ loaded: true, trackId: "t1" });
    const off = startWaveSync((d) => eng.fetch(d));
    off();
    eng.answer(1);
    snapshot({ trackId: "t2" });
    await tick();
    assert.equal(eng.calls, 1);
    assert.equal(useWaveStore.getState().bands.a, null);
});
