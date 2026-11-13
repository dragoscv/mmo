// Run: node --test apps/mixai/src/copilot/key-shift.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { DeckId } from "../bridge/types.ts";
import {
    ENGINE_WAIT_MS,
    KEY_CLASH_BELOW,
    KEY_FITS_FROM,
    LAND_POLLS_MAX,
    LAND_POLL_MS,
    SETTLE_MS,
    SETTLE_TRIES,
    allCamelotKeys,
    applyProposal,
    crateKeyScore,
    createShiftKeeper,
    encodeRecords,
    keyVerdict,
    knowsProposals,
    parseRecords,
    proposalOf,
    proposalTable,
    proposeKeyShift,
    soundingKey,
    trackFieldsChanged,
    watchShifts,
    within,
    type DeckTrackFields,
    type EngineDeck,
    type MixerView,
    type PerfView,
    type ShiftEvent,
    type ShiftRecord,
    type Watchable,
} from "./key-shift.ts";
import { keyCompatibility, parseCamelot } from "../lib/harmonic.ts";

const crate = (file: string) => readFileSync(new URL(`../../src-tauri/crates/decks-transition/${file}`, import.meta.url), "utf8");

// ─── the sounding key ───────────────────────────────────────────────────────

test("the sounding key is the track key moved by the deck's whole key shift", () => {
    assert.equal(soundingKey("8A", 0), "8A");
    assert.equal(soundingKey("8A", 1), "3A");
    assert.equal(soundingKey("8A", -1), "1A");
    assert.equal(soundingKey("12B", 2), "2B");
    assert.equal(soundingKey(" 8a ", 0), "8A", "canonical form");
    // A fractional shift (a key match can leave one) counts as the nearest semitone.
    assert.equal(soundingKey("8A", 0.6), "3A");
    assert.equal(soundingKey("8A", 0.4), "8A");
    assert.equal(soundingKey("8A", -1.5), soundingKey("8A", Math.round(-1.5)));
    // No shift information: the key as it is.
    assert.equal(soundingKey("8A", null), "8A");
    assert.equal(soundingKey("8A", undefined), "8A");
    assert.equal(soundingKey("8A", Number.NaN), "8A");
    // No key, or a key that is not Camelot: nothing is invented.
    assert.equal(soundingKey(null, 2), null);
    assert.equal(soundingKey("", 2), null);
    assert.equal(soundingKey("   ", 2), null);
    assert.equal(soundingKey("Am", 2), "Am");
});

// ─── the proposal rule ──────────────────────────────────────────────────────

test("a clash gets the smallest shift that makes it fit; anything else gets none", () => {
    const p = (a: string, b: string) => {
        const got = proposeKeyShift(a, b);
        return got ? [got.semitones, got.key, got.relation] : null;
    };
    assert.deepEqual(p("8A", "1A"), [1, "8A", "same"]);
    assert.deepEqual(p("8A", "3A"), [-1, "8A", "same"]);
    assert.deepEqual(p("8A", "5A"), [2, "7A", "adjacent"]);
    assert.deepEqual(p("8A", "11A"), [-2, "9A", "adjacent"]);
    assert.deepEqual(p("8A", "1B"), [1, "8B", "relative"]);
    assert.deepEqual(p("8B", "2B"), [1, "9B", "adjacent"]);
    // The tie: 2A against 8A is six steps away, +1 gives 9A and -1 gives 7A, both adjacent.
    assert.deepEqual(p("8A", "2A"), [1, "9A", "adjacent"], "equal relations: the upward shift");
    // Hopeless within two semitones.
    for (const to of ["2B", "4B", "5B", "11B", "12B"]) assert.equal(p("8A", to), null, `8A vs ${to}`);
    // Not a clash: a boost, a diagonal, a fit.
    for (const to of ["8A", "8B", "9A", "7A", "10A", "6A", "9B", "7B"]) assert.equal(p("8A", to), null, `8A vs ${to}`);
    // Unknown keys.
    assert.equal(p("8A", "Am"), null);
    assert.equal(proposeKeyShift(null, "8A"), null);
    assert.equal(proposeKeyShift("8A", null), null);
    assert.equal(proposeKeyShift("8A", ""), null);
});

test("every proposal really turns a clash into a fit, with the smallest shift", () => {
    const keys = allCamelotKeys();
    assert.equal(keys.length, 24);
    assert.equal(new Set(keys).size, 24);
    let proposals = 0;
    for (const from of keys) {
        for (const to of keys) {
            const a = parseCamelot(from)!;
            const b = parseCamelot(to)!;
            const plain = crateKeyScore(a, b).score;
            const got = proposeKeyShift(from, to);
            if (plain >= KEY_CLASH_BELOW) {
                assert.equal(got, null, `${from} vs ${to}: not a clash`);
                continue;
            }
            // What each of the four shifts gives, straight from the score function.
            const after = (s: number) => {
                const k = parseCamelot(soundingKey(to, s));
                return k ? crateKeyScore(a, k).score : 0;
            };
            const sizes = [1, 2].filter((n) => after(n) >= KEY_FITS_FROM || after(-n) >= KEY_FITS_FROM);
            if (!got) {
                assert.deepEqual(sizes, [], `${from} vs ${to}: a fix exists but none was proposed`);
                continue;
            }
            proposals++;
            assert.equal(Math.abs(got.semitones), sizes[0], `${from} vs ${to}: not the smallest shift`);
            assert.equal(got.key, soundingKey(to, got.semitones), `${from} vs ${to}: key after`);
            assert.ok(after(got.semitones) >= KEY_FITS_FROM, `${from} vs ${to}`);
            // Never the worse of two directions, and upward on equal terms.
            const mirror = after(-got.semitones);
            assert.ok(mirror <= after(got.semitones), `${from} vs ${to}: the better relation wins`);
            if (mirror === after(got.semitones)) assert.ok(got.semitones > 0, `${from} vs ${to}: upward on a tie`);
        }
    }
    assert.equal(proposals, 24 * 11);
});

test("the port gives the table the Rust crate is checked against", () => {
    const file = crate("fixtures/key-shift-proposals.txt");
    const lines = file
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith("#"));
    assert.equal(lines.length, 24 * 24);
    assert.deepEqual(proposalTable(), lines);
    // The crate reads this very file in a test, and uses the same two levels.
    const camelot = crate("src/camelot.rs");
    assert.ok(camelot.includes('include_str!("../fixtures/key-shift-proposals.txt")'), "camelot.rs no longer checks the shared table");
    assert.equal(Number(/pub const KEY_CLASH_BELOW: f64 = ([\d.]+);/.exec(camelot)?.[1]), KEY_CLASH_BELOW);
    assert.equal(Number(/pub const KEY_FITS_FROM: f64 = ([\d.]+);/.exec(camelot)?.[1]), KEY_FITS_FROM);
    // The table is not trivially empty or full.
    const none = lines.filter((l) => l.endsWith(" -")).length;
    assert.equal(lines.length - none, 24 * 11);
});

