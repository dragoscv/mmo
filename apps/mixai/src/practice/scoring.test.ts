// Run: node --test apps/mixai/src/practice/scoring.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    BLEND_BONUS,
    BLEND_BONUS_MAX,
    CONTROL_WINDOW_SEC,
    addSample,
    beatPhaseError,
    buildSample,
    foldedPhaseError,
    keyScore,
    levelControls,
    meterCells,
    newSession,
    phaseScore,
    shiftCamelot,
    sideGain,
    summarize,
    tempoDrift,
    tempoFold,
    tempoScore,
    toDb,
    type MixClockDeck,
    type MixDeck,
    type PracticeSample,
    type PracticeSession,
} from "./scoring.ts";

/** Level controls at rest: crossfader centred, master 0.85, two decks playing with the faders up. */
const REST: readonly number[] = [0, 0.85, 1, 0.85, 0, 1, 0.85, 0];
/** The same with the channel fader of deck B at `v` (the DJ moved it). */
const fader = (v: number): number[] => [0, 0.85, 1, 0.85, 0, 1, v, 0];

/** A sample of a clean mix (126 BPM both, beats together, same key, steady level, fader centred). */
function sample(t: number, patch: Partial<PracticeSample> = {}): PracticeSample {
    return { t, bpmA: 126, bpmB: 126, phaseErrBeats: 0, keyA: "8A", keyB: "8A", masterDb: -12, crossfader: 0, controls: REST, ...patch };
}

/** Feed samples every 250 ms from `from` to `to` seconds (inclusive). */
function run(s: PracticeSession, from: number, to: number, patch: (t: number) => Partial<PracticeSample> = () => ({})): PracticeSession {
    let out = s;
    for (let i = Math.round(from * 4); i <= Math.round(to * 4); i++) out = addSample(out, sample(i / 4, patch(i / 4)));
    return out;
}

const near = (actual: number | null, expected: number, eps = 1e-6) => assert.ok(actual !== null && Math.abs(actual - expected) < eps, `${actual} is not ${expected}`);

test("a clean mix scores 100 with no tips", () => {
    const sum = summarize(run(newSession(), 0, 20));
    assert.equal(sum.score, 100);
    assert.deepEqual(sum.sub, { tempo: 1, phase: 1, key: 1, level: 1 });
    assert.deepEqual(sum.tips, []);
    near(sum.mixSec, 20);
    assert.equal(sum.jumps, 0);
});

test("no score until two decks are in the mix", () => {
    const solo = summarize(run(newSession(), 0, 10, () => ({ bpmB: null })));
    assert.equal(solo.score, null);
    assert.deepEqual(solo.sub, { tempo: null, phase: null, key: null, level: 1 });
    assert.deepEqual(solo.tips, []);
    assert.equal(summarize(newSession()).score, null);
    // The first sample alone stands for no time.
    assert.equal(summarize(addSample(newSession(), sample(5))).score, null);
});

test("tempo drift: thresholds, half time, and the tip", () => {
    near(tempoDrift(126, 126), 0);
    near(tempoDrift(120, 121.2), 0.01);
    near(tempoDrift(140, 70), 0, 1e-12);
    near(tempoDrift(87, 174), 0, 1e-12);
    assert.equal(tempoScore(0.002), 1);
    assert.equal(tempoScore(0.03), 0);
    near(tempoScore(0.016), 0.5);
    // 126 against 128.52 = 2 % apart for the whole mix.
    const sum = summarize(run(newSession(), 0, 20, () => ({ bpmB: 128.52 })));
    near(sum.sub.tempo, (0.03 - 0.02) / 0.028, 1e-9);
    assert.deepEqual(sum.tips, ["tempo_drift"]);
    // (0.357 * 0.3 + 0.3 + 0.2 + 0.2) = 0.807
    assert.equal(sum.score, 81);
});

