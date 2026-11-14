import { describe, expect, it } from "vitest";
import en from "../i18n/en.json";
import { shapeFor, type Shape } from "./fx-visual";

/** Every effect the app has a name for, minus the tuner (analysis, not an insert). */
const INSERTS = Object.keys(en.fx).filter((fx) => fx !== "tuner");

const defaults = (_id: string, fallback: number) => fallback;
const withParam = (fx: string, id: string, value: number) =>
    shapeFor(fx, (want, fallback) => (want === id ? value : fallback));

const nonEmpty = (s: Shape) => s.lines.length + s.hlines.length + s.fills.length > 0;
const top = (s: Shape) => Math.max(...(s.lines.flatMap((l) => l.points.map(([, y]) => y)) ?? [0]));

describe("the hero visual of an effect", () => {
    it("has a specific drawing for every insert, none of them the fallback", () => {
        const fallback = JSON.stringify(shapeFor("not-an-effect", defaults));
        for (const fx of INSERTS) {
            const s = shapeFor(fx, defaults);
            expect(nonEmpty(s), `${fx} draws nothing`).toBe(true);
            expect(JSON.stringify(s), `${fx} fell through to the neutral shape`).not.toBe(fallback);
        }
    });

    it("draws something neutral for an effect it does not know yet", () => {
        expect(nonEmpty(shapeFor("brand-new-fx", defaults))).toBe(true);
    });

    it("moves with the parameters, not just with the name", () => {
        // The compressor's threshold rule sits higher (in the box) the higher the threshold is.
        const hard = withParam("compressor", "threshold", -30).hlines[0]?.y ?? 0;
        const soft = withParam("compressor", "threshold", -6).hlines[0]?.y ?? 0;
        expect(hard).toBeLessThan(soft);

        // The EQ curve lifts with a band gain and drops when it is cut.
        expect(top(withParam("eq", "low_gain", 12))).toBeGreaterThan(top(withParam("eq", "low_gain", -12)));

        // The delay draws one tap per repeat, fading with the feedback.
        const taps = (fb: number) => withParam("delay", "feedback", fb).lines.length;
        expect(taps(0.5)).toBeGreaterThan(1);
        expect(taps(0.5)).toBe(taps(0.9));

        // The reverb has a tail to fill; the gate and the limiter have a rule to respect.
        expect(withParam("reverb", "decay", 0.6).fills.length).toBe(1);
        expect(withParam("gate", "threshold", -40).hlines.length).toBe(1);
        expect(withParam("limiter", "ceiling", -3).hlines[0]?.tone).toBe("destructive");
    });

    it("keeps every point inside the box", () => {
        for (const fx of INSERTS) {
            const s = shapeFor(fx, defaults);
            for (const l of s.lines) {
                for (const [x, y] of l.points) {
                    expect(x, `${fx} x`).toBeGreaterThanOrEqual(0);
                    expect(x, `${fx} x`).toBeLessThanOrEqual(100);
                    expect(y, `${fx} y`).toBeGreaterThanOrEqual(0);
                    expect(y, `${fx} y`).toBeLessThanOrEqual(100);
                }
            }
            for (const h of s.hlines) expect(h.y, `${fx} rule`).toBeGreaterThanOrEqual(0);
        }
    });
});
