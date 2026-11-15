/**
 * The hero visual of one effect (WP21-20, direction A): a small, effect-specific drawing driven by
 * the insert's current parameters — the gate's threshold, the compressor's transfer curve, the EQ's
 * response, the delay's taps, the reverb's decay — so a glance at the chain reads as sound rather
 * than as a list of names.
 *
 * Pure geometry, no UI: a 0..100 box with **y up**, so it can be tested without a DOM and rendered
 * by `FxVisual` with the design-token colours.
 */
export type Tone = "primary" | "muted" | "warning" | "destructive";

export interface Shape {
    /** Polylines, in a 0..100 box with y up. */
    lines: { points: [number, number][]; tone: Tone; width?: number; dashed?: boolean }[];
    /** Horizontal rules (thresholds, ceilings). */
    hlines: { y: number; tone: Tone; dashed?: boolean }[];
    /** Areas under a curve (reverb tails), filled with the line's tone. */
    fills: { points: [number, number][]; tone: Tone }[];
}

const shape = (): Shape => ({ lines: [], hlines: [], fills: [] });
const clamp = (v: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));

/** Read a parameter, falling back to the default the caller supplied. */
export type ParamReader = (id: string, fallback: number) => number;

/** Uniform x-samples across the box, for response-style curves. */
const xs = (n = 33) => Array.from({ length: n }, (_, i) => (i / (n - 1)) * 100);

function line(shape: Shape, points: [number, number][], tone: Tone, width = 2, dashed = false) {
    shape.lines.push({ points, tone, width, dashed });
}

/** One parametric bell, the way the engine's EQ builds it: `gain` around `freq`, `q` wide. */
function bell(f: number, freq: number, q: number, gain: number) {
    if (freq <= 0 || q <= 0) return 0;
    const oct = Math.log2(Math.max(20, f) / freq);
    return gain * Math.exp(-0.5 * (oct / (1 / q)) ** 2);
}

/**
 * One 2nd-order section's magnitude in dB at `f`, the way `biquad.rs` builds it (RBJ cookbook), so the
 * drawn edge is the filter's own edge rather than a shape that merely resembles it.
 */
export function biquadDb(f: number, fc: number, high: boolean, q: number): number {
    if (fc <= 0) return 0;
    const r = f / fc;
    const denom = (1 - r * r) ** 2 + (r / Math.max(q, 0.05)) ** 2;
    const mag = (high ? r * r : 1) / Math.sqrt(Math.max(denom, 1e-12));
    return 20 * Math.log10(Math.max(mag, 1e-6));
}

/** Butterworth Q of a 4th-order cascade (two cascaded sections), as the engine's 24 dB setting uses. */
const BUTTER_Q = [0.5412, 1.3066];

/** The band each `character` mode keeps: (high-pass Hz, low-pass Hz), matching `character.rs`. */
const CHARACTER_BANDS: [number, number][] = [
    [20, 20000],
    [300, 3400],
    [500, 4000],
    [300, 5000],
    [300, 6000],
    [200, 4000],
];