test("phase error: thresholds, wrap-around, and the tip", () => {
    assert.equal(phaseScore(0.03), 1);
    assert.equal(phaseScore(-0.03), 1);
    assert.equal(phaseScore(0.25), 0);
    assert.equal(phaseScore(-0.5), 0);
    near(phaseScore(0.14), 0.5);
    near(beatPhaseError(10.9, 12.0), -0.1);
    near(beatPhaseError(8.25, 3.0), 0.25);
    assert.equal(beatPhaseError(4, 2), 0);
    assert.equal(beatPhaseError(4.5, 2), -0.5);
    const sum = summarize(run(newSession(), 0, 20, () => ({ phaseErrBeats: 0.2 })));
    near(sum.sub.phase, (0.25 - 0.2) / 0.22, 1e-9);
    assert.deepEqual(sum.tips, ["phase_off"]);
});

test("key clash gets a tip; an unknown key is not judged", () => {
    assert.equal(keyScore("8A", "8A"), 1);
    assert.equal(keyScore("8A", "9A"), 0.85);
    assert.equal(keyScore("8A", "2A"), 0);
    assert.equal(keyScore("8A", null), null);
    assert.equal(keyScore("H", "8A"), null);
    const clash = summarize(run(newSession(), 0, 10, () => ({ keyB: "2A" })));
    assert.equal(clash.sub.key, 0);
    assert.deepEqual(clash.tips, ["key_clash"]);
    assert.equal(clash.score, 80);
    const unknown = summarize(run(newSession(), 0, 10, () => ({ keyB: null })));
    assert.equal(unknown.sub.key, null);
    assert.equal(unknown.score, 100);
});

test("a master step of more than 6 dB within a second, made by a fader, is one jump", () => {
    // The DJ pushes a fader at second 5: -12 dB, then -2 dB. One jump, counted once.
    const push = (t: number) => ({ controls: t >= 5 ? fader(1) : fader(0.4) });
    const up = summarize(run(newSession(), 0, 12, (t) => ({ masterDb: t >= 5 ? -2 : -12, ...push(t) })));
    assert.equal(up.jumps, 1);
    near(up.sub.level, 0.8, 1e-9);
    assert.deepEqual(up.tips, []);
    // The same step down is a jump too (it shows one second after the move).
    assert.equal(summarize(run(newSession(), 0, 12, (t) => ({ masterDb: t >= 5 ? -20 : -8, ...push(t) }))).jumps, 1);
    // 5 dB is not.
    assert.equal(summarize(run(newSession(), 0, 12, (t) => ({ masterDb: t >= 5 ? -7 : -12, ...push(t) }))).jumps, 0);
    // Exactly 6 dB is not (more than 6).
    assert.equal(summarize(run(newSession(), 0, 12, (t) => ({ masterDb: t >= 5 ? -6 : -12, ...push(t) }))).jumps, 0);
    // A fade of 10 dB over ten seconds is not.
    const ride = (t: number) => Math.min(10, Math.max(0, t - 2));
    assert.equal(summarize(run(newSession(), 0, 14, (t) => ({ masterDb: -12 + ride(t), controls: fader(0.4 + ride(t) * 0.06) }))).jumps, 0);
});

