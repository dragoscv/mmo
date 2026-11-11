// Run: node --test apps/mixai/src/components/panel-fit.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { MIXER, knobsFor, mixerFit, mixerUsed } from "./panel-fit.ts";
import { PANEL_SPECS } from "../layout/presets.ts";
import type { Tier } from "../layout/types.ts";

const TIERS: Tier[] = ["full", "compact", "icon"];
const min = (tier: Tier) => PANEL_SPECS.mixer.min[tier];
const fitMin = (tier: Tier, channels: number) => mixerFit({ ...min(tier), channels, tier });

test("the mixer fits its minimum rect in every tier, for 2 and 4 channels (width and height)", () => {
    for (const tier of TIERS) {
        const { w, h } = min(tier);
        for (const channels of [2, 4]) {
            const fit = fitMin(tier, channels);
            const used = mixerUsed(fit);
            assert.ok(used.h <= h, `${tier}/${channels}ch needs ${used.h}px > ${h}px high`);
            assert.ok(used.w <= w, `${tier}/${channels}ch needs ${used.w}px > ${w}px wide`);
            assert.ok(fit.channelW >= MIXER.faderMinW, `${tier}/${channels}ch channel ${fit.channelW}px is narrower than a 24px target`);
            assert.ok(fit.faderW >= MIXER.faderMinW && fit.faderW <= MIXER.faderMaxW);
            assert.ok(fit.faderW + (fit.vuW > 0 ? fit.vuW + fit.vuGap : 0) <= fit.channelW, `${tier}/${channels}ch fader + meter wider than the channel`);
            if (fit.knobs.length > 0) assert.ok(fit.knob >= MIXER.knobMin, `${tier}/${channels}ch knob ${fit.knob} < 24`);
        }
    }
});

test("full tier at 240x250 with 2 channels shows every channel knob beside the fader", () => {
    const fit = fitMin("full", 2);
    assert.equal(fit.mode, "side");
    assert.deepEqual(fit.knobs, ["trim", "hi", "mid", "low", "filter"]);
    assert.equal(fit.header, "label");
    assert.equal(fit.vuW, MIXER.vuW);
    assert.equal(fit.cueIcon, false);
    assert.deepEqual(fit.master, { knob: true, sends: 2 });
});

test("the default layout box (267x272) gets larger knobs than the minimum", () => {
    const small = fitMin("full", 2);
    const normal = mixerFit({ w: 267, h: 272, channels: 2, tier: "full" });
    assert.equal(normal.knobs.length, 5);
    assert.ok(normal.knob > small.knob);
    assert.ok(normal.knob <= MIXER.knobMax);
    assert.equal(normal.master.sends, 3);
    const used = mixerUsed(normal);
    assert.ok(used.w <= 267 && used.h <= 272);
});

test("4 channels at the full minimum keep the EQ inline, stacked above the fader", () => {
    const fit = fitMin("full", 4);
    assert.equal(fit.mode, "stack");
    assert.deepEqual(fit.knobs, ["hi", "mid", "low"]);
    assert.equal(fit.header, "button");
    assert.ok(fit.knob + 2 <= fit.channelW);
});

test("compact: 2 channels show the EQ beside the fader, 4 channels move every knob to the popovers", () => {
    const two = fitMin("compact", 2);
    assert.equal(two.mode, "side");
    assert.deepEqual(two.knobs, ["hi", "mid", "low"]);
    assert.deepEqual(two.master, { knob: true, sends: 0 });
    const four = fitMin("compact", 4);
    assert.equal(four.mode, "none");
    assert.deepEqual(four.knobs, []);
    assert.equal(four.header, "button");
    assert.equal(four.cueIcon, true);
    assert.ok(four.vuW > 0);
});

test("icon: faders and cue only, master controls in the popover", () => {
    for (const channels of [2, 4]) {
        const fit = fitMin("icon", channels);
        assert.equal(fit.mode, "none");
        assert.equal(fit.knob, 0);
        assert.equal(fit.header, "none");
        assert.deepEqual(fit.master, { knob: false, sends: 0 });
    }
    assert.ok(fitMin("icon", 2).vuW > 0);
    assert.equal(fitMin("icon", 4).vuW, 0);
});

test("knobs grow with the box but never past the cap or the column", () => {
    const tall = mixerFit({ w: 240, h: 800, channels: 2, tier: "full" });
    assert.equal(tall.knob, MIXER.knobMax);
    const huge = mixerFit({ w: 2000, h: 4000, channels: 4, tier: "full" });
    assert.equal(huge.mode, "side");
    assert.equal(huge.knob, MIXER.knobMax);
    assert.equal(huge.faderW, MIXER.faderMaxW);
    // Narrow but tall: all five knobs stacked above the fader.
    const column = mixerFit({ w: 240, h: 500, channels: 4, tier: "full" });
    assert.equal(column.mode, "stack");
    assert.equal(column.knobs.length, 5);
    assert.ok(mixerUsed(column).h <= 500);
});

test("knobsFor keeps the EQ together and drops trim first", () => {
    assert.deepEqual(knobsFor(0), []);
    assert.deepEqual(knobsFor(2), ["low", "filter"]);
    assert.deepEqual(knobsFor(4), ["hi", "mid", "low", "filter"]);
    assert.equal(knobsFor(9).length, 5);
});

test("a zero-sized (not yet measured) box still yields valid sizes", () => {
    for (const tier of TIERS) {
        const fit = mixerFit({ w: 0, h: 0, channels: 2, tier });
        assert.equal(fit.mode, "none");
        assert.ok(fit.faderW >= MIXER.faderMinW);
        assert.equal(fit.master.sends, 0);
    }
});
