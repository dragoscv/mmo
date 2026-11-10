import { describe, expect, it } from "vitest";
import {
    applyOptimistic,
    currentPart,
    deletePreset,
    initialProtocol,
    isLearning,
    linToDb,
    midiLearn,
    midiSettings,
    midiUnbind,
    moveItem,
    noteName,
    parseServer,
    parseSetlist,
    reduce,
    sourceLabel,
    targetKey,
    trackPending,
    wireChannel,
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

describe("MIDI and preset messages (serde shapes of live_engine::control::Control)", () => {
    it("builds delete_preset and midi_learn with a kind-tagged target or null", () => {
        expect(deletePreset("Pop Polish")).toEqual({ type: "delete_preset", name: "Pop Polish" });
        expect(JSON.parse(JSON.stringify(midiLearn({ kind: "param", fx: "reverb", param: "mix" })))).toEqual({
            type: "midi_learn",
            target: { kind: "param", fx: "reverb", param: "mix" },
        });
        expect(midiLearn({ kind: "action", action: "toggle_bypass" })).toEqual({ type: "midi_learn", target: { kind: "action", action: "toggle_bypass" } });
        expect(midiLearn({ kind: "mix", field: "monitor_dry" })).toEqual({ type: "midi_learn", target: { kind: "mix", field: "monitor_dry" } });
        // null must be sent explicitly (cancel), not dropped.
        expect(JSON.stringify(midiLearn(null))).toBe('{"type":"midi_learn","target":null}');
    });

    it("builds midi_unbind and midi_settings with only the given fields, channel clamped to 0..16", () => {
        expect(midiUnbind(2)).toEqual({ type: "midi_unbind", index: 2 });
        expect(midiUnbind(-1)).toEqual({ type: "midi_unbind", index: 0 });
        expect(midiSettings({ program_change: false })).toEqual({ type: "midi_settings", program_change: false });
        expect(midiSettings({ channel: 0 })).toEqual({ type: "midi_settings", channel: 0 });
        expect(midiSettings({ channel: 99 })).toEqual({ type: "midi_settings", channel: 16 });
        expect(JSON.stringify(midiSettings({}))).toBe('{"type":"midi_settings"}');
    });

    it("maps the 0-based map channel to the 1..16 wire channel and labels sources", () => {
        expect(wireChannel(null)).toBe(0);
        expect(wireChannel(undefined)).toBe(0);
        expect(wireChannel(0)).toBe(1);
        expect(wireChannel(15)).toBe(16);
        expect(sourceLabel({ kind: "cc", channel: 0, number: 80 }, "omni")).toBe("CC 80 · 1");
        expect(sourceLabel({ kind: "note", channel: null, number: 36 }, "omni")).toBe("Note 36 · omni");
    });

    it("matches the armed learn target by value", () => {
        const t = { kind: "param", fx: "reverb", param: "mix" } as const;
        expect(isLearning({ kind: "param", fx: "reverb", param: "mix" }, t)).toBe(true);
        expect(isLearning({ kind: "param", fx: "reverb", param: "size" }, t)).toBe(false);
        expect(isLearning(null, t)).toBe(false);
        expect(targetKey({ kind: "enable", fx: "delay" })).not.toBe(targetKey({ kind: "param", fx: "delay", param: "enable" }));
    });

    it("accepts a state with midi + factory_presets and one without (older engines)", () => {
        const withMidi = state(1, {
            factory_presets: ["Natural Vocal"],
            midi: { map: { bindings: [], program_change: true, channel: null }, learning: null, ports: ["Pedal"], last: "cc 1/4 = 10" },
        });
        expect(parseServer(JSON.stringify({ type: "state", state: withMidi }))?.type).toBe("state");
        expect(parseServer(JSON.stringify({ type: "state", state: state(2) }))?.type).toBe("state");
    });
});