test("a break into a drop in the music is not a jump when no control moved", () => {
    // Programme dynamics: a quiet break at -18 dB, the drop at -4 dB, three times over. The DJ
    // touches nothing. The old detector counted every drop and blamed the trim and the faders.
    const music = (t: number) => ({ masterDb: Math.floor(t / 8) % 2 === 0 ? -18 : -4 });
    const sum = summarize(run(newSession(), 0, 48, music));
    assert.equal(sum.jumps, 0);
    assert.equal(sum.sub.level, 1);
    assert.deepEqual(sum.tips, [], "no level tip for what the music does");
    assert.equal(sum.score, 100);
    // The same level curve WITH a fader slammed at each step is five jumps and the tip.
    const slammed = summarize(run(newSession(), 0, 48, (t) => ({ ...music(t), controls: fader(Math.floor(t / 8) % 2 === 0 ? 0.3 : 1) })));
    assert.equal(slammed.jumps, 5);
    assert.deepEqual(slammed.tips, ["level_jump"]);
    // A control moved long before the drop does not explain it ...
    const early = summarize(run(newSession(), 0, 30, (t) => ({ masterDb: t >= 20 ? -4 : -18, controls: t >= 10 ? fader(1) : fader(0.9) })));
    assert.equal(early.jumps, 0);
    // ... one moved just before it does (the window is CONTROL_WINDOW_SEC).
    const just = 20 - CONTROL_WINDOW_SEC + 0.5;
    const late = summarize(run(newSession(), 0, 30, (t) => ({ masterDb: t >= 20 ? -4 : -18, controls: t >= just ? fader(1) : fader(0.5) })));
    assert.equal(late.jumps, 1);
    // Noise under one percent of travel is not a move; a slow ride that adds up is.
    const jitter = summarize(run(newSession(), 0, 30, (t) => ({ masterDb: t >= 20 ? -4 : -18, controls: fader(0.85 + (Math.round(t * 4) % 2) * 0.004) })));
    assert.equal(jitter.jumps, 0);
    const creep = summarize(run(newSession(), 0, 30, (t) => ({ masterDb: t >= 20 ? -4 : -18, controls: fader(0.5 + Math.max(0, Math.min(2, t - 19)) * 0.2) })));
    assert.equal(creep.jumps, 1);
    // Starting the second deck (no fader touched) is a control too: the step it makes counts.
    const started = (t: number): number[] => [0, 0.85, 1, 0.85, 0, t >= 20 ? 1 : 0, 0.85, 0];
    assert.equal(summarize(run(newSession(), 0, 30, (t) => ({ masterDb: t >= 20 ? -4 : -18, controls: started(t) }))).jumps, 1);
    // A sample without the field (an older caller) never counts a jump rather than guessing.
    const bare = run(newSession(), 0, 30, (t) => ({ masterDb: t >= 20 ? -4 : -18, controls: undefined as unknown as number[] }));
    assert.equal(summarize(bare).jumps, 0);
});

test("starting from silence, stopping and a short dip are not jumps", () => {
    const start = run(newSession(), 0, 8, (t) => ({ masterDb: t < 3 ? null : -6 }));
    assert.equal(start.jumps, 0);
    const stop = run(newSession(), 0, 8, (t) => ({ masterDb: t < 4 ? -6 : null }));
    assert.equal(stop.jumps, 0);
    // Levels under the floor are silence too.
    assert.equal(run(newSession(), 0, 8, (t) => ({ masterDb: t < 4 ? -6 : -60 })).jumps, 0);
    // One quiet reading between kicks does not move the loudest of the second.
    assert.equal(run(newSession(), 0, 8, (t) => ({ masterDb: t === 4 ? -30 : -6 })).jumps, 0);
});

test("two steps count twice, and many jumps bring the tip", () => {
    const loud = (t: number) => Math.floor(t / 5) % 2 !== 0;
    const steps = run(newSession(), 0, 30, (t) => ({ masterDb: loud(t) ? -6 : -20, controls: fader(loud(t) ? 1 : 0.3) }));
    const sum = summarize(steps);
    assert.equal(sum.jumps, 5);
    assert.equal(sum.sub.level, 0);
    assert.deepEqual(sum.tips, ["level_jump"]);
    assert.equal(sum.score, 80);
});