export function shapeFor(fx: string, p: ParamReader): Shape {
    const s = shape();
    const hz = (i: number) => 20 * 2 ** ((i / 32) * Math.log2(20000 / 20)); // log axis, 20 Hz .. 20 kHz
    switch (fx) {
        case "gate": {
            const thr = clamp(p("threshold", -45), -80, 0);
            const y = clamp(((thr + 80) / 80) * 70 + 15);
            s.hlines.push({ y, tone: "warning", dashed: true });
            line(s, [[0, 6], [y, 6], [y, 95], [100, 95]], "primary");
            break;
        }
        case "eq": {
            const pts: [number, number][] = xs().map((x, i) => {
                const f = hz(i);
                const g =
                    bell(f, p("low_freq", 120), 0.7, p("low_gain", 0)) +
                    bell(f, p("mid1_freq", 500), p("mid1_q", 1), p("mid1_gain", 0)) +
                    bell(f, p("mid2_freq", 2500), p("mid2_q", 1), p("mid2_gain", 0)) +
                    bell(f, p("high_freq", 8000), 0.7, p("high_gain", 0)) -
                    (p("hpf_on", 0) >= 0.5 ? Math.max(0, 24 * (1 - (f / p("hpf_freq", 80)) ** 2)) : 0);
                return [x, clamp(50 + g * 2, 4, 96)] as [number, number];
            });
            s.hlines.push({ y: 50, tone: "muted" });
            line(s, pts, "primary");
            break;
        }
        case "deesser": {
            const f0 = p("frequency", 5500);
            const pts: [number, number][] = xs().map((x, i) => {
                const f = hz(i);
                const dip = -p("range", 6) * Math.exp(-0.5 * (Math.log2(f / f0) / 0.55) ** 2);
                return [x, clamp(80 + dip * 4, 4, 96)] as [number, number];
            });
            s.hlines.push({ y: 80, tone: "muted", dashed: true });
            line(s, pts, "warning");
            break;
        }
        case "compressor": {
            const thr = clamp(p("threshold", -18), -60, 0);
            const ratio = Math.max(1, p("ratio", 4));
            const knee = ((thr + 60) / 60) * 100;
            line(s, [[0, 0], [knee, knee], [100, clamp(knee + (100 - knee) / ratio)]], "primary");
            line(s, [[0, 0], [100, 100]], "muted", 1, true);
            s.hlines.push({ y: knee, tone: "warning", dashed: true });
            break;
        }
        case "filter": {
            const fourth = p("slope", 0) >= 0.5;
            const qs = fourth ? BUTTER_Q : [Math.max(0.5, p("q", 0.707))];
            const hpf = p("hpf_on", 1) >= 0.5;
            const lpf = p("lpf_on", 0) >= 0.5;
            const pts: [number, number][] = xs().map((x, i) => {
                const f = hz(i);
                let db = 0;
                for (const q of qs) {
                    if (hpf) db += biquadDb(f, p("hpf_freq", 80), true, q);
                    if (lpf) db += biquadDb(f, p("lpf_freq", 12000), false, q);
                }
                return [x, clamp(58 + db * 1.5, 3, 97)] as [number, number];
            });
            s.hlines.push({ y: 58, tone: "muted", dashed: true });
            line(s, pts, "primary");
            break;
        }
        case "denoise": {
            // Input level across the box, output level up it: the 2:1 expansion below the knee, with
            // the identity line for reference. The floor is the bottom of the drawn range.
            const depth = clamp(p("depth", 18) * clamp(p("amount", 0.6), 0, 1), 0, 60);
            const thr = -60 + clamp(p("threshold", 9), 3, 30);
            const level = (db: number) => clamp(((db + 60) / 60) * 100, 0, 100);
            const pts: [number, number][] = xs().map((x, i) => {
                const inDb = -60 + (i / 32) * 60;
                const over = inDb - thr;
                const outDb = over >= 0 ? inDb : inDb + Math.max(over * 2, -depth);
                return [x, level(outDb)] as [number, number];
            });
            line(s, [[0, 0], [100, 100]], "muted", 1, true);
            s.hlines.push({ y: level(thr), tone: "warning", dashed: true });
            line(s, pts, "primary");
            break;
        }
        case "character": {
            const mode = Math.round(clamp(p("mode", 1), 0, CHARACTER_BANDS.length - 1));
            const [lo, hi] = CHARACTER_BANDS[mode] ?? CHARACTER_BANDS[0]!;
            // The megaphone is the resonant one.
            const q = mode === 2 ? 1.4 : 0.707;
            const pts: [number, number][] = xs().map((x, i) => {
                const f = hz(i);
                let db = 0;
                if (lo > 20) db += biquadDb(f, lo, true, q);
                if (hi < 20000) db += biquadDb(f, hi, false, q);
                return [x, clamp(58 + db * 1.5, 3, 97)] as [number, number];
            });
            s.hlines.push({ y: 58, tone: "muted", dashed: true });
            line(s, pts, "primary");
            // The drive, as a rule: harder drive sits higher.
            s.hlines.push({ y: clamp(12 + clamp(p("drive", 0.35), 0, 1) * 74), tone: "warning", dashed: true });
            break;
        }
        case "autotune": {
            const amount = clamp(p("amount", 1), 0, 1);
            const glide = clamp(p("retune", 40) / 200, 0, 1);
            const pts: [number, number][] = [];
            const steps = 6;
            for (let i = 0; i <= steps; i++) {
                const x = (i / steps) * 100;
                const flat = 4 + (i / steps) * 88;
                const snapped = 4 + (i / steps) * 88;
                pts.push([x, flat * (1 - amount) + snapped * amount]);
                if (i < steps && glide < 0.5) pts.push([((i + 1) / steps) * 100, flat * (1 - amount) + snapped * amount]);
            }
            line(s, pts, "primary");
            break;
        }
        case "harmonizer": {
            const voices = [5, 9, 13, 17] as const;
            for (const [k, semi] of voices.entries()) {
                const lvl = clamp(p(`voice_${k + 1}_level`, [0.35, 0.25, 0.2, 0.15][k] ?? 0.2), 0, 1);
                const y = clamp(20 + semi * 4);
                line(s, [[10 + k * 20, 8], [10 + k * 20, 8 + lvl * (y - 8)]], "primary", 6);
                s.hlines.push({ y, tone: "muted", dashed: true });
            }
            line(s, [[0, 12], [100, 12]], "warning");
            break;
        }
        case "saturator": {
            const drive = clamp(p("drive", 0.3), 0, 1);
            line(s, [[0, 0], [100, 100]], "muted", 1, true);
            line(
                s,
                xs().map((x) => {
                    const t = x / 50 - 1;
                    return [x, clamp((Math.tanh(t * (1 + drive * 6)) / Math.tanh(1 + drive * 6)) * 50 + 50)] as [number, number];
                }),
                "warning",
            );
            break;
        }
        case "doubler": {
            const detune = clamp(p("detune", 0.2), 0, 1);
            const spread = clamp(p("spread", 0.5), 0, 1);
            for (const [k, off] of [0, 1, 2].entries()) {
                line(
                    s,
                    xs(25).map(
                        (x) =>
                            [x, clamp(50 + 26 * Math.sin((x / 100) * Math.PI * (2 + k * detune * 3) + off * spread * 2))] as [
                                number,
                                number,
                            ],
                    ),
                    k === 0 ? "primary" : "muted",
                );
            }
            break;
        }
        case "chorus": {
            const depth = clamp(p("depth", 0.5), 0, 1);
            const rate = clamp(p("rate", 0.3), 0, 1);
            line(
                s,
                xs(41).map(
                    (x) => [x, clamp(50 + (10 + depth * 35) * Math.sin((x / 100) * Math.PI * (2 + rate * 6)))] as [number, number],
                ),
                "primary",
            );
            break;
        }
        case "delay": {
            const fb = clamp(p("feedback", 0.35), 0, 1);
            const ping = p("ping_pong", 0) >= 0.5;
            let amp = 1;
            for (let k = 0; k < 6; k++) {
                const x = 8 + k * 15;
                line(s, [[x, 8], [x, 8 + amp * 80]], ping && k % 2 ? "warning" : "primary", 6);
                amp *= fb;
            }
            line(s, [[0, 8], [100, 8]], "muted");
            break;
        }
        case "reverb": {
            const decay = clamp(p("decay", 0.4), 0, 1);
            const damp = clamp(p("damping", 0.4), 0, 1);
            const pts: [number, number][] = xs(41).map(
                (x) => [x, clamp(2 + 92 * Math.exp((-x / 100) * (1 + (1 - decay) * 6)) * (1 - damp * 0.35))] as [number, number],
            );
            line(s, pts, "primary");
            s.fills.push({ points: [[0, 0], ...pts, [100, 0]], tone: "primary" });
            break;
        }
        case "limiter": {
            const ceil = clamp(p("ceiling", -1), -12, 0);
            const y = clamp(96 - (ceil + 12) * 2);
            s.hlines.push({ y, tone: "destructive", dashed: true });
            line(s, [[0, 0], [100, y]], "primary");
            line(s, [[0, 0], [100, 100]], "muted", 1, true);
            break;
        }
        default:
            // An unknown (newer) effect: a neutral pass-through, never an empty box.
            line(s, [[0, 20], [100, 80]], "muted", 1, true);
            s.hlines.push({ y: 50, tone: "muted" });
    }
    return s;
}

export const TONE_VAR: Record<Tone, string> = {
    primary: "--primary",
    muted: "--muted-foreground",
    warning: "--warning",
    destructive: "--destructive",
};

/** Filled area under a curve, as an SVG path in the 0..100 box (y flipped for screen space). */
export function areaPath(points: [number, number][]): string {
    const first = points[0];
    if (!first) return "";
    const rest = points.slice(1);
    return `M ${first[0]} ${100 - first[1]} ` + rest.map(([x, y]) => `L ${x} ${100 - y}`).join(" ") + " Z";
}
