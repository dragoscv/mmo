// Run: node --test apps/mixai/src/components/panel-fit.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { MIXER, channelWidth, mixerFit, mixerUsedHeight } from "./panel-fit.ts";
import { PANEL_SPECS } from "../layout/presets.ts";
import type { Tier } from "../layout/types.ts";

const TIERS: Tier[] = ["full", "compact", "icon"];

test("mixer stack fits its minimum rect in every tier, for 2 and 4 channels", () => {
    for (const tier of TIERS) {
        const { w, h } = PANEL_SPECS.mixer.min[tier];
        for (const channels of [2, 4]) {
            const fit = mixerFit({ w, h, channels, tier });
            const used = mixerUsedHeight(fit, tier);
            assert.ok(used <= h, `${tier}/${channels}ch needs ${used}px > ${h}px`);
            if (fit.knobRows > 0) assert.ok(fit.knob >= MIXER.knobMin, `${tier}/${channels}ch knob ${fit.knob} < 24`);
            assert.ok(fit.faderWidth >= 18 && fit.faderWidth <= 36);
            assert.ok(fit.faderWidth <= channelWidth(w, channels), "fader wider than its column");
        }
    }
});

test("tiers expose the documented knob rows", () => {
    assert.equal(mixerFit({ w: 300, h: 600, channels: 2, tier: "full" }).knobRows, 5);
    assert.equal(mixerFit({ w: 300, h: 600, channels: 2, tier: "compact" }).knobRows, 2);
    assert.equal(mixerFit({ w: 300, h: 600, channels: 2, tier: "icon" }).knobRows, 0);
    assert.equal(mixerFit({ w: 300, h: 600, channels: 2, tier: "icon" }).knob, 0);
});

test("knobs grow with the rect but stay capped by height and column width", () => {
    const small = mixerFit({ w: 240, h: 440, channels: 2, tier: "full" });
    const tall = mixerFit({ w: 240, h: 800, channels: 2, tier: "full" });
    assert.ok(tall.knob >= small.knob);
    const huge = mixerFit({ w: 2000, h: 4000, channels: 2, tier: "full" });
    assert.equal(huge.knob, MIXER.knobMax);
    const narrow = mixerFit({ w: 240, h: 4000, channels: 4, tier: "full" });
    assert.ok(narrow.knob <= channelWidth(240, 4) - 8 || narrow.knob === MIXER.knobMin);
});

test("beat FX goes inline only when there is room for it", () => {
    assert.equal(mixerFit({ w: 240, h: 440, channels: 2, tier: "full" }).beatFxInline, false);
    const roomy = mixerFit({ w: 300, h: 760, channels: 2, tier: "full" });
    assert.equal(roomy.beatFxInline, true);
    assert.ok(mixerUsedHeight(roomy, "full") <= 760);
    assert.equal(mixerFit({ w: 300, h: 900, channels: 2, tier: "compact" }).beatFxInline, false);
});

test("a zero-sized (not yet measured) box still yields valid sizes", () => {
    const fit = mixerFit({ w: 0, h: 0, channels: 2, tier: "full" });
    assert.ok(fit.knob >= MIXER.knobMin);
    assert.ok(fit.faderWidth >= 18);
});