test("a slow crossfade with the decks in time is a good blend", () => {
    // A side for 3 s, 10 s travel to the B side, 3 s on B.
    const xf = (t: number) => (t <= 3 ? -1 : t >= 13 ? 1 : -1 + ((t - 3) / 10) * 2);
    const sum = summarize(run(newSession(), 0, 16, (t) => ({ crossfader: xf(t) })));
    assert.equal(sum.blends, 1);
    assert.deepEqual(sum.tips, ["good_blend"]);
    assert.equal(sum.score, 100, "capped at 100");
    // Back again later: two blends.
    const back = (t: number) => (t <= 16 ? xf(t) : t >= 30 ? -1 : 1 - ((t - 16) / 14) * 2);
    assert.equal(summarize(run(newSession(), 0, 32, (t) => ({ crossfader: back(t) }))).blends, 2);
});

test("a fast cut, an out-of-time fade and a half-way fade are not blends", () => {
    const cut = (t: number) => (t < 5 ? -1 : 1);
    assert.equal(summarize(run(newSession(), 0, 10, (t) => ({ crossfader: cut(t) }))).blends, 0);
    // 4 s travel: too fast.
    const quick = (t: number) => (t <= 3 ? -1 : t >= 7 ? 1 : -1 + ((t - 3) / 4) * 2);
    assert.equal(summarize(run(newSession(), 0, 10, (t) => ({ crossfader: quick(t) }))).blends, 0);
    // 10 s travel with the beats a quarter apart.
    const slow = (t: number) => (t <= 3 ? -1 : t >= 13 ? 1 : -1 + ((t - 3) / 10) * 2);
    assert.equal(summarize(run(newSession(), 0, 16, (t) => ({ crossfader: slow(t), phaseErrBeats: 0.25 }))).blends, 0);
    // Out to the middle and back to the same side.
    const there = (t: number) => (t <= 3 || t >= 15 ? -1 : -1 + Math.min(t - 3, 15 - t) / 6);
    assert.equal(summarize(run(newSession(), 0, 18, (t) => ({ crossfader: there(t) }))).blends, 0);
});

test("the blend bonus lifts the score and is capped", () => {
    const base = run(newSession(), 0, 20, () => ({ keyB: "2A" }));
    assert.equal(summarize(base).score, 80);
    assert.equal(summarize({ ...base, blends: 1 }).score, 80 + BLEND_BONUS);
    assert.equal(summarize({ ...base, blends: 9 }).score, 80 + BLEND_BONUS_MAX);
});

test("tips: the weakest first, three at most, praise last", () => {
    // Tempo 4 % off (0), beats 0.2 apart (0.23), clashing keys (0), and five level steps.
    const loud = (t: number) => Math.floor(t / 5) % 2 !== 0;
    const bad = run(newSession(), 0, 30, (t) => ({ bpmB: 131.04, phaseErrBeats: 0.2, keyB: "2A", masterDb: loud(t) ? -6 : -20, controls: fader(loud(t) ? 1 : 0.3) }));
    const sum = summarize(bad);
    assert.deepEqual(sum.tips, ["tempo_drift", "key_clash", "level_jump"]);
    assert.equal(sum.score, Math.round(((0.05 / 0.22) * 0.3) * 100));
    // One weak criterion and a blend: the fix comes before the praise.
    assert.deepEqual(summarize({ ...run(newSession(), 0, 10, () => ({ keyB: "2A" })), blends: 1 }).tips, ["key_clash", "good_blend"]);
});

test("gaps and bad clocks do not count as mixing time", () => {
    let s = run(newSession(), 0, 2);
    s = addSample(s, sample(100));
    near(summarize(s).mixSec, 2);
    // Half a second apart counts in full, one and a half seconds as one.
    s = addSample(s, sample(100.5));
    s = addSample(s, sample(102));
    near(summarize(s).mixSec, 3.5);
    // Time going back, NaN: ignored.
    s = addSample(s, sample(50));
    near(summarize(s).mixSec, 3.5);
    assert.equal(addSample(s, sample(Number.NaN)), s);
    // A gap in the middle of a crossfade drops it.
    let b = run(newSession(), 0, 3, () => ({ crossfader: -1 }));
    b = run(b, 3.25, 5, () => ({ crossfader: 0 }));
    b = run(b, 60, 70, (t) => ({ crossfader: t >= 62 ? 1 : 0 }));
    assert.equal(summarize(b).blends, 0);
});

