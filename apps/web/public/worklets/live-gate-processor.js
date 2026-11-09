// Downward gate / expander for the browser vocal FX engine (WP21-14).
// Port of apps/live/engine/crates/live-dsp/src/dynamics.rs `Gate`: stereo-linked peak detector
// (0.2 ms attack / 15 ms release), open/close with hold + hysteresis, gain computed in dB as
// (level - threshold) * (ratio - 1) clamped to [range, 0] and smoothed with attack/release.
// ratio 20 behaves as a hard gate; a lower ratio is a downward expander (noise suppression).
//
// Params (k-rate): threshold dB, range dB (<= 0), ratio, attack s, hold s, release s, hysteresis dB.
// Registered as "live-gate". Kept dependency-free: the vitest suite evaluates this file directly.

const LN10_OVER_20 = Math.LN10 / 20;
const TWENTY_OVER_LN10 = 20 / Math.LN10;

function dbToLin(db) {
    return Math.exp(db * LN10_OVER_20);
}

function linToDb(x) {
    return x > 1e-9 ? TWENTY_OVER_LN10 * Math.log(x) : -180;
}

/** Same as live-dsp `one_pole_coef`, but the time is in seconds. */
function onePoleCoef(seconds, sr) {
    return seconds <= 0 ? 1 : 1 - Math.exp(-1 / (seconds * sr));
}

function last(arr) {
    return arr.length === 1 ? arr[0] : arr[arr.length - 1];
}

class LiveGateProcessor extends AudioWorkletProcessor {
    static get parameterDescriptors() {
        return [
            { name: "threshold", defaultValue: -40, minValue: -100, maxValue: 0, automationRate: "k-rate" },
            { name: "range", defaultValue: -80, minValue: -100, maxValue: 0, automationRate: "k-rate" },
            { name: "ratio", defaultValue: 20, minValue: 1, maxValue: 20, automationRate: "k-rate" },
            { name: "attack", defaultValue: 0.0005, minValue: 0.00005, maxValue: 1, automationRate: "k-rate" },
            { name: "hold", defaultValue: 0.04, minValue: 0, maxValue: 2, automationRate: "k-rate" },
            { name: "release", defaultValue: 0.12, minValue: 0.001, maxValue: 5, automationRate: "k-rate" },
            { name: "hysteresis", defaultValue: 4, minValue: 0, maxValue: 24, automationRate: "k-rate" },
        ];
    }

    constructor() {
        super();
        this._env = 0;
        this._gainDb = 0;
        this._open = false;
        this._holdLeft = 0;
        this._detAtt = onePoleCoef(0.0002, sampleRate);
        this._detRel = onePoleCoef(0.015, sampleRate);
    }

    process(inputs, outputs, params) {
        const input = inputs[0];
        const output = outputs[0];
        if (!output || output.length === 0) return true;
        const n = output[0].length;
        if (!input || input.length === 0) {
            for (const ch of output) ch.fill(0);
            return true;
        }

        const thr = last(params.threshold);
        const range = Math.min(0, last(params.range));
        const ratio = Math.max(1, last(params.ratio));
        const att = onePoleCoef(last(params.attack), sampleRate);
        const rel = onePoleCoef(last(params.release), sampleRate);
        const hold = Math.floor(last(params.hold) * sampleRate);
        const hyst = Math.max(0, last(params.hysteresis));
        const channels = Math.min(input.length, output.length);

        for (let i = 0; i < n; i++) {
            let x = 0;
            for (let c = 0; c < channels; c++) {
                const a = Math.abs(input[c][i]);
                if (a > x) x = a;
            }
            this._env += (x > this._env ? this._detAtt : this._detRel) * (x - this._env);
            const lvl = linToDb(this._env);
            if (lvl > thr) {
                this._open = true;
                this._holdLeft = hold;
            } else if (lvl < thr - hyst) {
                if (this._holdLeft > 0) this._holdLeft -= 1;
                else this._open = false;
            }
            const target = this._open ? 0 : Math.min(0, Math.max(range, (lvl - thr) * (ratio - 1)));
            this._gainDb += (target > this._gainDb ? att : rel) * (target - this._gainDb);
            const g = dbToLin(this._gainDb);
            for (let c = 0; c < channels; c++) output[c][i] = input[c][i] * g;
        }
        for (let c = channels; c < output.length; c++) output[c].fill(0);
        return true;
    }
}

registerProcessor("live-gate", LiveGateProcessor);
