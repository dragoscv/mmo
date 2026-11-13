// Run: cd apps/mixai; node --test src/copilot/copilot-store.test.ts
//
// The co-pilot STORE with a fake engine and a fake shell ranking: what reaches the screen and
// the decks, not only what the pure helpers answer (a filter's order is lost again when the
// next stage sorts by score; an automatic load may take a row the list's reader would not).
//
// The store imports the app's stores through the "@/" alias, which only the bundler knows. A
// resolve hook maps it for this process (node --test runs every file in its own process).
// Each scenario loads a fresh instance of the store module (`?scene=N`): its own keeper, its
// own ranking memory. The mixer, performance and pool stores are shared and reset per scene.
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { copilot, type PlanInfo, type Ranked } from "../bridge/copilot.ts";
import { engine } from "../bridge/engine.ts";
import type { ClockState, DeckId, DeckState, LibraryTrack, LoadTrackRequest, MixerState } from "../bridge/types.ts";
import { useLibraryPool } from "../library/pool-store.ts";
import { useMixerStore } from "../state/mixer-store.ts";

const SRC = fileURLToPath(new URL("..", import.meta.url));
registerHooks({
    resolve(specifier, context, nextResolve) {
        if (specifier.startsWith("@/")) {
            const base = join(SRC, specifier.slice(2));
            const file = [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")].find((p) => existsSync(p));
            if (file) return { url: pathToFileURL(file).href, shortCircuit: true };
        }
        return nextResolve(specifier, context);
    },
});
// After the hook: this one imports "@/bridge/engine" (the same module instance as above).
const { usePerfStore } = await import("../state/perf-store.ts");

type Mod = typeof import("./copilot-store.ts");
const DECKS: readonly DeckId[] = ["a", "b", "c", "d"];
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** `p`, or "TIMEOUT" after two seconds: a press that waits for a load that never ends fails the test instead of hanging it. */
function soon<T>(p: Promise<T>): Promise<T | "TIMEOUT"> {
    return new Promise((resolve, reject) => {
        const id = setTimeout(() => resolve("TIMEOUT"), 2000);
        p.then(
            (v) => {
                clearTimeout(id);
                resolve(v);
            },
            (e: unknown) => {
                clearTimeout(id);
                reject(e instanceof Error ? e : new Error(String(e)));
            },
        );
    });
}

// ─── the fake engine and the fake shell ─────────────────────────────────────

/** What the ENGINE holds (the UI's mixer store is optimistic and may differ). */
interface EngineDeck {
    trackId: string | null;
    playing: boolean;
    keyShift: number;
}
const fake = {
    decks: {} as Record<DeckId, EngineDeck>,
    /** Every load the engine was asked for. */
    loads: [] as LoadTrackRequest[],
    /** Every key shift sent to the engine. */
    shifts: [] as [DeckId, number][],
    /** Every ranking the shell was asked for: candidate ids, limit, the key-shift option. */
    ranks: [] as { ids: string[]; limit: number; keyShift: boolean }[],
    /** Every plan the shell was asked for. */
    plans: [] as { from: string; to: string }[],
    /** The shell's answer per track id: its score and, when it has one, its proposal (shift, key after). */
    table: new Map<string, { score: number; shift?: readonly [number, string] }>(),
    /** How long the engine takes to decode a load. */
    loadMs: 0,
    loadFails: false,
    /** The DJ starts the deck the moment the track lands. */
    startsPlaying: false,
    /** The companion's answer about stems (null = at once, none). */
    stems: null as Promise<null> | null,
};

function snapshot(): MixerState {
    const m = useMixerStore.getState();
    const decks = DECKS.map((id): DeckState => ({ ...m.deck(id), trackId: fake.decks[id].trackId, loaded: fake.decks[id].trackId !== null, playing: fake.decks[id].playing }));
    return { crossfader: 0, crossfaderCurve: "smooth", masterVolume: 0.85, cueVolume: 0.7, masterVu: 0, decks, sampleRate: 48000, latencyMs: 0 };
}

function clock(): ClockState {
    const decks = DECKS.map((id) => ({ id, bpm: 0, beat: 0, barPhase: null, keyShift: fake.decks[id].keyShift, slip: false, quantize: false, syncLock: false }));
    return { configured: "auto", source: "internal", bpm: 120, beat: 0, beatPhase: 0, barPhase: null, beatsPerBar: 4, frame: 0, sampleRate: 48000, decks };
}

engine.getState = () => Promise.resolve(snapshot());
engine.clockState = () => Promise.resolve(clock());
engine.setKeyShift = (deck, semitones) => {
    fake.decks[deck].keyShift = semitones;
    fake.shifts.push([deck, semitones]);
    return Promise.resolve(null);
};
engine.loadTrack = async (req) => {
    fake.loads.push(req);
    if (fake.loadMs > 0) await sleep(fake.loadMs);
    if (fake.loadFails) throw new Error("decode failed");
    // A load stops the deck and keeps its key shift (as the real engine does).
    fake.decks[req.deck] = { ...fake.decks[req.deck], trackId: req.trackId ?? null, playing: fake.startsPlaying };
    return [];
};
engine.loadTrackStream = () => Promise.reject(new Error("no stream in this test"));
engine.companionTrackStems = () => fake.stems ?? Promise.resolve(null);

copilot.status = () => Promise.resolve(null);
copilot.rank = (playing, candidates, _energy = "hold", limit = 8, keyShift = true) => {
    fake.ranks.push({ ids: candidates.map((c) => c.track.id), limit, keyShift });
    const rows = candidates
        .filter((c) => c.track.id !== playing.id)
        .map((c): Ranked => {
            const t = fake.table.get(c.track.id);
            return { id: c.track.id, score: t?.score ?? 0.1, key: 0.5, tempo: 1, energy: 0.5, reasons: [t?.shift ? "key_shiftable" : "key_adjacent"], tempoRatio: 1, keyShift: t?.shift?.[0] ?? null, keyAfter: t?.shift?.[1] ?? null };
        });
    // By score alone, like the shell: this fake does nothing to keep a proposal row low.
    rows.sort((x, y) => y.score - x.score || x.id.localeCompare(y.id));
    return Promise.resolve(rows.slice(0, limit));
};
copilot.plan = (req) => {
    fake.plans.push({ from: req.from.id, to: req.to.id });
    const plan: PlanInfo = { style: "bass_swap", bars: 16, startSec: 64, beatsUntilStart: 8, toCueSec: 0, toTempoRatio: 1, automationJson: "{}", reasons: ["phrase_aligned"], fromDeck: req.fromDeck, toDeck: req.toDeck, lengthBeats: 64 };
    return Promise.resolve(plan);
};

function tr(id: number, key: string | null, p: Partial<LibraryTrack> = {}): LibraryTrack {
    return { id, filepath: `/m/${id}.mp3`, filename: `${id}.mp3`, artist: `Artist ${id}`, title: `Track ${id}`, bpm: 124, keyCamelot: key, duration: 300, genre: null, isFavorite: null, rating: null, stemsStatus: null, ...p };
}

let scenes = 0;
/**
 * A fresh co-pilot store on a known stage: deck A plays track 900 in 8A at 124 BPM, deck B is
 * empty, the Library holds `pool`, the shell knows the co-pilot and proposes key shifts.
 */
async function scene(pool: LibraryTrack[], opts: { popout?: boolean } = {}): Promise<Mod> {
    const mixer = useMixerStore.getState();
    for (const id of DECKS) {
        fake.decks[id] = { trackId: null, playing: false, keyShift: 0 };
        mixer.patchDeck(id, { trackId: null, title: null, artist: null, loaded: false, playing: false, bpm: 0, duration: 0, position: 0, hasStems: false });
        mixer.setDeckKey(id, null);
        usePerfStore.getState().setKeyShift(id, 0);
    }
    fake.decks.a = { trackId: "900", playing: true, keyShift: 0 };
    mixer.patchDeck("a", { trackId: "900", title: "Now playing", artist: "Somebody", loaded: true, playing: true, bpm: 124, duration: 300, position: 60 });
    mixer.setDeckKey("a", "8A");
    useLibraryPool.getState().set(pool, "", pool.length);
    fake.loads.length = 0;
    fake.shifts.length = 0;
    fake.ranks.length = 0;
    fake.plans.length = 0;
    fake.table = new Map();
    fake.loadMs = 0;
    fake.loadFails = false;
    fake.startsPlaying = false;
    fake.stems = null;
    // A pop-out window is a page opened as index.html?popout=<panel>; the store reads it when it loads.
    if (opts.popout) Object.defineProperty(globalThis, "location", { value: { search: "?popout=library" }, configurable: true, writable: true });
    else Reflect.deleteProperty(globalThis, "location");
    const mod = (await import(`./copilot-store.ts?scene=${++scenes}`)) as Mod;
    mod.useCopilotStore.setState({ available: "yes", proposals: true });
    return mod;
}

const listed = (mod: Mod): string[] => mod.useCopilotStore.getState().suggestions.map((s) => String(s.track.id));

// ─── F3: "Mix next" ─────────────────────────────────────────────────────────

test("F3 'Mix next' loads, by itself, the best suggestion that needs no key shift", async () => {
    const pool = [tr(1, "1A"), tr(2, "3A"), tr(3, "9A"), tr(4, "10A")];
    const mod = await scene(pool);
    const store = mod.useCopilotStore;
    fake.table = new Map([
        ["1", { score: 0.88, shift: [1, "8A"] as const }],
        ["2", { score: 0.86, shift: [-1, "8A"] as const }],
        ["3", { score: 0.8 }],
        ["4", { score: 0.6 }],
    ]);
    await store.getState().refresh();
    assert.deepEqual(listed(mod), ["1", "2", "3", "4"], "the fixture: two rows with a proposal stand on top of the list");
    const plan = await store.getState().planMix();
    assert.ok(plan, "a plan was made");
    // Not the top row (it would go on the deck unshifted, as a clash, and be planned as an echo-out).
    assert.deepEqual(
        fake.loads.map((l) => [l.deck, l.trackId]),
        [["b", "3"]],
    );
    assert.deepEqual(fake.shifts, [], "the automatic load never shifts a key");
    assert.deepEqual(fake.plans, [{ from: "900", to: "3" }]);
    assert.equal(store.getState().note, null, "nothing to warn about");
    assert.deepEqual(store.getState().shifts, []);
});

test("F3 only when every suggestion needs a shift is the first one loaded, and the status line says it clashes and which button shifts it", async () => {
    const pool = [tr(1, "1A"), tr(2, "5A")];
    const mod = await scene(pool);
    const store = mod.useCopilotStore;
    fake.table = new Map([
        ["1", { score: 0.88, shift: [1, "8A"] as const }],
        ["2", { score: 0.82, shift: [2, "7A"] as const }],
    ]);
    const plan = await store.getState().planMix();
    assert.ok(plan);
    assert.deepEqual(
        fake.loads.map((l) => [l.deck, l.trackId]),
        [["b", "1"]],
    );
    assert.deepEqual(fake.shifts, [], "loaded as it is: nothing changes the sound without a gesture");
    const note = store.getState().note;
    assert.equal(note?.key, "copilot.nextClashes");
    assert.deepEqual(note?.vars, { title: "Track 1", deck: "B", shift: "+1", key: "8A" });
    assert.equal(note?.tone, "info");
    assert.equal(store.getState().plan, plan, "the plan is on screen together with the line");
    // The action the line names: the row's key-shift button. The track is on the deck, so it only shifts.
    assert.equal(await soon(store.getState().loadShifted("b", pool[0]!, 1)), true);
    assert.equal(fake.loads.length, 1, "not loaded a second time");
    assert.deepEqual(fake.shifts, [["b", 1]]);
    assert.deepEqual(store.getState().shifts, [{ deck: "b", trackId: "1", shift: 1 }]);
});

// ─── F4: the list of an "in key" request ────────────────────────────────────

test("F4 an 'in key' request lists every track that fits as it is before the ones that need a key shift", async () => {
    // Against 8A: 9A fits, 10A is a boost, 9B a diagonal; 1A needs +1, 5A needs +2; 2B is a
    // clash nothing fixes; track 7 has no key. The fake shell scores the two shiftable tracks
    // and the hopeless one ABOVE everything else: by score alone they would lead the list.
    const pool = [tr(1, "1A"), tr(2, "5A"), tr(3, "9A"), tr(4, "10A"), tr(5, "9B"), tr(6, "2B"), tr(7, null)];
    const mod = await scene(pool);
    const store = mod.useCopilotStore;
    fake.table = new Map([
        ["1", { score: 0.88, shift: [1, "8A"] as const }],
        ["2", { score: 0.82, shift: [2, "7A"] as const }],
        ["3", { score: 0.6 }],
        ["4", { score: 0.55 }],
        ["5", { score: 0.5 }],
        ["6", { score: 0.95 }],
        ["7", { score: 0.97 }],
    ]);
    await store.getState().ask("harmonic");
    const s = store.getState();
    assert.equal(s.request?.filters.keyRelation, "harmonic");
    assert.equal(s.request?.matched, 5, "three that fit as they are, two that a shift fixes; the hopeless clash and the track without a key are out");
    assert.deepEqual(listed(mod), ["3", "4", "5", "1", "2"]);
    // The same as a property of the list on screen: no row with a proposal above a row without one.
    const proposal = s.suggestions.map((x) => x.ranked?.keyShift != null);
    assert.ok(proposal.includes(true) && proposal.includes(false), "the list holds both kinds");
    assert.equal(proposal.lastIndexOf(false) < proposal.indexOf(true), true, `rows with a proposal: ${proposal.join(",")}`);
    // How: the two groups are ranked one after the other; the second gets the rows that are left.
    assert.deepEqual(fake.ranks, [
        { ids: ["3", "4", "5"], limit: 8, keyShift: true },
        { ids: ["1", "2"], limit: 5, keyShift: true },
    ]);

    // A list full of tracks that fit: the ones that need a shift are not shown (and not ranked).
    const many = [tr(1, "1A"), ...Array.from({ length: 9 }, (_, i) => tr(10 + i, "9A"))];
    const full = await scene(many);
    fake.table = new Map<string, { score: number; shift?: readonly [number, string] }>([["1", { score: 0.99, shift: [1, "8A"] as const }], ...many.slice(1).map((t): [string, { score: number }] => [String(t.id), { score: 0.5 }])]);
    await full.useCopilotStore.getState().ask("in key");
    assert.equal(full.useCopilotStore.getState().request?.matched, 10);
    assert.equal(listed(full).length, 8);
    assert.ok(!listed(full).includes("1"), "the shiftable track is past the cut, whatever it scores");
    assert.equal(fake.ranks.length, 1);

    // Without a request the list is ONE ranking of the whole pool (there the crate keeps a
    // proposal below every track that fits; this fake does not, and the store adds no order).
    const plain = await scene(pool);
    fake.table = new Map([
        ["1", { score: 0.88, shift: [1, "8A"] as const }],
        ["3", { score: 0.6 }],
    ]);
    await plain.useCopilotStore.getState().refresh();
    assert.deepEqual(fake.ranks, [{ ids: ["1", "2", "3", "4", "5", "6", "7"], limit: 8, keyShift: true }]);
    assert.equal(listed(plain)[0], "1");
});

// ─── F1: when the shift lands ───────────────────────────────────────────────

test("F1 the key shift lands as soon as the engine holds the track, while the stems are still on their way", async () => {
    const track = tr(1, "1A", { stemsStatus: "ready" });
    const mod = await scene([track]);
    const store = mod.useCopilotStore;
    // The companion takes its time with the stems (the real call has a 15 s limit): the load
    // promise stays open long after the deck is playable.
    let release: () => void = () => undefined;
    fake.stems = new Promise<null>((resolve) => {
        release = () => resolve(null);
    });
    fake.loadMs = 150;
    const t0 = Date.now();
    const applied = await soon(store.getState().loadShifted("b", track, 1));
    const took = Date.now() - t0;
    assert.equal(applied, true, "the press was answered although the load has not ended");
    assert.ok(took >= 140 && took < 1000, `answered after ${took} ms (engine had the track at 150 ms)`);
    assert.deepEqual(fake.shifts, [["b", 1]]);
    assert.equal(fake.decks.b.trackId, "1");
    assert.deepEqual(store.getState().shifts, [{ deck: "b", trackId: "1", shift: 1 }]);
    assert.equal(store.getState().note, null);
    assert.equal(store.getState().shifting.b, "1", "the load itself is still in flight (stems)");
    release();
    await sleep(30);
    assert.equal(store.getState().shifting.b, undefined, "and over once the stems answered");
    assert.deepEqual(fake.shifts, [["b", 1]], "nothing more was sent");
});

test("F1 a deck that is already playing the new track is not shifted, and the status line says so", async () => {
    const track = tr(1, "1A");
    const mod = await scene([track]);
    const store = mod.useCopilotStore;
    // The DJ starts deck B the moment the track is there, before the co-pilot's next look.
    fake.loadMs = 50;
    fake.startsPlaying = true;
    const applied = await soon(store.getState().loadShifted("b", track, 1));
    assert.equal(applied, false);
    assert.equal(fake.decks.b.trackId, "1", "the track was loaded");
    assert.equal(fake.decks.b.playing, true);
    assert.deepEqual(fake.shifts, [], "no pitch change under the audience");
    assert.deepEqual(store.getState().shifts, [], "and nothing to undo later");
    const note = store.getState().note;
    assert.equal(note?.key, "copilot.shiftSkippedPlaying");
    assert.deepEqual(note?.vars, { deck: "B", shift: "+1" });
});

test("F1 a load that fails shifts nothing", async () => {
    const track = tr(1, "1A");
    const mod = await scene([track]);
    const store = mod.useCopilotStore;
    fake.loadFails = true;
    assert.equal(await soon(store.getState().loadShifted("b", track, 1)), false);
    assert.deepEqual(fake.shifts, []);
    assert.deepEqual(store.getState().shifts, []);
    assert.equal(store.getState().note?.key, "copilot.loadFailed", "the load path reports its own failure");
    await sleep(10);
    assert.equal(store.getState().shifting.b, undefined);
});

// ─── F7: a second press, a playing deck ─────────────────────────────────────

test("F7 a second press for a deck whose load is in flight says 'still loading' and starts nothing", async () => {
    const first = tr(1, "1A");
    const second = tr(2, "3A");
    const mod = await scene([first, second]);
    const store = mod.useCopilotStore;
    fake.loadMs = 200;
    const press = store.getState().loadShifted("b", first, 1);
    await sleep(20);
    assert.equal(store.getState().shifting.b, "1", "the row can show its load in flight");
    assert.equal(await store.getState().loadShifted("b", second, -1), false);
    const note = store.getState().note;
    assert.equal(note?.key, "copilot.shiftBusy", "not silence");
    assert.deepEqual(note?.vars, { deck: "B" });
    assert.equal(fake.loads.length, 1, "no second load");
    // The first press goes on undisturbed.
    assert.equal(await soon(press), true);
    assert.deepEqual(fake.shifts, [["b", 1]]);
    assert.equal(fake.decks.b.trackId, "1");
    await sleep(10);
    assert.equal(store.getState().shifting.b, undefined);
    // Only what a row can propose is taken at all.
    for (const bad of [0, 3, -3, 1.5, Number.NaN]) assert.equal(await store.getState().loadShifted("b", second, bad), false, String(bad));
    assert.equal(fake.loads.length, 1);
});

test("F7 nothing is loaded with a key shift over a deck that is playing", async () => {
    const track = tr(1, "1A");
    const mod = await scene([track]);
    const store = mod.useCopilotStore;
    fake.decks.b = { trackId: "777", playing: true, keyShift: 0 };
    useMixerStore.getState().patchDeck("b", { trackId: "777", loaded: true, playing: true });
    assert.equal(await store.getState().loadShifted("b", track, 1), false);
    assert.deepEqual(fake.loads, [], "the deck on air keeps its track");
    assert.deepEqual(fake.shifts, [], "and its key");
    const note = store.getState().note;
    assert.equal(note?.key, "copilot.shiftDeckPlaying");
    assert.deepEqual(note?.vars, { deck: "B" });
    // The plain Load button is the DJ's own call and still works.
    assert.equal(await store.getState().load("b", track), true);
    assert.equal(fake.loads.length, 1);
    assert.deepEqual(fake.shifts, []);
});

// ─── F6: pop-out windows ────────────────────────────────────────────────────

test("F6 a pop-out window applies no key shift (its record would never be undone in the main window)", async () => {
    const track = tr(1, "1A");
    const popout = await scene([track], { popout: true });
    assert.equal(popout.IN_POPOUT, true);
    assert.equal(await popout.useCopilotStore.getState().loadShifted("b", track, 1), false);
    assert.deepEqual(fake.loads, [], "nothing was loaded");
    assert.deepEqual(fake.shifts, [], "nothing was shifted");
    assert.deepEqual(popout.useCopilotStore.getState().shifts, []);
    // The plain load works there as before.
    assert.equal(await popout.useCopilotStore.getState().load("b", track), true);
    assert.equal(fake.loads.length, 1);
    // The main window: the same press loads and shifts (so the refusal above is the pop-out's).
    const main = await scene([track]);
    assert.equal(main.IN_POPOUT, false);
    assert.equal(await soon(main.useCopilotStore.getState().loadShifted("b", track, 1)), true);
    assert.deepEqual(fake.shifts, [["b", 1]]);
});