test("bad numbers in a sample are treated as unknown", () => {
    const s = run(newSession(), 0, 4, () => ({ bpmA: Number.NaN, phaseErrBeats: Number.POSITIVE_INFINITY, masterDb: Number.NaN, crossfader: Number.NaN }));
    const sum = summarize(s);
    assert.equal(sum.score, null);
    assert.deepEqual(sum.sub, { tempo: null, phase: null, key: null, level: null });
    assert.equal(summarize(run(newSession(), 0, 4, () => ({ bpmB: 0 }))).score, null);
    assert.equal(summarize(run(newSession(), 0, 4, () => ({ bpmB: -126 }))).score, null);
});

test("meter cells", () => {
    assert.equal(meterCells(null), 0);
    assert.equal(meterCells(0), 0);
    assert.equal(meterCells(0.09), 0);
    assert.equal(meterCells(0.1), 1);
    assert.equal(meterCells(0.5), 3);
    assert.equal(meterCells(0.89), 4);
    assert.equal(meterCells(1), 5);
    assert.equal(meterCells(7), 5);
});

function deck(id: string, patch: Partial<MixDeck> = {}): MixDeck {
    return { id, loaded: true, playing: true, volume: 0.85, crossfaderAssign: id === "a" || id === "c" ? "a" : "b", bpm: 120, tempo: 1, ...patch };
}

test("buildSample: the two audible playing decks, clock tempo and beat phase, keys, level", () => {
    const mix = { decks: [deck("a"), deck("b"), deck("c", { loaded: false, playing: false }), deck("d", { playing: false })], crossfader: 0, masterVu: 0.5 };
    const clock = [
        { id: "a", bpm: 129.2, beat: 40.0, barPhase: 0 },
        { id: "b", bpm: 120.2, beat: 12.9, barPhase: 0.9 },
    ];
    const s = buildSample(7, mix, clock, { a: "8A", b: "9A", c: null, d: null });
    assert.equal(s.t, 7);
    assert.equal(s.bpmA, 129.2);
    assert.equal(s.bpmB, 120.2);
    near(s.phaseErrBeats, -0.1);
    assert.equal(s.keyA, "8A");
    assert.equal(s.keyB, "9A");
    near(s.masterDb, 20 * Math.log10(0.5));
    assert.equal(s.crossfader, 0);
});

test("buildSample: a deck that is paused, closed or faded out is not in the mix", () => {
    const clock = [
        { id: "a", bpm: 126, beat: 1, barPhase: null },
        { id: "b", bpm: 126, beat: 1, barPhase: null },
    ];
    const keys = { a: "8A", b: "8A" };
    const mixing = (decks: MixDeck[], crossfader = 0) => buildSample(0, { decks, crossfader, masterVu: 0 }, clock, keys).bpmB !== null;
    assert.equal(mixing([deck("a"), deck("b")]), true);
    assert.equal(mixing([deck("a"), deck("b", { playing: false })]), false);
    assert.equal(mixing([deck("a"), deck("b", { volume: 0 })]), false, "headphone preparation is not judged");
    assert.equal(mixing([deck("a"), deck("b")], -1), false, "crossfader fully on A");
    assert.equal(mixing([deck("a"), deck("b", { crossfaderAssign: "thru" })], -1), true, "thru ignores the crossfader");
    assert.equal(mixing([deck("a"), deck("b")], -0.8), true);
    // Silence on the master, no clock yet: tempo from the grid, phase unknown.
    const s = buildSample(0, { decks: [deck("a", { bpm: 120, tempo: 1.05 }), deck("b", { bpm: 0 })], crossfader: 0, masterVu: 0 }, null, {});
    near(s.bpmA, 126);
    assert.equal(s.bpmB, null);
    assert.equal(s.phaseErrBeats, null);
    assert.equal(s.masterDb, null);
    assert.equal(s.keyA, null);
});

