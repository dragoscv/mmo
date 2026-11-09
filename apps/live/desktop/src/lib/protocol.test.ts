import { describe, expect, it } from "vitest";
import {
    applyOptimistic,
    currentPart,
    initialProtocol,
    linToDb,
    moveItem,
    noteName,
    parseServer,
    parseSetlist,
    reduce,
    trackPending,
    type SessionState,
} from "./protocol";

const state = (revision: number, over: Partial<SessionState> = {}): SessionState => ({
    preset: "Natural Vocal",
    chain: [
        { id: 1, fx: "eq", enabled: true, params: [["low_gain", 0], ["high_gain", 2]] },
        { id: 2, fx: "compressor", enabled: true, params: [["ratio", 3]] },
        { id: 3, fx: "reverb", enabled: false, params: [["mix", 0.2]] },
    ],
    mix: { input_db: 0, main_db: 0, monitor_db: -6, monitor_dry: 0, bypass: false, mute: false },
    setlist: null,
    position: null,
    presets: ["Natural Vocal", "Pop Polish"],
    bpm: null,
    revision,
    ...over,
});

describe("parseServer", () => {
    it("accepts known types and ignores unknown ones (forward compatible)", () => {
        expect(parseServer('{"type":"ack","id":4}')).toEqual({ type: "ack", id: 4 });
        expect(parseServer('{"type":"future_thing","x":1}')).toBeNull();
        expect(parseServer("not json")).toBeNull();
        expect(parseServer('{"type":"state","state":{"chain":"bad"}}')).toBeNull();
        expect(parseServer(JSON.stringify({ type: "state", state: state(1) }))?.type).toBe("state");
    });
});

describe("reduce", () => {
    it("flags a newer protocol as incompatible", () => {
        const s = reduce(initialProtocol, { type: "hello", protocol: 2, version: "9", role: "controller", engine_name: "x" });
        expect(s.incompatible).toBe(true);
        expect(s.hello?.role).toBe("controller");
    });

    it("never moves state back to an older revision", () => {
        const a = reduce(initialProtocol, { type: "state", state: state(5) });
        const b = reduce(a, { type: "state", state: state(4, { preset: "old" }) });
        expect(b.state?.preset).toBe("Natural Vocal");
        const c = reduce(b, { type: "state", state: state(6, { preset: "Pop Polish" }) });
        expect(c.state?.preset).toBe("Pop Polish");
    });

    it("clears pending ids on ack and error", () => {
        let s = trackPending(trackPending(initialProtocol, 1), 2);
        s = reduce(s, { type: "ack", id: 1 });
        expect(s.pending).toEqual([2]);
        s = reduce(s, { type: "error", id: 2, code: "unknown_fx", message: "nope" });
        expect(s.pending).toEqual([]);
        expect(s.lastError).toEqual({ id: 2, code: "unknown_fx", message: "nope" });
    });
});

describe("applyOptimistic", () => {
    it("updates a param, the mix and the order without touching others", () => {
        const s0 = state(1);
        const s1 = applyOptimistic(s0, { type: "set_param", insert: 1, param: "high_gain", value: 4 });
        expect(s1?.chain[0]?.params).toEqual([["low_gain", 0], ["high_gain", 4]]);
        expect(s1?.chain[1]).toBe(s0.chain[1]);
        const s2 = applyOptimistic(s1, { type: "set_mix", bypass: true });
        expect(s2?.mix).toEqual({ ...s0.mix, bypass: true });
        const s3 = applyOptimistic(s2, { type: "move_insert", insert: 3, to: 0 });
        expect(s3?.chain.map((c) => c.id)).toEqual([3, 1, 2]);
        const s4 = applyOptimistic(s3, { type: "remove_insert", insert: 1 });
        expect(s4?.chain.map((c) => c.id)).toEqual([3, 2]);
        expect(s0.chain.map((c) => c.id)).toEqual([1, 2, 3]);
    });

    it("clamps move targets like the engine", () => {
        expect(moveItem([1, 2, 3], (x) => x === 1, 99)).toEqual([2, 3, 1]);
        expect(moveItem([1, 2, 3], (x) => x === 9, 0)).toEqual([1, 2, 3]);
    });
});

describe("setlists", () => {
    const sl = { name: "Gig", songs: [{ title: "A", parts: [{ name: "Verse", preset: "Natural Vocal" }, { name: "Chorus", preset: "Pop Polish" }] }] };

    it("validates files and resolves the current part", () => {
        expect(parseSetlist(JSON.stringify(sl))?.name).toBe("Gig");
        expect(parseSetlist('{"name":"x","songs":[]}')).toBeNull();
        expect(parseSetlist('{"name":"x","songs":[{"title":"t","parts":[{"name":1}]}]}')).toBeNull();
        const cur = currentPart(state(1, { setlist: sl, position: { song: 0, part: 1 } }));
        expect(cur?.part.name).toBe("Chorus");
        expect(currentPart(state(1, { setlist: sl, position: { song: 3, part: 0 } }))).toBeNull();
    });
});

describe("helpers", () => {
    it("names notes and converts levels", () => {
        expect(noteName(69)).toBe("A4");
        expect(noteName(60.4)).toBe("C4");
        expect(noteName(-1)).toBe("–");
        expect(linToDb(1)).toBeCloseTo(0);
        expect(linToDb(0)).toBe(-90);
    });
});
