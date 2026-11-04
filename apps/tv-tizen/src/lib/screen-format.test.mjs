// node --experimental-strip-types --test src/lib/screen-format.test.mjs (no vitest in tv-tizen)
import test from "node:test";
import assert from "node:assert/strict";
import { aspectFromModel, squeezeFactor, videoBox } from "./screen-format.ts";

test("Odyssey G8 (LS34DG850SUXDU) is 21:9", () => {
    assert.equal(aspectFromModel("LS34DG850SUXDU"), 3440 / 1440);
    assert.equal(aspectFromModel("LC49G95TSSRXEN"), 32 / 9);
    assert.equal(aspectFromModel("QE65S95D"), null);
});

test("squeeze: native 2580x1080 viewport on Odyssey (extensive) = 1", () => {
    assert.equal(squeezeFactor("auto", "LS34DG850SUXDU", 2580 / 1080), 1);
    assert.equal(squeezeFactor("21:9", "LS34DG850SUXDU", 2580 / 1080), 1);
});

test("squeeze fallback: engine stuck at 16:9 on a 21:9 panel = 1.34375", () => {
    assert.equal(squeezeFactor("auto", "LS34DG850SUXDU", 16 / 9), (3440 / 1440) / (16 / 9));
    assert.equal(squeezeFactor("auto", "QE65S95D", 16 / 9), 1);
    assert.equal(squeezeFactor("16:9", "LS34DG850SUXDU", 16 / 9), 1);
});

test("videoBox: 2.39 film fills a 21:9 panel, 16:9 film pillarboxed correctly", () => {
    const k = (3440 / 1440) / (16 / 9);
    const scope = videoBox(2.39, k, 16 / 9);
    assert.equal(scope.w, 1);
    assert.ok(Math.abs(scope.h - 0.9995) < 0.002);
    const tv = videoBox(16 / 9, k, 16 / 9);
    assert.equal(tv.h, 1);
    assert.ok(Math.abs(tv.w - 1 / k) < 1e-9);
    // On screen: (w * 16:9 width * k stretch) / h must equal the film aspect
    assert.ok(Math.abs((tv.w * (16 / 9) * k) / tv.h - 16 / 9) < 1e-9);
});
