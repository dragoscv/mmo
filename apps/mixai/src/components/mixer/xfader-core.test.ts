import { test } from "node:test";
import assert from "node:assert/strict";
import { makeXfader, type XfAssign, type XfCurve, type XfPorts } from "./xfader-core.ts";

type Deck = "a" | "b" | "c" | "d";

/** Fake store + engine. `engine` decides per call: "ok", "reject", or a promise the test settles itself. */
function rig(engine: () => "ok" | "reject" | Promise<unknown>) {
    const state = { curve: "smooth" as XfCurve, assign: { a: "a", b: "b", c: "a", d: "b" } as Record<Deck, XfAssign> };
    const sent: string[] = [];
    const warnings: string[] = [];
    const answer = () => {
        const r = engine();
        return r === "ok" ? Promise.resolve(null) : r === "reject" ? Promise.reject(new Error("command set_crossfader_curve not found")) : r;
    };
    const ports: XfPorts = {
        getCurve: () => state.curve,
        putCurve: (c) => void (state.curve = c),
        getAssign: (d) => state.assign[d as Deck],
        putAssign: (d, a) => void (state.assign[d as Deck] = a),
        sendCurve: (c) => (sent.push(`curve:${c}`), answer()),
        sendAssign: (d, a) => (sent.push(`assign:${d}:${a}`), answer()),
        warn: (what) => void warnings.push(what),
    };
    return { state, sent, warnings, xf: makeXfader(ports) };
}

test("an accepted change stays, and the store is patched before the engine answers", async () => {
    const r = rig(() => "ok");
    const p = r.xf.setCurve("sharp");
    assert.equal(r.state.curve, "sharp", "optimistic");
    assert.equal(await p, true);
    assert.equal(r.state.curve, "sharp");
    assert.equal(await r.xf.setAssign("a", "thru"), true);
    assert.equal(r.state.assign.a, "thru");
    assert.deepEqual(r.sent, ["curve:sharp", "assign:a:thru"]);
    assert.deepEqual(r.warnings, []);
});

test("a refused change is rolled back to the value before it (old engine: command not found)", async () => {
    const r = rig(() => "reject");
    const p = r.xf.setCurve("linear");
    assert.equal(r.state.curve, "linear", "shown at once");
    assert.equal(await p, false);
    assert.equal(r.state.curve, "smooth", "rolled back");
    assert.equal(await r.xf.setAssign("b", "thru"), false);
    assert.equal(r.state.assign.b, "b");
    assert.equal(r.state.assign.a, "a", "other decks untouched");
});

test("setting the current value sends nothing", async () => {
    const r = rig(() => "reject");
    assert.equal(await r.xf.setCurve("smooth"), true);
    assert.equal(await r.xf.setAssign("a", "a"), true);
    assert.deepEqual(r.sent, []);
});

test("a refusal is reported once per kind, not once per click", async () => {
    const r = rig(() => "reject");
    await r.xf.setCurve("linear");
    await r.xf.setCurve("sharp");
    await r.xf.setAssign("a", "b");
    await r.xf.setAssign("b", "a");
    assert.deepEqual(r.warnings, ["curve", "assign"]);
});

test("a late refusal does not undo a newer value", async () => {
    let fail!: (e: Error) => void;
    const answers: ("ok" | Promise<unknown>)[] = [new Promise((_, rej) => (fail = rej)), "ok"];
    const r = rig(() => answers.shift()!);
    const first = r.xf.setCurve("linear"); // pending
    assert.equal(await r.xf.setCurve("sharp"), true); // newer click, accepted
    fail(new Error("late"));
    assert.equal(await first, false);
    assert.equal(r.state.curve, "sharp", "the newer value survives the older refusal");
});