test("the key score of the port is the crate's", () => {
    const k = (s: string) => parseCamelot(s)!;
    assert.deepEqual(crateKeyScore(k("8A"), k("8A")), { score: 1, relation: "same" });
    assert.deepEqual(crateKeyScore(k("8A"), k("8B")), { score: 0.9, relation: "relative" });
    assert.deepEqual(crateKeyScore(k("8A"), k("9A")), { score: 0.85, relation: "adjacent" });
    assert.deepEqual(crateKeyScore(k("12A"), k("1A")), { score: 0.85, relation: "adjacent" }, "the wheel wraps");
    assert.deepEqual(crateKeyScore(k("8A"), k("10A")), { score: 0.6, relation: "boost" });
    assert.deepEqual(crateKeyScore(k("8A"), k("9B")), { score: 0.5, relation: "diagonal" });
    assert.equal(crateKeyScore(k("8A"), k("2A")).relation, "clash");
    assert.ok(crateKeyScore(k("8A"), k("2A")).score < 0.01);
    assert.ok(Math.abs(crateKeyScore(k("8A"), k("10B")).score - 0.24) < 1e-9, "other letter two steps away: 0.4 - 0.16");
});

test("one key verdict in the co-pilot: the ranking's score, also where the Library's rule says otherwise", () => {
    // The three levels a key chip shows, from the score the ranking uses.
    assert.equal(keyVerdict("8A", "8A"), "match");
    assert.equal(keyVerdict("8B", "8A"), "match", "relative");
    assert.equal(keyVerdict("9A", "8A"), "match", "adjacent");
    assert.equal(keyVerdict("7A", "8A"), "match");
    assert.equal(keyVerdict("10A", "8A"), "near", "boost");
    assert.equal(keyVerdict("9B", "8A"), "near", "diagonal");
    assert.equal(keyVerdict("2B", "8A"), "clash");
    // The pair the review names: the same letter, five wheel steps apart = keys ONE SEMITONE
    // apart. A clash for the ranking (which proposes the shift to the very same key) ...
    for (const key of ["1A", "3A"]) {
        assert.equal(keyVerdict(key, "8A"), "clash", `${key} against 8A`);
        assert.equal(proposeKeyShift("8A", key)?.key, "8A", `${key}: one semitone gives the same key`);
        // ... while the Library's own rule calls the same pair workable ("energy boost"): that
        // is the disagreement a row must not show ("workable" next to "Key +1 fits").
        assert.equal(keyCompatibility(parseCamelot("8A"), parseCamelot(key)).score, 0.6, `${key}: lib/harmonic`);
    }
    // Every row that carries a proposal has a clash chip: for all 264 proposals of the table.
    let proposals = 0;
    for (const from of allCamelotKeys()) {
        for (const to of allCamelotKeys()) {
            const verdict = keyVerdict(to, from);
            const expect = crateKeyScore(parseCamelot(from)!, parseCamelot(to)!).score;
            assert.equal(verdict, expect >= KEY_FITS_FROM ? "match" : expect >= KEY_CLASH_BELOW ? "near" : "clash", `${to} against ${from}`);
            if (proposeKeyShift(from, to)) {
                proposals++;
                assert.equal(verdict, "clash", `${to} against ${from}: a proposal row is never "match" or "workable"`);
            }
        }
    }
    assert.equal(proposals, 24 * 11);
    // Unknown keys: no verdict (the chip shows no mark).
    assert.equal(keyVerdict(null, "8A"), null);
    assert.equal(keyVerdict("8A", null), null);
    assert.equal(keyVerdict("Am", "8A"), null);
    assert.equal(keyVerdict("8A", ""), null);
});

// ─── what a ranked row carries ──────────────────────────────────────────────

test("a row's proposal is read only when it is a whole shift of one or two semitones and a Camelot key", () => {
    assert.deepEqual(proposalOf({ keyShift: 1, keyAfter: "9A" }), { shift: 1, key: "9A" });
    assert.deepEqual(proposalOf({ keyShift: -2, keyAfter: " 8b " }), { shift: -2, key: "8B" });
    // An older shell: no such fields. A row without a proposal: null.
    assert.equal(proposalOf({}), null);
    assert.equal(proposalOf({ keyShift: null, keyAfter: null }), null);
    assert.equal(proposalOf(null), null);
    assert.equal(proposalOf(undefined), null);
    for (const bad of [
        { keyShift: 0, keyAfter: "8A" },
        { keyShift: 3, keyAfter: "8A" },
        { keyShift: -3, keyAfter: "8A" },
        { keyShift: 1.5, keyAfter: "8A" },
        { keyShift: Number.NaN, keyAfter: "8A" },
        { keyShift: "1", keyAfter: "8A" },
        { keyShift: 1, keyAfter: null },
        { keyShift: 1, keyAfter: "13A" },
        { keyShift: 1, keyAfter: "Am" },
        { keyShift: 1, keyAfter: 8 },
        { keyShift: 1 },
        { keyAfter: "8A" },
    ]) {
        assert.equal(proposalOf(bad), null, JSON.stringify(bad));
    }
});

test("a shell that knows proposals sends the field on every row", () => {
    assert.equal(knowsProposals([{ id: "1", keyShift: null }, { id: "2", keyShift: 1 }]), true);
    assert.equal(knowsProposals([{ id: "1" }, { id: "2" }]), false, "an older shell");
    assert.equal(knowsProposals([{ id: "1", keyShift: 1 }, { id: "2" }]), false);
    assert.equal(knowsProposals([]), null, "no rows: cannot tell");
    assert.equal(knowsProposals(null), null);
});

// ─── applying and undoing, with fake stores ─────────────────────────────────

/** A fake engine + UI store: what the engine holds per deck, and the store's own (possibly late) shift. */
function rig() {
    const engine: Record<DeckId, EngineDeck> = { a: { trackId: "A1", keyShift: 0 }, b: { trackId: "B1", keyShift: 0 }, c: { trackId: null, keyShift: 0 }, d: { trackId: null, keyShift: 0 } };
    const store: Record<DeckId, number> = { a: 0, b: 0, c: 0, d: 0 };
    const sets: [DeckId, number][] = [];
    const events: ShiftEvent[] = [];
    const saved: (readonly ShiftRecord[])[] = [];
    let down = false;
    let asked = 0;
    /** Pauses the keeper took, and what happens during one (a command or a clock answer arrives). */
    const waits: number[] = [];
    let duringWait: (n: number) => void = () => undefined;
    const setKeyShift = (deck: DeckId, n: number) => {
        sets.push([deck, n]);
        engine[deck] = { ...engine[deck], keyShift: n };
        store[deck] = n;
    };
    const engineDeck = (deck: DeckId): Promise<EngineDeck | null> => {
        asked++;
        return Promise.resolve(down ? null : { ...engine[deck] });
    };
    const keeper = createShiftKeeper({
        engineDeck,
        storeShift: (deck) => store[deck],
        setKeyShift,
        changed: (records) => saved.push(records),
        notify: (e) => events.push(e),
        wait: (ms) => {
            waits.push(ms);
            duringWait(waits.length);
            return Promise.resolve();
        },
    });
    return {
        engine,
        store,
        sets,
        events,
        saved,
        keeper,
        engineDeck,
        setKeyShift,
        waits,
        onWait: (f: (n: number) => void) => {
            duringWait = f;
        },
        setDown: (v: boolean) => {
            down = v;
        },
        asked: () => asked,
        /** The DJ turns the key knob: engine and store follow. */
        byHand: (deck: DeckId, n: number) => {
            engine[deck] = { ...engine[deck], keyShift: n };
            store[deck] = n;
        },
        /** Another track lands on the deck (the key shift survives a load in the engine). */
        land: (deck: DeckId, trackId: string | null) => {
            engine[deck] = { ...engine[deck], trackId };
        },
    };
}