test("side gain and dB helpers", () => {
    assert.deepEqual(tempoFold(126, 126), { factor: 1, ratio: 1 });
    assert.deepEqual(tempoFold(87, 174), { factor: 2, ratio: 1 });
    assert.deepEqual(tempoFold(174, 87), { factor: 0.5, ratio: 1 });
    assert.deepEqual(tempoFold(60, 240), { factor: 4, ratio: 1 });
    assert.equal(tempoFold(120, 126).factor, 1);
    assert.equal(tempoFold(126, 0).factor, 1);
    assert.ok(Number.isNaN(tempoFold(126, 0).ratio));
    assert.equal(sideGain(-1, "a"), 1);
    assert.equal(sideGain(1, "a"), 0);
    assert.equal(sideGain(1, "b"), 1);
    assert.equal(sideGain(0, "b"), 0.5);
    assert.equal(sideGain(5, "thru"), 1);
    assert.equal(toDb(0), null);
    assert.equal(toDb(1), 0);
    assert.equal(toDb(3), 0);
    near(toDb(0.1), -20);
});

/** A mix of deck A at `bpmA` and deck B at `bpmB`, `sec` seconds after both stood on beat 0, with deck B `lateBeats` of ITS beats behind. */
function mixAt(bpmA: number, bpmB: number, sec: number, lateBeats = 0): PracticeSample {
    const clock: MixClockDeck[] = [
        { id: "a", bpm: bpmA, beat: (sec * bpmA) / 60, barPhase: null },
        { id: "b", bpm: bpmB, beat: (sec * bpmB) / 60 - lateBeats, barPhase: null },
    ];
    return buildSample(sec, { decks: [deck("a"), deck("b")], crossfader: 0, masterVu: 0.25, masterVolume: 0.85 }, clock, { a: "8A", b: "8A" });
}

test("a locked half-time mix has its beats together (87 against 174 BPM)", () => {
    // Sampled four times a second for 40 s: without the fold the plain beat difference sweeps
    // -0.5..0.5 (the slow deck's beat number advances half as fast), the phase scores about
    // 0.28, the tip says "beats do not land together" and no blend is ever earned.
    let s = newSession();
    let worst = 0;
    for (let i = 0; i <= 160; i++) {
        const x = mixAt(87, 174, i / 4);
        worst = Math.max(worst, Math.abs(x.phaseErrBeats ?? 1));
        s = addSample(s, x);
    }
    assert.ok(worst < 1e-9, `phase error up to ${worst} in a locked mix`);
    const sum = summarize(s);
    assert.equal(sum.sub.tempo, 1);
    near(sum.sub.phase, 1, 1e-9);
    assert.deepEqual(sum.tips, []);
    assert.equal(sum.score, 100);
    // The other way round (the fast deck is deck A) and two octaves apart.
    for (const [a, b] of [
        [174, 87],
        [70, 140],
        [60, 240],
        [240, 60],
    ] as const) {
        for (let i = 0; i <= 80; i++) near(mixAt(a, b, i / 4).phaseErrBeats, 0, 1e-9);
    }
});

