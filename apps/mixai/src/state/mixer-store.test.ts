// Run: cd apps/mixai; node --test "src/**/*.test.ts"
import { test } from "node:test";
import assert from "node:assert/strict";
import { shareDecks, snapshotPatch, useMixerStore } from "./mixer-store.ts";
import type { DeckState, MixerState } from "../bridge/types.ts";

/** A fresh snapshot the way the engine sends it: new objects and arrays every time. */
function snap(over: Partial<Record<"a" | "b", Partial<DeckState>>> = {}, mixer: Partial<MixerState> = {}): MixerState {
    const base = useMixerStore.getInitialState();
    return {
        crossfader: 0,
        crossfaderCurve: "smooth",
        masterVolume: 0.85,
        cueVolume: 0.7,
        masterVu: 0,
        sampleRate: 48000,
        latencyMs: 10,
        dspLoad: 0,
        overruns: 0,
        ...mixer,
        decks: base.decks.map((d) => ({ ...d, hotCues: [...d.hotCues], stemGains: [...d.stemGains], ...(over[d.id as "a" | "b"] ?? {}) })),
    };
}

test("an identical snapshot keeps every deck object and the array itself", () => {
    const prev = snap().decks;
    const next = snap().decks;
    assert.notEqual(prev[0], next[0]); // the engine really sends new objects
    assert.equal(shareDecks(prev, next), prev);
});

test("only the deck that changed gets a new object", () => {
    const prev = snap().decks;
    const out = shareDecks(prev, snap({ a: { position: 12.5, playing: true } }).decks);
    assert.notEqual(out, prev);
    assert.notEqual(out[0], prev[0]);
    assert.equal(out[0]!.position, 12.5);
    assert.equal(out[1], prev[1]);
    assert.equal(out[2], prev[2]);
    assert.equal(out[3], prev[3]);
});

test("a change inside an array field (hot cue, stem gain) is a change", () => {
    const prev = snap().decks;
    const cues = [null, 4.2, null, null, null, null, null, null];
    assert.notEqual(shareDecks(prev, snap({ b: { hotCues: cues } }).decks)[1], prev[1]);
    assert.notEqual(shareDecks(prev, snap({ b: { stemGains: [1, 0, 1, 1] } }).decks)[1], prev[1]);
});

test("snapshotPatch carries only what changed, and null when nothing did", () => {
    const prev = snap();
    assert.equal(snapshotPatch(prev, snap()), null);
    const p = snapshotPatch(prev, snap({}, { masterVu: 0.4 }));
    assert.deepEqual(p, { masterVu: 0.4 });
    const q = snapshotPatch(prev, snap({ a: { vu: 0.3 } }));
    assert.deepEqual(Object.keys(q!), ["decks"]);
});

test("hydrate does not notify subscribers for an unchanged snapshot", () => {
    const store = useMixerStore;
    store.getState().hydrate(snap());
    let calls = 0;
    const off = store.subscribe(() => calls++);
    const deckA = store.getState().deck("a");
    store.getState().hydrate(snap());
    store.getState().hydrate(snap());
    assert.equal(calls, 0);
    assert.equal(store.getState().deck("a"), deckA);
    store.getState().hydrate(snap({ a: { position: 1 } }));
    assert.equal(calls, 1);
    assert.notEqual(store.getState().deck("a"), deckA);
    assert.equal(store.getState().hydrated, true);
    off();
});