const rec = (deck: DeckId, trackId: string, shift: number): ShiftRecord => ({ deck, trackId, shift });

test("(a) the deck gets another track: the co-pilot's shift goes back to 0", async () => {
    const r = rig();
    r.keeper.applied(rec("b", "B1", 1));
    r.setKeyShift("b", 1);
    r.sets.length = 0;
    await r.keeper.check("b");
    assert.deepEqual(r.sets, [], "the same track with the co-pilot's shift: nothing happens");
    assert.deepEqual(r.keeper.recordOn("b"), rec("b", "B1", 1));

    r.land("b", "B2");
    await r.keeper.check("b");
    assert.deepEqual(r.sets, [["b", 0]]);
    assert.equal(r.engine.b.keyShift, 0);
    assert.equal(r.keeper.recordOn("b"), null);
    assert.deepEqual(r.events, [{ kind: "undone", record: rec("b", "B1", 1) }]);
    assert.deepEqual(r.saved.at(-1), [], "the stored set is empty again");
    // Later changes of that deck are none of the co-pilot's business.
    r.byHand("b", 3);
    r.land("b", "B3");
    await r.keeper.check("b");
    assert.deepEqual(r.sets, [["b", 0]]);
    assert.equal(r.engine.b.keyShift, 3);
});

test("(a) an unloaded deck counts as another track", async () => {
    const r = rig();
    r.keeper.applied(rec("b", "B1", -2));
    r.setKeyShift("b", -2);
    r.sets.length = 0;
    r.land("b", null);
    await r.keeper.check("b");
    assert.deepEqual(r.sets, [["b", 0]]);
    assert.equal(r.events[0]?.kind, "undone");
});

test("(a) another track, but the DJ had changed the shift: it is left alone and forgotten", async () => {
    const r = rig();
    r.keeper.applied(rec("b", "B1", 1));
    r.setKeyShift("b", 1);
    r.sets.length = 0;
    // By hand to +3 and a load, seen by one check (the two changes came close together).
    r.byHand("b", 3);
    r.land("b", "B2");
    await r.keeper.check("b");
    assert.deepEqual(r.sets, [], "a shift the DJ set is never reset");
    assert.equal(r.engine.b.keyShift, 3);
    assert.equal(r.keeper.recordOn("b"), null);
    assert.deepEqual(r.events, [{ kind: "kept", record: rec("b", "B1", 1) }]);
    // By hand back to 0 before the load: nothing to undo either.
    const q = rig();
    q.keeper.applied(rec("a", "A1", 2));
    q.setKeyShift("a", 2);
    q.sets.length = 0;
    q.byHand("a", 0);
    q.land("a", "A2");
    await q.keeper.check("a");
    assert.deepEqual(q.sets, []);
    assert.equal(q.events[0]?.kind, "kept");
});

test("(b) the DJ changes the shift by hand: the record is dropped, nothing else", async () => {
    const r = rig();
    r.keeper.applied(rec("b", "B1", 1));
    r.setKeyShift("b", 1);
    r.sets.length = 0;
    r.byHand("b", 2);
    await r.keeper.check("b");
    assert.deepEqual(r.sets, [], "the DJ's value stays");
    assert.equal(r.engine.b.keyShift, 2);
    assert.equal(r.keeper.recordOn("b"), null);
    assert.deepEqual(r.events, [{ kind: "dropped", record: rec("b", "B1", 1) }]);
    // The next track on that deck keeps the DJ's shift: rule (a) no longer applies.
    r.land("b", "B2");
    await r.keeper.check("b");
    assert.deepEqual(r.sets, []);
    assert.equal(r.engine.b.keyShift, 2);
    assert.equal(r.events.length, 1);
});

test("(b) while the engine and the UI store disagree on the shift nothing is decided", async () => {
    const r = rig();
    r.keeper.applied(rec("b", "B1", 1));
    r.setKeyShift("b", 1);
    // The UI store was overwritten by a clock answer taken before the command arrived, and
    // stays so: the keeper looks a few times, then leaves everything as it is.
    r.store.b = 0;
    await r.keeper.check("b");
    assert.deepEqual(r.keeper.recordOn("b"), rec("b", "B1", 1), "the engine has the co-pilot's shift");
    assert.equal(r.waits.length, SETTLE_TRIES - 1, "a bounded number of looks");
    assert.ok(r.waits.every((ms) => ms === SETTLE_MS));
    // The other way round: the engine answer is the stale one, the store already has it.
    r.store.b = 1;
    r.engine.b = { trackId: "B1", keyShift: 0 };
    await r.keeper.check("b");
    assert.deepEqual(r.keeper.recordOn("b"), rec("b", "B1", 1));
    assert.deepEqual(r.events, []);
    assert.deepEqual(r.sets, [["b", 1]], "nothing but the co-pilot's own shift was ever set");
});

test("(b) the co-pilot's own shift on its way to the engine is not read as a change by hand", async () => {
    const r = rig();
    // applyProposal: the record, then the store changes at once; the engine still has 0.
    r.keeper.applied(rec("b", "B1", 1));
    r.store.b = 1;
    r.onWait(() => {
        // The command arrives while the keeper waits.
        r.engine.b = { trackId: "B1", keyShift: 1 };
    });
    await r.keeper.check("b");
    assert.deepEqual(r.keeper.recordOn("b"), rec("b", "B1", 1));
    assert.deepEqual(r.events, []);
    assert.equal(r.waits.length, 1, "settled on the second look");
});

test("(b) a real change by hand is seen once the engine has it too", async () => {
    const r = rig();
    r.keeper.applied(rec("b", "B1", 1));
    r.setKeyShift("b", 1);
    // The DJ presses KEY+: the UI store has 2 at once, the engine a moment later.
    r.store.b = 2;
    r.onWait(() => {
        r.engine.b = { trackId: "B1", keyShift: 2 };
    });
    await r.keeper.check("b");
    assert.equal(r.keeper.recordOn("b"), null);
    assert.deepEqual(r.events, [{ kind: "dropped", record: rec("b", "B1", 1) }]);
    assert.equal(r.engine.b.keyShift, 2, "the DJ's value is not touched");
});