test("a half-time mix that is really off still scores off, and earns a blend when it is not", () => {
    // Deck B (174) a quarter of its beat late: every sample reads a quarter beat, as at 1:1.
    for (let i = 0; i <= 40; i++) near(mixAt(87, 174, i / 4, 0.25).phaseErrBeats, -0.25, 1e-9);
    // The slow deck is deck B and it is late by a tenth of ITS beat = a fifth of a fast beat.
    for (let i = 0; i <= 40; i++) near(mixAt(174, 87, i / 4, 0.1).phaseErrBeats, -0.2, 1e-9);
    // The fold itself.
    near(foldedPhaseError(10, 20, 2), 0);
    near(foldedPhaseError(10.5, 21, 2), 0, 1e-12);
    near(foldedPhaseError(10.25, 20.5, 2), 0, 1e-12);
    near(foldedPhaseError(10, 20.3, 2), 0.3);
    near(foldedPhaseError(20, 10, 0.5), 0);
    near(foldedPhaseError(21, 10.5, 0.5), 0, 1e-12);
    near(foldedPhaseError(20.3, 10, 0.5), -0.3);
    near(foldedPhaseError(8.25, 3, 1), -0.25, 1e-12);
    assert.equal(foldedPhaseError(4, 2, 1), beatPhaseError(2, 4));
    assert.equal(foldedPhaseError(4, 2, Number.NaN), beatPhaseError(2, 4));
    assert.equal(foldedPhaseError(4, 2, 0), beatPhaseError(2, 4));
    // A slow crossfade over a locked 87 / 174 mix is a good blend (it never was before).
    const xf = (t: number) => (t <= 3 ? -0.95 : t >= 13 ? 0.95 : -0.95 + ((t - 3) / 10) * 1.9);
    let s = newSession();
    for (let i = 0; i <= 64; i++) s = addSample(s, { ...mixAt(87, 174, i / 4), crossfader: xf(i / 4) });
    assert.equal(summarize(s).blends, 1);
    // Same tempo, as before: the plain difference.
    near(mixAt(126, 126, 7.25, 0.1).phaseErrBeats, -0.1, 1e-9);
});

test("level controls: one entry per control, scaled to its travel", () => {
    const mix = { decks: [deck("a"), deck("b", { playing: false, volume: 0.5 })], crossfader: 1, masterVu: 0, masterVolume: 0.8 };
    assert.deepEqual(levelControls(mix, { a: 12, b: -6 }), [0.5, 0.8, 1, 0.85, 12 / 36, 0, 0.5, -6 / 36]);
    // No trims known, no master volume: zeros, never NaN.
    assert.deepEqual(levelControls({ decks: [deck("a")], crossfader: -1, masterVu: 0 }), [-0.5, 0, 1, 0.85, 0]);
    assert.deepEqual(levelControls({ decks: [], crossfader: Number.NaN, masterVu: 0, masterVolume: Number.NaN }), [0, 0]);
    // A sample carries them.
    assert.deepEqual(buildSample(0, mix, null, {}, { a: 12, b: -6 }).controls, levelControls(mix, { a: 12, b: -6 }));
});

test("a key-shifted deck is judged in the key it sounds in", () => {
    // One semitone up: A minor (8A) becomes B flat minor (3A); down: G sharp minor (1A).
    assert.equal(shiftCamelot("8A", 1), "3A");
    assert.equal(shiftCamelot("8A", -1), "1A");
    assert.equal(shiftCamelot("8B", 2), "10B");
    assert.equal(shiftCamelot("12b", 12), "12B");
    assert.equal(shiftCamelot("8A", 0.4), "8A");
    assert.equal(shiftCamelot("8A", Number.NaN), "8A");
    assert.equal(shiftCamelot(null, 3), null);
    assert.equal(shiftCamelot("Am", 3), null);
    // 8A against 2A clashes; with deck B shifted one semitone up it sounds in 9A: adjacent.
    const mix = { decks: [deck("a"), deck("b")], crossfader: 0, masterVu: 0.5 };
    const clock = (shift: number) => [
        { id: "a", bpm: 126, beat: 0, barPhase: null },
        { id: "b", bpm: 126, beat: 0, barPhase: null, keyShift: shift },
    ];
    const plain = buildSample(0, mix, clock(0), { a: "8A", b: "2A" });
    assert.equal(keyScore(plain.keyA, plain.keyB), 0);
    const matched = buildSample(0, mix, clock(1), { a: "8A", b: "2A" });
    assert.equal(matched.keyB, "9A");
    assert.equal(keyScore(matched.keyA, matched.keyB), 0.85);
});
