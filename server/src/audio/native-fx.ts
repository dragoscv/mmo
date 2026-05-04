/**
 * native-fx.ts
 *
 * Mono floating-point DSP primitives that run in the same audio callback
 * as PitchDsp, sandwiched after the autotune stage. Each effect is a
 * tiny class with the same interface:
 *
 *   setParams(params: Record<string, number>): void
 *   process(buf: Float32Array, n: number): void   // in-place
 *   reset(): void
 *
 * Design choices:
 *   - All effects run at the engine's negotiated sample rate (set in the
 *     constructor). Sample-rate changes require reconstruction, just like
 *     PitchDsp.
 *   - All processing is mono. The native engine deinterleaves to mono
 *     before PitchDsp + the FX chain, then reinterleaves to the device's
 *     channel count for output. Stereo effects (chorus, ping-pong,
 *     stereo width) are intentionally out of scope for the native chain
 *     — they need to live in the browser path where the user gets the
 *     full stereo FX engine.
 *   - All allocations happen at construction or `setParams` time. The
 *     `process` hot path makes ZERO allocations and uses no closures.
 *     The audio callback runs at frame_size / sample_rate seconds (e.g.
 *     ~2.7ms at 128/48k); a single GC pause would underrun.
 *   - Parameter changes are atomic-by-assignment (single number writes
 *     are tear-free in JS). We do not interpolate parameter changes
 *     between samples — the audio thread sees the new value at the
 *     start of the next callback. For knob automation that's smooth
 *     enough; if the UI ever needs sample-accurate ramps we'll add a
 *     ramp helper here.
 */

export interface NativeFx {
    readonly type: NativeFxType;
    setParams(params: Record<string, number>): void;
    process(buf: Float32Array, n: number): void;
    reset(): void;
}

export type NativeFxType =
    | "gate"
    | "noiseSuppression"
    | "compressor"
    | "limiter"
    | "eq3"
    | "delay"
    | "reverb";

/** True when the native engine has a working implementation for this
 *  type. Browser-only types fall through to the chain unchanged (the
 *  native chain just skips them — the browser keeps owning that effect
 *  when it is the active path; in native mode they are silently skipped
 *  with a console.debug). */