test("(b) the engine and the UI store both showing the OLD shift for a moment is not a change by hand", async () => {
    // What a live run hit: the co-pilot set +1; the engine answer predates the command (0) and
    // a clock answer of the same age has just overwritten the UI store (0). They agree, on a
    // value nobody chose. One look later both have the +1.
    const r = rig();
    r.keeper.applied(rec("b", "B1", 1));
    r.engine.b = { trackId: "B1", keyShift: 0 };
    r.store.b = 0;
    r.onWait(() => {
        r.engine.b = { trackId: "B1", keyShift: 1 };
        r.store.b = 1;
    });
    await r.keeper.check("b");
    assert.deepEqual(r.keeper.recordOn("b"), rec("b", "B1", 1), "one agreeing look is not a settled reading");
    assert.deepEqual(r.events, []);
    assert.equal(r.waits.length, 1);
    // The same on a deck that got another track: a first look of "another track, shift 0 and 0"
    // must not conclude that the DJ took the shift away (the shift would then stay on the new track).
    const q = rig();
    q.keeper.applied(rec("b", "B1", 1));
    q.setKeyShift("b", 1);
    q.sets.length = 0;
    q.engine.b = { trackId: "B2", keyShift: 0 };
    q.store.b = 0;
    q.onWait(() => {
        q.engine.b = { trackId: "B2", keyShift: 1 };
        q.store.b = 1;
    });
    await q.keeper.check("b");
    assert.deepEqual(q.sets, [["b", 0]], "undone once the reading settled on the co-pilot's shift");
    assert.deepEqual(q.events, [{ kind: "undone", record: rec("b", "B1", 1) }]);
    // A value that really stays (two looks in a row) is believed.
    const s = rig();
    s.keeper.applied(rec("b", "B1", 1));
    s.engine.b = { trackId: "B1", keyShift: 0 };
    s.store.b = 0;
    await s.keeper.check("b");
    assert.equal(s.keeper.recordOn("b"), null);
    assert.deepEqual(s.events, [{ kind: "dropped", record: rec("b", "B1", 1) }]);
    assert.equal(s.waits.length, 1, "decided on the second look");
});

test("(a) another track while the two disagree: undone only when they settle on the co-pilot's shift", async () => {
    // A stale clock answer put 0 in the UI store, the next one puts the 1 back: undone.
    const r = rig();
    r.keeper.applied(rec("b", "B1", 1));
    r.setKeyShift("b", 1);
    r.sets.length = 0;
    r.store.b = 0;
    r.land("b", "B2");
    r.onWait(() => {
        r.store.b = 1;
    });
    await r.keeper.check("b");
    assert.deepEqual(r.sets, [["b", 0]]);
    assert.deepEqual(r.events, [{ kind: "undone", record: rec("b", "B1", 1) }]);

    // The DJ's new value reaches the engine during the wait: left alone.
    const q = rig();
    q.keeper.applied(rec("b", "B1", 1));
    q.setKeyShift("b", 1);
    q.sets.length = 0;
    q.store.b = 4;
    q.land("b", "B2");
    q.onWait(() => {
        q.engine.b = { trackId: "B2", keyShift: 4 };
    });
    await q.keeper.check("b");
    assert.deepEqual(q.sets, []);
    assert.deepEqual(q.events, [{ kind: "kept", record: rec("b", "B1", 1) }]);

    // They never agree (the engine says 1, the store insists on 3): never reset on a doubt.
    const s = rig();
    s.keeper.applied(rec("b", "B1", 1));
    s.setKeyShift("b", 1);
    s.sets.length = 0;
    s.store.b = 3;
    s.land("b", "B2");
    await s.keeper.check("b");
    assert.deepEqual(s.sets, [], "a shift that may be the DJ's is not put back to 0");
    assert.equal(s.keeper.recordOn("b"), null, "the record goes with the track");
    assert.equal(s.events[0]?.kind, "kept");
});

test("an engine that does not answer decides nothing", async () => {
    const r = rig();
    r.keeper.applied(rec("b", "B1", 1));
    r.setKeyShift("b", 1);
    r.sets.length = 0;
    r.land("b", "B2");
    r.setDown(true);
    await r.keeper.check("b");
    assert.deepEqual(r.sets, []);
    assert.deepEqual(r.keeper.recordOn("b"), rec("b", "B1", 1), "kept for the next look");
    r.setDown(false);
    await r.keeper.check("b");
    assert.deepEqual(r.sets, [["b", 0]]);
});

test("checks of one deck never overlap, and a change during a check is seen", async () => {
    const r = rig();
    r.keeper.applied(rec("b", "B1", 1));
    r.setKeyShift("b", 1);
    r.sets.length = 0;
    const first = r.keeper.check("b");
    // While the engine is being asked, the deck gets another track and a second check comes in.
    r.land("b", "B2");
    const second = r.keeper.check("b");
    assert.equal(first, second, "one flight per deck");
    await first;
    assert.deepEqual(r.sets, [["b", 0]], "undone exactly once");
    assert.equal(r.events.length, 1);
    // Decks are independent.
    const q = rig();
    q.keeper.applied(rec("a", "A1", 1));
    q.keeper.applied(rec("b", "B1", 2));
    q.setKeyShift("a", 1);
    q.setKeyShift("b", 2);
    q.sets.length = 0;
    q.land("a", "A2");
    await Promise.all([q.keeper.check("a"), q.keeper.check("b")]);
    assert.deepEqual(q.sets, [["a", 0]]);
    assert.deepEqual(q.keeper.records(), [rec("b", "B1", 2)]);
});

test("a deck without a record is never touched and the engine is not even asked", async () => {
    const r = rig();
    r.byHand("a", 4);
    r.land("a", "A2");
    await r.keeper.check("a");
    assert.equal(r.asked(), 0);
    assert.deepEqual(r.sets, []);
    assert.equal(r.engine.a.keyShift, 4, "a shift set by hand survives a load, as before");
});

test("(c) the shift is applied only after the track is on the deck", async () => {
    // The order: the load first, the shift after it.
    const r = rig();
    const order: string[] = [];
    const result = await applyProposal(
        r.keeper,
        {
            engineDeck: r.engineDeck,
            load: (deck) => {
                assert.deepEqual(r.sets, [], "no shift before the load");
                order.push("load");
                r.land(deck, "N1");
                return Promise.resolve(true);
            },
            setKeyShift: (deck, n) => {
                order.push(`shift ${n}`);
                r.setKeyShift(deck, n);
            },
        },
        "b",
        "N1",
        1,
    );
    assert.equal(result, "applied");
    assert.deepEqual(order, ["load", "shift 1"]);
    assert.deepEqual(r.keeper.recordOn("b"), rec("b", "N1", 1));
    assert.equal(r.engine.b.keyShift, 1);

    // The load fails: the old track keeps its key.
    const f = rig();
    const failed = await applyProposal(f.keeper, { engineDeck: f.engineDeck, load: () => Promise.resolve(false), setKeyShift: f.setKeyShift }, "b", "N1", 1);
    assert.equal(failed, "load-failed");
    assert.deepEqual(f.sets, []);
    assert.equal(f.keeper.recordOn("b"), null);
    assert.equal(f.engine.b.keyShift, 0);

    // Another load won: the engine holds a third track when ours reports success.
    const l = rig();
    const lost = await applyProposal(
        l.keeper,
        {
            engineDeck: l.engineDeck,
            load: (deck) => {
                l.land(deck, "OTHER");
                return Promise.resolve(true);
            },
            setKeyShift: l.setKeyShift,
        },
        "b",
        "N1",
        2,
    );
    assert.equal(lost, "lost");
    assert.deepEqual(l.sets, [], "the other track is not shifted");
    assert.equal(l.keeper.recordOn("b"), null);

    // The engine does not answer after the load: nothing is shifted blind.
    const d = rig();
    let calls = 0;
    const blind = await applyProposal(
        d.keeper,
        {
            engineDeck: (deck) => (++calls === 1 ? d.engineDeck(deck) : Promise.resolve(null)),
            load: () => Promise.resolve(true),
            setKeyShift: d.setKeyShift,
        },
        "b",
        "N1",
        1,
    );
    assert.equal(blind, "no-engine");
    assert.deepEqual(d.sets, []);
});

test("a track that is already on the deck is not loaded again, only shifted", async () => {
    const r = rig();
    let loads = 0;
    const result = await applyProposal(
        r.keeper,
        {
            engineDeck: r.engineDeck,
            load: () => {
                loads++;
                return Promise.resolve(true);
            },
            setKeyShift: r.setKeyShift,
        },
        "b",
        "B1",
        -1,
    );
    assert.equal(result, "applied");
    assert.equal(loads, 0);
    assert.deepEqual(r.sets, [["b", -1]]);
});

// ─── F1: the shift lands when the ENGINE has the track, not when the whole load ends ───────

/** `p`, or "TIMEOUT" after a second of real time: a regression that waits for a load that never ends fails, it does not hang. */
function soon<T>(p: Promise<T>): Promise<T | "TIMEOUT"> {
    return new Promise((resolve, reject) => {
        const id = setTimeout(() => resolve("TIMEOUT"), 1000);
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

/**
 * A fake engine and a fake load with their own timing. Time moves only when `applyProposal`
 * pauses between two looks (`wait`); what happens at a given time is scheduled with `at`. The
 * load promise ends only when the test ends it (`endLoad`): the real one also waits for the
 * stems, seconds after the engine holds the track.
 */
function timed() {
    const r = rig();
    let t = 0;
    const due: { at: number; run: () => void; done: boolean }[] = [];
    const waits: number[] = [];
    let loads = 0;
    let ended: boolean | null = null;
    let finish: (ok: boolean) => void = () => undefined;
    const deps = {
        engineDeck: r.engineDeck,
        load: (_deck: DeckId) => {
            loads++;
            return new Promise<boolean>((resolve) => {
                finish = (ok) => {
                    ended = ok;
                    resolve(ok);
                };
            });
        },
        setKeyShift: r.setKeyShift,
        wait: (ms: number) => {
            waits.push(ms);
            // The pauses of this rig never yield to a timer: a loop that never stops would spin
            // for ever and hang the run instead of failing it.
            if (waits.length > LAND_POLLS_MAX + 50) throw new Error("applyProposal did not stop looking at the engine");
            t += ms;
            for (const e of due) {
                if (!e.done && e.at <= t) {
                    e.done = true;
                    e.run();
                }
            }
            return Promise.resolve();
        },
    };
    return {
        r,
        deps,
        waits,
        at: (time: number, run: () => void) => void due.push({ at: time, run, done: false }),
        now: () => t,
        loads: () => loads,
        /** null = the load promise is still running. */
        ended: () => ended,
        endLoad: (ok: boolean) => finish(ok),
    };
}

test("F1 slow stems: the shift is set within one look of the engine having the track, while the load still runs", async () => {
    const x = timed();
    // The engine holds the new track 300 ms after the press; the load promise goes on (stems).
    x.at(300, () => x.r.land("b", "N1"));
    // Nothing is shifted before that: the old track is still on the deck.
    x.at(100, () => assert.deepEqual(x.r.sets, [], "no shift at 100 ms"));
    x.at(200, () => assert.deepEqual(x.r.sets, [], "no shift at 200 ms"));
    const result = await soon(applyProposal(x.r.keeper, x.deps, "b", "N1", 1));
    assert.equal(result, "applied");
    assert.equal(x.ended(), null, "the load promise has not settled: the shift did not wait for it");
    assert.deepEqual(x.r.sets, [["b", 1]]);
    assert.deepEqual(x.r.keeper.recordOn("b"), rec("b", "N1", 1));
    assert.deepEqual(x.waits, [LAND_POLL_MS, LAND_POLL_MS, LAND_POLL_MS], "one look every 100 ms");
    assert.ok(x.now() - 300 <= LAND_POLL_MS, `shifted ${x.now() - 300} ms after the engine had the track`);
    assert.equal(x.loads(), 1);
    // The stems arrive seconds later: nothing more happens.
    x.endLoad(true);
    await Promise.resolve();
    assert.deepEqual(x.r.sets, [["b", 1]]);
});

test("F1 fast load: a load that lands at once is shifted without a single pause", async () => {
    const r = rig();
    const waits: number[] = [];
    const result = await soon(
        applyProposal(
            r.keeper,
            {
                engineDeck: r.engineDeck,
                load: (deck) => {
                    r.land(deck, "N1");
                    return Promise.resolve(true);
                },
                setKeyShift: r.setKeyShift,
                wait: (ms) => {
                    waits.push(ms);
                    return Promise.resolve();
                },
            },
            "b",
            "N1",
            2,
        ),
    );
    assert.equal(result, "applied");
    assert.deepEqual(waits, []);
    assert.deepEqual(r.sets, [["b", 2]]);
});

test("F1 the load fails: nothing is shifted, however long it took to fail", async () => {
    const x = timed();
    x.at(400, () => x.endLoad(false));
    const result = await soon(applyProposal(x.r.keeper, x.deps, "b", "N1", 1));
    assert.equal(result, "load-failed");
    assert.deepEqual(x.r.sets, []);
    assert.equal(x.r.keeper.recordOn("b"), null);
    assert.equal(x.r.engine.b.keyShift, 0, "the old track keeps its key");
    assert.equal(x.waits.length, 4);
    // A load that throws is a failed load too.
    const r = rig();
    const thrown = await soon(applyProposal(r.keeper, { engineDeck: r.engineDeck, load: () => Promise.reject(new Error("decode")), setKeyShift: r.setKeyShift }, "b", "N1", 1));
    assert.equal(thrown, "load-failed");
    assert.deepEqual(r.sets, []);
});

test("F1 another track wins: the engine holds a third track, nothing is shifted on it", async () => {
    const x = timed();
    // A load from the Library overtakes ours; ours then reports success all the same.
    x.at(100, () => x.r.land("b", "OTHER"));
    x.at(300, () => x.endLoad(true));
    const result = await soon(applyProposal(x.r.keeper, x.deps, "b", "N1", 2));
    assert.equal(result, "lost");
    assert.deepEqual(x.r.sets, [], "the other track is not shifted");
    assert.equal(x.r.keeper.recordOn("b"), null);
    assert.equal(x.r.engine.b.trackId, "OTHER");
});

test("F1 the deck was already playing the new track: the pitch is not changed under the audience", async () => {
    // The DJ was faster: the track landed and was started before the co-pilot's next look.
    const x = timed();
    x.at(200, () => {
        x.r.engine.b = { trackId: "N1", keyShift: 0, playing: true };
    });
    const result = await soon(applyProposal(x.r.keeper, x.deps, "b", "N1", 1));
    assert.equal(result, "playing");
    assert.deepEqual(x.r.sets, [], "no shift on a deck that is on air");
    assert.equal(x.r.keeper.recordOn("b"), null, "and no record: there is nothing to undo");
    assert.equal(x.r.engine.b.keyShift, 0);
    // Seen twice, one look apart, before it is believed.
    assert.deepEqual(x.waits, [LAND_POLL_MS, LAND_POLL_MS, LAND_POLL_MS]);

    // A track that is already on the deck AND playing: the "shift only" press does nothing either.
    const r = rig();
    r.engine.b = { trackId: "B1", keyShift: 0, playing: true };
    let loads = 0;
    const onAir = await soon(
        applyProposal(
            r.keeper,
            {
                engineDeck: r.engineDeck,
                load: () => {
                    loads++;
                    return Promise.resolve(true);
                },
                setKeyShift: r.setKeyShift,
                wait: () => Promise.resolve(),
            },
            "b",
            "B1",
            -1,
        ),
    );
    assert.equal(onAir, "playing");
    assert.equal(loads, 0);
    assert.deepEqual(r.sets, []);

    // The other side, so the rule cannot swallow every shift: for a moment after a load landed
    // the engine may still report the transport of the track that was there before (playing),
    // and on the next look it is stopped. That is not "the DJ started it": the shift is set.
    const y = timed();
    y.at(200, () => {
        y.r.engine.b = { trackId: "N1", keyShift: 0, playing: true };
    });
    y.at(300, () => {
        y.r.engine.b = { trackId: "N1", keyShift: 0, playing: false };
    });
    assert.equal(await soon(applyProposal(y.r.keeper, y.deps, "b", "N1", 1)), "applied");
    assert.deepEqual(y.r.sets, [["b", 1]]);
    // ... and a deck that got yet another track between the two looks is "lost", not shifted.
    const z = timed();
    z.at(200, () => {
        z.r.engine.b = { trackId: "N1", keyShift: 0, playing: true };
    });
    z.at(300, () => z.r.land("b", "OTHER"));
    assert.equal(await soon(applyProposal(z.r.keeper, z.deps, "b", "N1", 1)), "lost");
    assert.deepEqual(z.r.sets, []);
});

test("F1 the looks at the engine are bounded: after a minute the load's own answer decides", async () => {
    const r = rig();
    const waits: number[] = [];
    let asked = 0;
    let finish: (ok: boolean) => void = () => undefined;
    const result = await soon(
        applyProposal(
            r.keeper,
            {
                engineDeck: (deck) => {
                    asked++;
                    // The last look of the loop: the load ends a moment later, with the track on the deck.
                    if (asked === LAND_POLLS_MAX + 1) {
                        setTimeout(() => {
                            r.land("b", "N1");
                            finish(true);
                        }, 0);
                    }
                    return r.engineDeck(deck);
                },
                load: () => new Promise<boolean>((resolve) => (finish = resolve)),
                setKeyShift: r.setKeyShift,
                wait: (ms) => {
                    waits.push(ms);
                    if (waits.length > LAND_POLLS_MAX + 50) throw new Error("the looks at the engine are not bounded");
                    return Promise.resolve();
                },
            },
            "b",
            "N1",
            1,
        ),
    );
    assert.equal(result, "applied");
    assert.equal(waits.length, LAND_POLLS_MAX - 1, "no look after the bound");
    assert.equal(asked, LAND_POLLS_MAX + 2, "one look before the load, the bounded looks, one after the load ended");
    assert.deepEqual(r.sets, [["b", 1]]);
});

// ─── F7: one engine call that never answers cannot block a deck for ever ─────────────────────

test("an engine answer is waited for a bounded time", async () => {
    assert.equal(ENGINE_WAIT_MS, 2000);
    assert.equal(await within(Promise.resolve(7), 50), 7);
    assert.equal(await within(Promise.reject(new Error("x")), 50), null, "a failure is no answer");
    const t0 = Date.now();
    assert.equal(await within(new Promise<number>(() => undefined), 30), null, "a call that never answers");
    assert.ok(Date.now() - t0 >= 25 && Date.now() - t0 < 1000, `${Date.now() - t0} ms`);
});

test("a stuck engine call ends that look, and the deck's later checks still run", async () => {
    const engine = { trackId: "B1" as string | null, keyShift: 1 };
    const sets: [DeckId, number][] = [];
    const events: ShiftEvent[] = [];
    let stuck = true;
    let asked = 0;
    const keeper = createShiftKeeper({
        // The first call never answers (a hung IPC call); the later ones do.
        engineDeck: () => {
            asked++;
            return stuck ? new Promise<EngineDeck | null>(() => undefined) : Promise.resolve({ ...engine });
        },
        storeShift: () => engine.keyShift,
        setKeyShift: (deck, n) => {
            sets.push([deck, n]);
            engine.keyShift = n;
        },
        changed: () => undefined,
        notify: (e) => events.push(e),
        wait: () => Promise.resolve(),
        engineWaitMs: 30,
    });
    keeper.applied(rec("b", "B1", 1));
    const first = await soon(keeper.check("b"));
    assert.notEqual(first, "TIMEOUT", "the check came back although the engine never answered");
    assert.deepEqual(sets, [], "nothing is decided without an answer");
    assert.deepEqual(keeper.recordOn("b"), rec("b", "B1", 1));
    // The deck gets another track; the engine answers again: the check is not queued behind the stuck one.
    stuck = false;
    engine.trackId = "B2";
    assert.notEqual(await soon(keeper.check("b")), "TIMEOUT");
    assert.deepEqual(sets, [["b", 0]]);
    assert.deepEqual(events, [{ kind: "undone", record: rec("b", "B1", 1) }]);
    assert.ok(asked >= 3);
});

test("a press whose engine never answers comes back with 'no engine' and shifts nothing", async () => {
    const r = rig();
    const result = await soon(
        applyProposal(
            r.keeper,
            {
                engineDeck: () => new Promise<EngineDeck | null>(() => undefined),
                load: () => Promise.resolve(true),
                setKeyShift: r.setKeyShift,
                wait: () => Promise.resolve(),
                engineWaitMs: 20,
            },
            "b",
            "N1",
            1,
        ),
    );
    assert.equal(result, "no-engine");
    assert.deepEqual(r.sets, [], "nothing is shifted blind");
    assert.equal(r.keeper.recordOn("b"), null);
});

test("a new proposal on the same deck replaces the record; the keeper's own change is not 'by hand'", async () => {
    const r = rig();
    const deps = {
        engineDeck: r.engineDeck,
        load: (deck: DeckId) => {
            r.land(deck, deck === "b" ? "N2" : "X");
            return Promise.resolve(true);
        },
        setKeyShift: r.setKeyShift,
    };
    r.keeper.applied(rec("b", "B1", 1));
    r.setKeyShift("b", 1);
    r.sets.length = 0;
    // The load of the new suggestion lands; the watcher runs before the new shift is set.
    r.land("b", "N2");
    await r.keeper.check("b");
    assert.deepEqual(r.sets, [["b", 0]], "the old track's shift is undone first");
    const result = await applyProposal(r.keeper, deps, "b", "N2", 2);
    assert.equal(result, "applied");
    await r.keeper.check("b");
    assert.deepEqual(r.keeper.recordOn("b"), rec("b", "N2", 2));
    assert.equal(r.engine.b.keyShift, 2);
    assert.deepEqual(
        r.events.map((e) => e.kind),
        ["undone"],
        "no 'dropped': the co-pilot's own shift is not a manual change",
    );
});

test("(d) records survive as text and anything unreadable gives none", () => {
    const records = [rec("b", "42", 1), rec("a", "900001", -2)];
    assert.deepEqual(parseRecords(encodeRecords(records)), records);
    assert.deepEqual(parseRecords(encodeRecords([])), []);
    for (const bad of [null, undefined, "", "{", "[]", "null", '"x"', '{"v":2,"records":[]}', '{"v":1}', '{"v":1,"records":{}}']) {
        assert.deepEqual(parseRecords(bad), [], String(bad));
    }
    const row = (o: object) => JSON.stringify({ v: 1, records: [o] });
    for (const bad of [
        { deck: "e", trackId: "1", shift: 1 },
        { deck: "b", trackId: "", shift: 1 },
        { deck: "b", trackId: 7, shift: 1 },
        { deck: "b", trackId: "1", shift: 0 },
        { deck: "b", trackId: "1", shift: 3 },
        { deck: "b", trackId: "1", shift: 1.5 },
        { deck: "b", trackId: "1", shift: "1" },
        { deck: "b", trackId: "x".repeat(201), shift: 1 },
        { deck: "b" },
    ]) {
        assert.deepEqual(parseRecords(row(bad)), [], JSON.stringify(bad));
    }
    // One record per deck: the last one wins; a bad row does not spoil the good ones.
    const mixed = JSON.stringify({ v: 1, records: [rec("b", "1", 1), null, { deck: "zz" }, rec("b", "2", 2), rec("a", "3", -1)] });
    assert.deepEqual(parseRecords(mixed), [rec("b", "2", 2), rec("a", "3", -1)]);
});

test("(d) after a reload the restored record is checked against the engine like any other", async () => {
    // The page reloaded, the engine kept the track and the shift: the record still holds.
    const r = rig();
    r.byHand("b", 1);
    r.keeper.restore(parseRecords(encodeRecords([rec("b", "B1", 1)])));
    await r.keeper.check("b");
    assert.deepEqual(r.keeper.recordOn("b"), rec("b", "B1", 1));
    assert.deepEqual(r.sets, []);
    // While the page was away the deck got another track: undone on the first look.
    const q = rig();
    q.byHand("b", 1);
    q.land("b", "B9");
    q.keeper.restore([rec("b", "B1", 1)]);
    await q.keeper.check("b");
    assert.deepEqual(q.sets, [["b", 0]]);
    // ... or the DJ changed the shift meanwhile: forgotten, nothing touched.
    const s = rig();
    s.byHand("b", 5);
    s.keeper.restore([rec("b", "B1", 1)]);
    await s.keeper.check("b");
    assert.deepEqual(s.sets, []);
    assert.equal(s.events[0]?.kind, "dropped");
});

// ─── the watcher: what makes the keeper look, with fake stores ───────────────

/** A minimal store with zustand's `getState` / `subscribe(listener(state, prev))`. */
function fakeStore<S>(initial: S): Watchable<S> & { set: (next: S) => void; listeners: () => number } {
    let state = initial;
    const subs = new Set<(s: S, prev: S) => void>();
    return {
        getState: () => state,
        subscribe: (l) => {
            subs.add(l);
            return () => subs.delete(l);
        },
        set: (next) => {
            const prev = state;
            state = next;
            for (const l of subs) l(state, prev);
        },
        listeners: () => subs.size,
    };
}

type FakeDeck = DeckTrackFields & { id: DeckId; playing: boolean; position: number; tempo: number; volume: number; eqLow: number; filter: number; stemsActive: boolean };
/** What the mixer store holds, as far as these tests go (a `MixerView` with more per deck). */
interface FakeMixer {
    hydrated: boolean;
    decks: FakeDeck[];
}
/** Compile-time check: the fake is what the watcher reads. */
const asMixerView = (m: FakeMixer): MixerView => m;

function fakeDeck(id: DeckId, trackId: string | null): FakeDeck {
    return { id, trackId, loaded: trackId !== null, duration: trackId ? 200 : 0, title: trackId, artist: null, playing: false, position: 0, tempo: 1, volume: 0.85, eqLow: 0, filter: 0, stemsActive: false };
}

/** Fake mixer + perf stores wired to a keeper stand-in that records which decks it was asked to look at. */
function watchRig(records: ShiftRecord[]) {
    const mixer = fakeStore<FakeMixer>({ hydrated: true, decks: [fakeDeck("a", "A1"), fakeDeck("b", "B1"), fakeDeck("c", null), fakeDeck("d", null)] });
    assert.equal(asMixerView(mixer.getState()).decks.length, 4);
    const shift = (keyShift: number) => ({ keyShift, syncLock: false });
    const perf = fakeStore<PerfView & { decks: Record<DeckId, { keyShift: number; syncLock: boolean }> }>({ decks: { a: shift(0), b: shift(1), c: shift(0), d: shift(0) } });
    const looked: DeckId[] = [];
    let held = records;
    const keeper = {
        records: () => held,
        check: (deck: DeckId) => {
            looked.push(deck);
            return Promise.resolve();
        },
    };
    const off = watchShifts(keeper, mixer, perf);
    const patchDeck = (id: DeckId, patch: Partial<FakeDeck>) => mixer.set({ ...mixer.getState(), decks: mixer.getState().decks.map((d) => (d.id === id ? { ...d, ...patch } : d)) });
    const patchPerf = (id: DeckId, patch: Partial<{ keyShift: number; syncLock: boolean }>) => perf.set({ decks: { ...perf.getState().decks, [id]: { ...perf.getState().decks[id], ...patch } } });
    return { mixer, perf, looked, off, patchDeck, patchPerf, setRecords: (r: ShiftRecord[]) => (held = r) };
}

test("track fields: a load is seen when it starts and when it lands; nothing else is a track change", () => {
    const base: DeckTrackFields = { trackId: "1", loaded: true, duration: 200, title: "T", artist: "A" };
    assert.equal(trackFieldsChanged(base, { ...base }), false);
    assert.equal(trackFieldsChanged(base, { ...base, trackId: "2" }), true, "the optimistic id of a starting load");
    assert.equal(trackFieldsChanged(base, { ...base, duration: 201.5 }), true, "the engine's length when it lands");
    assert.equal(trackFieldsChanged(base, { ...base, title: "Other" }), true);
    assert.equal(trackFieldsChanged(base, { ...base, artist: "Other" }), true);
    assert.equal(trackFieldsChanged(base, { ...base, loaded: false }), true);
    assert.equal(trackFieldsChanged(base, null), true);
    assert.equal(trackFieldsChanged(undefined, base), true);
    assert.equal(trackFieldsChanged(null, undefined), true);
    assert.equal(trackFieldsChanged(null, null), false);
    // Extra fields (what a snapshot carries) are not looked at.
    assert.equal(trackFieldsChanged({ ...base, position: 1, playing: false } as DeckTrackFields, { ...base, position: 99, playing: true } as DeckTrackFields), false);
});

test("the watcher asks the keeper to look when the recorded deck's track or key shift changes", () => {
    const w = watchRig([rec("b", "B1", 1)]);
    // A load starts on B (optimistic id), then lands (the engine's length).
    w.patchDeck("b", { trackId: "B2", title: "B2" });
    assert.deepEqual(w.looked, ["b"]);
    w.patchDeck("b", { duration: 187.3 });
    assert.deepEqual(w.looked, ["b", "b"]);
    // The key shift of B changes in the UI store (the DJ's hand, a clock answer).
    w.patchPerf("b", { keyShift: 2 });
    assert.deepEqual(w.looked, ["b", "b", "b"]);
    // The first engine snapshot after a page reload validates what was restored.
    const cold = watchRig([rec("b", "B1", 1)]);
    cold.mixer.set({ ...cold.mixer.getState(), hydrated: false });
    cold.looked.length = 0;
    cold.mixer.set({ ...cold.mixer.getState(), hydrated: true });
    assert.deepEqual(cold.looked, ["b"]);
});

test("the watcher ignores every other deck and does nothing without a record", () => {
    const w = watchRig([rec("b", "B1", 1)]);
    // Deck A (no record) loads and changes its key shift: none of the keeper's business.
    w.patchDeck("a", { trackId: "A2", duration: 300 });
    w.patchPerf("a", { keyShift: 3 });
    assert.deepEqual(w.looked, []);
    // No record at all: track and shift changes on B are not even compared.
    const none = watchRig([]);
    none.patchDeck("b", { trackId: "B2" });
    none.patchPerf("b", { keyShift: 5 });
    assert.deepEqual(none.looked, []);
    // Unsubscribed: silent, and both listeners are gone.
    w.off();
    assert.equal(w.mixer.listeners() + w.perf.listeners(), 0);
    w.patchDeck("b", { trackId: "B9" });
    w.patchPerf("b", { keyShift: 4 });
    assert.deepEqual(w.looked, []);
});

test("(e) a transition (plan, go, its run, cancel, its end) never makes the keeper look or act", async () => {
    // Everything a transition moves on the two decks, 400 snapshots of it: transport, playhead,
    // tempo, fader, EQ, filter, stems on both decks, and the sync lock in the perf store.
    const w = watchRig([rec("b", "B1", 1)]);
    for (let i = 1; i <= 400; i++) {
        const k = i / 400;
        w.patchDeck("a", { playing: i < 380, position: 60 + i * 0.033, volume: 0.85 * (1 - k), eqLow: -26 * k, filter: -k, stemsActive: i % 2 === 0 });
        w.patchDeck("b", { playing: i > 20, position: i * 0.033, tempo: 1 + 0.02 * k, volume: 0.85 * k, eqLow: -26 * (1 - k), filter: 0 });
    }
    w.patchPerf("b", { syncLock: true });
    w.patchPerf("b", { syncLock: false });
    w.patchPerf("a", { syncLock: true });
    assert.deepEqual(w.looked, [], "no look at all during a whole run, its cancel or its end");

    // And with the real keeper behind the same watcher: the shift is still the co-pilot's and
    // nothing was sent to the engine. Then a load on that deck undoes it, so the test can fail.
    const r = rig();
    r.keeper.applied(rec("b", "B1", 1));
    r.setKeyShift("b", 1);
    r.sets.length = 0;
    const mixer = fakeStore<FakeMixer>({ hydrated: true, decks: [fakeDeck("a", "A1"), fakeDeck("b", "B1")] });
    const perf = fakeStore<PerfView>({ decks: { a: { keyShift: 0 }, b: { keyShift: 1 }, c: { keyShift: 0 }, d: { keyShift: 0 } } });
    const flights: Promise<void>[] = [];
    const off = watchShifts({ records: r.keeper.records, check: (d) => (flights.push(r.keeper.check(d)), flights.at(-1)!) }, mixer, perf);
    const patch = (id: DeckId, p: Partial<FakeDeck>) => mixer.set({ ...mixer.getState(), decks: mixer.getState().decks.map((d) => (d.id === id ? { ...d, ...p } : d)) });
    for (let i = 1; i <= 50; i++) {
        patch("a", { playing: true, position: i, volume: 1 - i / 50, eqLow: -i / 2 });
        patch("b", { playing: true, position: i, tempo: 1.01, volume: i / 50 });
    }
    await Promise.all(flights);
    assert.equal(flights.length, 0);
    assert.equal(r.asked(), 0, "the engine was not even asked");
    assert.deepEqual(r.sets, []);
    assert.deepEqual(r.keeper.recordOn("b"), rec("b", "B1", 1));
    assert.equal(r.engine.b.keyShift, 1);
    // The other side: the deck gets another track, and now the shift goes back to 0.
    r.land("b", "B2");
    patch("b", { trackId: "B2", duration: 150 });
    await Promise.all(flights);
    assert.equal(flights.length, 1);
    assert.deepEqual(r.sets, [["b", 0]]);
    off();
});

test("(e) the store's transition actions and its plain load never set a key shift", () => {
    const store = readFileSync(new URL("./copilot-store.ts", import.meta.url), "utf8");
    /** Source of one action of the store: from its header to the next action at the same indent. */
    const action = (name: string): string => {
        const start = store.indexOf(`\n        ${name}: `);
        assert.ok(start >= 0, `action ${name} not found in copilot-store.ts`);
        const rest = store.slice(start + 1);
        const end = rest.slice(1).search(/\n        [a-zA-Z]+: (async )?\(/);
        return end < 0 ? rest : rest.slice(0, end + 1);
    };
    const touches = /setKeyShift|loadShifted|applyProposal|keeper\./;
    for (const name of ["load", "planMix", "go", "cancel", "dropPlan", "checkPlan", "setPlanOpts", "refreshSafety", "refresh", "ask", "probe"]) {
        const src = action(name);
        assert.ok(src.length > 40, `${name}: ${src.length} characters`);
        assert.ok(!touches.test(src), `${name} must not touch a key shift`);
    }
    // The one action that does, and the helper is really able to tell (so the loop above can fail).
    assert.ok(touches.test(action("loadShifted")));
    assert.ok(action("loadShifted").includes("applyProposal("), "loadShifted goes through applyProposal (load first, then the shift)");
    // The end of a run (the progress event) sets a note and clears the plan, nothing else.
    const onProgress = /function onProgress\(p: Progress\): void \{[\s\S]*?\n\}/.exec(store)?.[0] ?? "";
    assert.ok(onProgress.includes("endNote(p)"), "onProgress not found");
    assert.ok(!touches.test(onProgress), "the end of a transition must not touch a key shift");
    // The keeper is fed by the watcher only, and sets a shift only through the performance store.
    assert.match(store, /watchShifts\(keeper, useMixerStore, usePerfStore\)/);
    assert.equal(store.split("usePerfStore.getState().setKeyShift(").length - 1, 2, "one call in the keeper's deps, one in loadShifted");
});