export function isSupportedNativeFx(type: string): type is NativeFxType {
    switch (type) {
        case "gate":
        case "noiseSuppression":
        case "compressor":
        case "limiter":
        case "eq3":
        case "delay":
        case "reverb":
            return true;
        default:
            return false;
    }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const dbToLin = (db: number): number => Math.pow(10, db / 20);
const linToDb = (lin: number): number => (lin > 0 ? 20 * Math.log10(lin) : -120);

/** One-pole envelope follower coefficient for a given time constant.
 *  Returns the per-sample alpha for `env = env + alpha * (target - env)`
 *  such that the envelope reaches 1 - 1/e of `target` after `tau`
 *  seconds. */
function timeConstantToAlpha(tauSeconds: number, sampleRate: number): number {
    if (tauSeconds <= 0) return 1;
    return 1 - Math.exp(-1 / (tauSeconds * sampleRate));
}

// ─── Gate / NoiseSuppression ─────────────────────────────────────────────────
//
// Single threshold expander. Below threshold, attenuate by `reduction` dB;
// above threshold, signal passes through. Smoothed with attack/release
// envelope on the GAIN, not the input level — gives a click-free open
// and a musical close.
//
// "noiseSuppression" is the same algorithm with a slightly lower default
// reduction (-20dB instead of full close) and faster release, which sounds
// less like a noise gate and more like the user-facing browser
// noise-suppression effect.

class GateFx implements NativeFx {
    readonly type: NativeFxType;
    private sampleRate: number;
    // Detector + smoothed gain
    private envLevel = 0;        // tracks |x| with fast-attack / slow-release
    private gain = 1;            // applied gain, smoothed
    // Cached params
    private threshLin = dbToLin(-40);
    private reductionLin = 0.0;  // closed-state gain (linear)
    private attackAlpha = 0;     // gain rise smoothing
    private releaseAlpha = 0;    // gain fall smoothing
    private detAttackAlpha = 0;  // detector rise (fast)
    private detReleaseAlpha = 0; // detector fall (slow)

    constructor(type: NativeFxType, sampleRate: number, params: Record<string, number>) {
        this.type = type;
        this.sampleRate = sampleRate;
        // Detector tracks the signal envelope very fast on the way up and
        // slowly on the way down. Numbers tuned to sound like a typical
        // hardware gate.
        this.detAttackAlpha = timeConstantToAlpha(0.001, sampleRate);
        this.detReleaseAlpha = timeConstantToAlpha(0.020, sampleRate);
        this.setParams(params);
    }

    setParams(p: Record<string, number>): void {
        const threshDb = p.threshold ?? -40;
        // For "noiseSuppression" the user-facing slider is a positive dB
        // value of REDUCTION amount. For "gate" we use a flat full-close.
        const reductionDb = this.type === "noiseSuppression"
            ? -(p.reduction ?? 20)   // 20 dB attenuation when closed
            : -60;                    // gate: -60 dB ≈ silent
        const attack = p.attack ?? 0.005;
        const release = p.release ?? 0.05;
        this.threshLin = dbToLin(threshDb);
        this.reductionLin = dbToLin(reductionDb);
        this.attackAlpha = timeConstantToAlpha(attack, this.sampleRate);
        this.releaseAlpha = timeConstantToAlpha(release, this.sampleRate);
    }

    process(buf: Float32Array, n: number): void {
        let env = this.envLevel;
        let g = this.gain;
        const thresh = this.threshLin;
        const red = this.reductionLin;
        const aA = this.attackAlpha;
        const rA = this.releaseAlpha;
        const daA = this.detAttackAlpha;
        const drA = this.detReleaseAlpha;
        for (let i = 0; i < n; i++) {
            const x = buf[i];
            const ax = x < 0 ? -x : x;
            // Detector
            const detAlpha = ax > env ? daA : drA;
            env += detAlpha * (ax - env);
            // Target gain
            const target = env >= thresh ? 1 : red;
            const gAlpha = target > g ? aA : rA;
            g += gAlpha * (target - g);
            buf[i] = x * g;
        }
        this.envLevel = env;
        this.gain = g;
    }

    reset(): void {
        this.envLevel = 0;
        this.gain = 1;
    }
}

// ─── Compressor / Limiter ────────────────────────────────────────────────────
//
// Feed-forward soft-knee compressor. Operates entirely in the dB domain
// for the gain-reduction calculation, with a one-pole envelope follower on
// the gain reduction (NOT the input level — gives the classic broadcast
// compressor sound).
//
// "limiter" is the same implementation with ratio fixed very high and
// faster attack — the engine clamps params to those defaults.

class CompressorFx implements NativeFx {
    readonly type: NativeFxType;
    private sampleRate: number;
    private envDb = 0;             // smoothed gain reduction in dB
    // Cached params
    private threshDb = -24;
    private ratio = 4;
    private kneeDb = 6;
    private attackAlpha = 0;
    private releaseAlpha = 0;
    private makeupLin = 1;

    constructor(type: NativeFxType, sampleRate: number, params: Record<string, number>) {
        this.type = type;
        this.sampleRate = sampleRate;
        this.setParams(params);
    }

    setParams(p: Record<string, number>): void {
        if (this.type === "limiter") {
            this.threshDb = p.threshold ?? -1;
            this.ratio = 20;       // brick-wall behaviour
            this.kneeDb = 0.5;
            this.attackAlpha = timeConstantToAlpha(0.001, this.sampleRate);
            this.releaseAlpha = timeConstantToAlpha(p.release ?? 0.1, this.sampleRate);
            this.makeupLin = 1;
        } else {
            this.threshDb = p.threshold ?? -24;
            this.ratio = Math.max(1, p.ratio ?? 4);
            this.kneeDb = Math.max(0, p.knee ?? 6);
            this.attackAlpha = timeConstantToAlpha(Math.max(0.0001, p.attack ?? 0.003), this.sampleRate);
            this.releaseAlpha = timeConstantToAlpha(Math.max(0.005, p.release ?? 0.25), this.sampleRate);
            this.makeupLin = dbToLin(p.makeupGain ?? 0);
        }
    }

    process(buf: Float32Array, n: number): void {
        let envDb = this.envDb;
        const tDb = this.threshDb;
        const r = this.ratio;
        const kDb = this.kneeDb;
        const aA = this.attackAlpha;
        const rA = this.releaseAlpha;
        const mu = this.makeupLin;
        const halfKnee = kDb * 0.5;
        for (let i = 0; i < n; i++) {
            const x = buf[i];
            const ax = x < 0 ? -x : x;
            const inDb = ax > 1e-7 ? linToDb(ax) : -120;
            // Soft-knee gain reduction in dB. Standard formula:
            //   if (inDb - tDb) <= -halfKnee   →   no reduction
            //   if (inDb - tDb) >=  halfKnee   →   full ratio
            //   inside knee                    →   quadratic interp
            let reductionDb = 0;
            const above = inDb - tDb;
            if (above >= halfKnee) {
                reductionDb = above * (1 - 1 / r);
            } else if (above > -halfKnee) {
                const k = above + halfKnee;          // 0..kDb
                reductionDb = (k * k) / (2 * kDb) * (1 - 1 / r);
            }
            // Smooth the gain reduction. More reduction → attack; less → release.
            const alpha = reductionDb > envDb ? aA : rA;
            envDb += alpha * (reductionDb - envDb);
            const g = dbToLin(-envDb) * mu;
            buf[i] = x * g;
        }
        this.envDb = envDb;
    }

    reset(): void {
        this.envDb = 0;
    }
}

// ─── EQ3 (low shelf, mid peak, high shelf) ───────────────────────────────────
//
// Three cascaded biquads tuned to broadcast EQ defaults: 250 Hz low shelf,
// 1.5 kHz peaking with Q=0.7, 6 kHz high shelf. RBJ Audio EQ Cookbook
// formulas. Coefficients recomputed only when params change, not per
// sample.

interface BiquadState {
    b0: number; b1: number; b2: number;
    a1: number; a2: number;
    z1: number; z2: number;
}

function newBiquadState(): BiquadState {
    return { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0, z1: 0, z2: 0 };
}

function setBiquadLowShelf(s: BiquadState, freq: number, gainDb: number, sampleRate: number): void {
    const A = Math.pow(10, gainDb / 40);
    const w0 = 2 * Math.PI * freq / sampleRate;
    const cs = Math.cos(w0);
    const sn = Math.sin(w0);
    const S = 1; // shelf slope
    const alpha = sn / 2 * Math.sqrt((A + 1 / A) * (1 / S - 1) + 2);
    const twoSqrtA_alpha = 2 * Math.sqrt(A) * alpha;
    const b0 = A * ((A + 1) - (A - 1) * cs + twoSqrtA_alpha);
    const b1 = 2 * A * ((A - 1) - (A + 1) * cs);
    const b2 = A * ((A + 1) - (A - 1) * cs - twoSqrtA_alpha);
    const a0 = (A + 1) + (A - 1) * cs + twoSqrtA_alpha;
    const a1 = -2 * ((A - 1) + (A + 1) * cs);
    const a2 = (A + 1) + (A - 1) * cs - twoSqrtA_alpha;
    s.b0 = b0 / a0; s.b1 = b1 / a0; s.b2 = b2 / a0;
    s.a1 = a1 / a0; s.a2 = a2 / a0;
}

function setBiquadHighShelf(s: BiquadState, freq: number, gainDb: number, sampleRate: number): void {
    const A = Math.pow(10, gainDb / 40);
    const w0 = 2 * Math.PI * freq / sampleRate;
    const cs = Math.cos(w0);
    const sn = Math.sin(w0);
    const S = 1;
    const alpha = sn / 2 * Math.sqrt((A + 1 / A) * (1 / S - 1) + 2);
    const twoSqrtA_alpha = 2 * Math.sqrt(A) * alpha;
    const b0 = A * ((A + 1) + (A - 1) * cs + twoSqrtA_alpha);
    const b1 = -2 * A * ((A - 1) + (A + 1) * cs);
    const b2 = A * ((A + 1) + (A - 1) * cs - twoSqrtA_alpha);
    const a0 = (A + 1) - (A - 1) * cs + twoSqrtA_alpha;
    const a1 = 2 * ((A - 1) - (A + 1) * cs);
    const a2 = (A + 1) - (A - 1) * cs - twoSqrtA_alpha;
    s.b0 = b0 / a0; s.b1 = b1 / a0; s.b2 = b2 / a0;
    s.a1 = a1 / a0; s.a2 = a2 / a0;
}

function setBiquadPeak(s: BiquadState, freq: number, gainDb: number, q: number, sampleRate: number): void {
    const A = Math.pow(10, gainDb / 40);
    const w0 = 2 * Math.PI * freq / sampleRate;
    const cs = Math.cos(w0);
    const sn = Math.sin(w0);
    const alpha = sn / (2 * q);
    const b0 = 1 + alpha * A;
    const b1 = -2 * cs;
    const b2 = 1 - alpha * A;
    const a0 = 1 + alpha / A;
    const a1 = -2 * cs;
    const a2 = 1 - alpha / A;
    s.b0 = b0 / a0; s.b1 = b1 / a0; s.b2 = b2 / a0;
    s.a1 = a1 / a0; s.a2 = a2 / a0;
}

function processBiquad(s: BiquadState, buf: Float32Array, n: number): void {
    // Transposed Direct Form II — minimal numerical noise at 32-bit float.
    let z1 = s.z1, z2 = s.z2;
    const b0 = s.b0, b1 = s.b1, b2 = s.b2, a1 = s.a1, a2 = s.a2;
    for (let i = 0; i < n; i++) {
        const x = buf[i];
        const y = b0 * x + z1;
        z1 = b1 * x - a1 * y + z2;
        z2 = b2 * x - a2 * y;
        buf[i] = y;
    }
    s.z1 = z1; s.z2 = z2;
}

class Eq3Fx implements NativeFx {
    readonly type = "eq3" as const;
    private sampleRate: number;
    private low = newBiquadState();
    private mid = newBiquadState();
    private high = newBiquadState();

    constructor(sampleRate: number, params: Record<string, number>) {
        this.sampleRate = sampleRate;
        this.setParams(params);
    }

    setParams(p: Record<string, number>): void {
        const lowDb = p.low ?? 0;
        const midDb = p.mid ?? 0;
        const highDb = p.high ?? 0;
        setBiquadLowShelf(this.low, 250, lowDb, this.sampleRate);
        setBiquadPeak(this.mid, 1500, midDb, 0.7, this.sampleRate);
        setBiquadHighShelf(this.high, 6000, highDb, this.sampleRate);
    }

    process(buf: Float32Array, n: number): void {
        processBiquad(this.low, buf, n);
        processBiquad(this.mid, buf, n);
        processBiquad(this.high, buf, n);
    }

    reset(): void {
        this.low.z1 = this.low.z2 = 0;
        this.mid.z1 = this.mid.z2 = 0;
        this.high.z1 = this.high.z2 = 0;
    }
}

// ─── Delay ───────────────────────────────────────────────────────────────────
//
// Single delay line with feedback through a one-pole lowpass (the
// "damping" knob). Mono. Stereo / ping-pong delays are browser-only.

class DelayFx implements NativeFx {
    readonly type = "delay" as const;
    private sampleRate: number;
    private buffer: Float32Array;
    private idx = 0;
    private dampLastY = 0;
    // Cached params
    private delaySamples = 0;
    private feedback = 0.4;
    private mix = 0.3;
    private dampCoef = 0.5;

    constructor(sampleRate: number, params: Record<string, number>) {
        this.sampleRate = sampleRate;
        // Worst-case 2 seconds of delay buffer, regardless of the runtime
        // `time` knob. Keeps reallocation off the audio path.
        this.buffer = new Float32Array(Math.ceil(sampleRate * 2));
        this.setParams(params);
    }

    setParams(p: Record<string, number>): void {
        const time = Math.max(0.001, Math.min(2, p.time ?? 0.375));
        this.delaySamples = Math.max(1, Math.floor(time * this.sampleRate));
        this.feedback = Math.max(0, Math.min(0.95, p.feedback ?? 0.4));
        this.mix = Math.max(0, Math.min(1, p.mix ?? 0.3));
        // damping ∈ [0..1] → lowpass smoothing coefficient
        this.dampCoef = 1 - Math.max(0, Math.min(0.95, p.damping ?? 0.3));
    }

    process(buf: Float32Array, n: number): void {
        const dl = this.buffer;
        const N = dl.length;
        const ds = this.delaySamples;
        const fb = this.feedback;
        const mix = this.mix;
        const damp = this.dampCoef;
        let idx = this.idx;
        let lp = this.dampLastY;
        for (let i = 0; i < n; i++) {
            const x = buf[i];
            const readIdx = (idx - ds + N) % N;
            const delayed = dl[readIdx];
            // Damped feedback line: lowpass the delayed signal before
            // re-injecting it into the buffer.
            lp = lp + damp * (delayed - lp);
            dl[idx] = x + lp * fb;
            buf[i] = x * (1 - mix) + delayed * mix;
            idx = idx + 1 >= N ? 0 : idx + 1;
        }
        this.idx = idx;
        this.dampLastY = lp;
    }

    reset(): void {
        this.buffer.fill(0);
        this.idx = 0;
        this.dampLastY = 0;
    }
}

// ─── Reverb (Schroeder) ──────────────────────────────────────────────────────
//
// Classic Schroeder reverb: 4 parallel comb filters whose outputs are
// summed and fed through 2 series allpass filters. Comb feedback is
// damped (one-pole lowpass) so high frequencies decay faster than lows
// — sounds more natural than pure exponential decay. Pre-delay buffer
// before the reverb.
//
// Comb delay lengths from Freeverb's prime numbers (scaled to sample
// rate). They're mutually prime so the comb resonances don't pile up
// into ringing at any single frequency.

const FV_COMB_LENS = [1116, 1188, 1277, 1356];   // @ 44.1kHz reference
const FV_ALLPASS_LENS = [556, 441];

interface CombState {
    buf: Float32Array;
    idx: number;
    feedback: number;
    damp: number;
    lp: number;
}

interface AllPassState {
    buf: Float32Array;
    idx: number;
    feedback: number;
}

function makeComb(sampleRate: number, refLen: number): CombState {
    const len = Math.max(1, Math.round(refLen * sampleRate / 44100));
    return { buf: new Float32Array(len), idx: 0, feedback: 0.5, damp: 0.5, lp: 0 };
}

function makeAllPass(sampleRate: number, refLen: number): AllPassState {
    const len = Math.max(1, Math.round(refLen * sampleRate / 44100));
    return { buf: new Float32Array(len), idx: 0, feedback: 0.5 };
}

class ReverbFx implements NativeFx {
    readonly type = "reverb" as const;
    private sampleRate: number;
    private combs: CombState[];
    private allpasses: AllPassState[];
    private preDelay: Float32Array;
    private preIdx = 0;
    private preDelaySamples = 0;
    private mix = 0.3;
    private wetGain = 0.3;
    private dryGain = 0.7;

    constructor(sampleRate: number, params: Record<string, number>) {
        this.sampleRate = sampleRate;
        this.combs = FV_COMB_LENS.map(l => makeComb(sampleRate, l));
        this.allpasses = FV_ALLPASS_LENS.map(l => {
            const ap = makeAllPass(sampleRate, l);
            ap.feedback = 0.5;
            return ap;
        });
        this.preDelay = new Float32Array(Math.ceil(sampleRate * 0.1)); // up to 100ms preDelay
        this.setParams(params);
    }

    setParams(p: Record<string, number>): void {
        this.mix = Math.max(0, Math.min(1, p.mix ?? 0.3));
        this.wetGain = this.mix;
        this.dryGain = 1 - this.mix;
        // Feedback gain from RT60. RT60 ≈ -3 * delaySec / log10(g)
        // → g = 10^(-3*delaySec/RT60). Use mean comb delay as proxy.
        const decay = Math.max(0.1, Math.min(10, p.decay ?? 2.5));
        const meanComb = (1116 + 1188 + 1277 + 1356) / 4 / 44100;
        const fb = Math.pow(10, -3 * meanComb / decay);
        const fbClamped = Math.min(0.97, fb);
        for (const c of this.combs) c.feedback = fbClamped;
        // Damping ∈ [0..1] → 0=no damping, 1=heavy lowpass on feedback.
        const damping = Math.max(0, Math.min(0.95, p.damping ?? 0.5));
        for (const c of this.combs) c.damp = damping;
        // PreDelay: 0..100ms.
        const pre = Math.max(0, Math.min(0.1, p.preDelay ?? 0.02));
        this.preDelaySamples = Math.floor(pre * this.sampleRate);
    }

    process(buf: Float32Array, n: number): void {
        const combs = this.combs;
        const aps = this.allpasses;
        const preBuf = this.preDelay;
        const preLen = preBuf.length;
        const preDel = this.preDelaySamples;
        let preIdx = this.preIdx;
        const wet = this.wetGain;
        const dry = this.dryGain;
        for (let i = 0; i < n; i++) {
            const x = buf[i];
            // PreDelay
            preBuf[preIdx] = x;
            const preRead = (preIdx - preDel + preLen) % preLen;
            const preOut = preBuf[preRead];
            preIdx = preIdx + 1 >= preLen ? 0 : preIdx + 1;
            // Combs in parallel, sum their outputs
            let sum = 0;
            for (let c = 0; c < combs.length; c++) {
                const co = combs[c];
                const cb = co.buf;
                const cl = cb.length;
                const out = cb[co.idx];
                // Damped feedback path
                co.lp = co.lp + (1 - co.damp) * (out - co.lp);
                cb[co.idx] = preOut + co.lp * co.feedback;
                co.idx = co.idx + 1 >= cl ? 0 : co.idx + 1;
                sum += out;
            }
            sum *= 0.25; // 1/N combs
            // Allpasses in series — they smear the sum so it doesn't
            // sound like 4 distinct echoes.
            let y = sum;
            for (let a = 0; a < aps.length; a++) {
                const ap = aps[a];
                const ab = ap.buf;
                const al = ab.length;
                const bufout = ab[ap.idx];
                const apout = -y + bufout;
                ab[ap.idx] = y + bufout * ap.feedback;
                ap.idx = ap.idx + 1 >= al ? 0 : ap.idx + 1;
                y = apout;
            }
            buf[i] = x * dry + y * wet;
        }
        this.preIdx = preIdx;
    }

    reset(): void {
        for (const c of this.combs) { c.buf.fill(0); c.idx = 0; c.lp = 0; }
        for (const a of this.allpasses) { a.buf.fill(0); a.idx = 0; }
        this.preDelay.fill(0);
        this.preIdx = 0;
    }
}

// ─── Factory + chain ────────────────────────────────────────────────────────

export function createNativeFx(
    type: NativeFxType,
    sampleRate: number,
    params: Record<string, number>,
): NativeFx {
    switch (type) {
        case "gate":
        case "noiseSuppression":
            return new GateFx(type, sampleRate, params);
        case "compressor":
        case "limiter":
            return new CompressorFx(type, sampleRate, params);
        case "eq3":
            return new Eq3Fx(sampleRate, params);
        case "delay":
            return new DelayFx(sampleRate, params);
        case "reverb":
            return new ReverbFx(sampleRate, params);
    }
}

export interface NativeFxChainItem {
    id: string;
    type: NativeFxType;
    enabled: boolean;
    params: Record<string, number>;
}

/**
 * Ordered chain of native FX. Owned by the audio engine; mutated by
 * `setItems(items)` from the HTTP handler. The audio thread only ever
 * reads `this.active` — a frozen array snapshotted at the start of each
 * callback. Swapping the array is a single reference assignment, which
 * is atomic in JS, so we don't need locks.
 */
export class NativeFxChain {
    private sampleRate: number;
    private active: NativeFx[] = [];
    /** Map of insert id → instance for diffing on setItems(). Lets us
     *  preserve effect state (delay buffers, envelope followers, comb
     *  histories) when the user toggles enabled or tweaks a knob —
     *  rebuilding only when an insert is added or its type changes. */
    private byId = new Map<string, { type: NativeFxType; fx: NativeFx }>();

    constructor(sampleRate: number) {
        this.sampleRate = sampleRate;
    }

    /** Replace the chain. Reuses existing FX instances by id when their
     *  type hasn't changed; rebuilds otherwise. Disabled inserts stay in
     *  `byId` (keeping their internal state) but aren't included in
     *  `active`. */
    setItems(items: NativeFxChainItem[]): void {
        const next: NativeFx[] = [];
        const nextIds = new Set<string>();
        for (const item of items) {
            nextIds.add(item.id);
            if (!isSupportedNativeFx(item.type)) continue;
            const existing = this.byId.get(item.id);
            let fx: NativeFx;
            if (existing && existing.type === item.type) {
                existing.fx.setParams(item.params);
                fx = existing.fx;
            } else {
                fx = createNativeFx(item.type, this.sampleRate, item.params);
                this.byId.set(item.id, { type: item.type, fx });
            }
            if (item.enabled) next.push(fx);
        }
        // Drop instances that disappeared from the user's chain — frees
        // their delay buffers / state arrays.
        for (const id of [...this.byId.keys()]) {
            if (!nextIds.has(id)) this.byId.delete(id);
        }
        this.active = next;
    }

    /** Hot path. Process the buffer in-place through the active chain. */
    process(buf: Float32Array, n: number): void {
        const chain = this.active;
        for (let i = 0; i < chain.length; i++) {
            chain[i].process(buf, n);
        }
    }

    /** Reset all instance state (delay buffers, envelope followers, …).
     *  Called by the engine on stop() so a subsequent start doesn't
     *  inherit stale tails. */
    resetAll(): void {
        for (const fx of this.active) fx.reset();
    }

    get count(): number { return this.active.length; }
}
