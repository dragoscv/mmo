// Sample-accurate sidechain ducker.
// Inputs:  0 = side (key) signal, 1 = dry signal to be ducked
// Output:  0 = ducked dry signal
// Posts current gainReductionDb to the main thread every ~5ms for UI meters.
class SidechainDuckerProcessor extends AudioWorkletProcessor {
    static get parameterDescriptors() {
        return [
            { name: "threshold", defaultValue: -40, minValue: -100, maxValue: 0, automationRate: "k-rate" },
            { name: "range", defaultValue: 36, minValue: 0, maxValue: 60, automationRate: "k-rate" },
            { name: "ratio", defaultValue: 8, minValue: 1, maxValue: 20, automationRate: "k-rate" },
            { name: "attack", defaultValue: 0.005, minValue: 0.0001, maxValue: 1, automationRate: "k-rate" },
            { name: "release", defaultValue: 0.15, minValue: 0.001, maxValue: 2, automationRate: "k-rate" },
        ];
    }

    constructor() {
        super();
        this._env = 0;
        this._postCounter = 0;
        this._postEvery = 8;
        this._lastReduction = 0;
    }

    process(inputs, outputs, params) {
        const side = inputs[0];
        const dry = inputs[1];
        const out = outputs[0];
        if (!out || out.length === 0) return true;

        const threshold = params.threshold.length === 1 ? params.threshold[0] : params.threshold[params.threshold.length - 1];
        const range = params.range.length === 1 ? params.range[0] : params.range[params.range.length - 1];
        const ratio = params.ratio.length === 1 ? params.ratio[0] : params.ratio[params.ratio.length - 1];
        const attack = params.attack.length === 1 ? params.attack[0] : params.attack[params.attack.length - 1];
        const release = params.release.length === 1 ? params.release[0] : params.release[params.release.length - 1];

        const aCoef = Math.exp(-1 / (sampleRate * attack));
        const rCoef = Math.exp(-1 / (sampleRate * release));

        const N = out[0].length;
        const sideCh0 = (side && side[0]) || null;
        const sideCh1 = side && side.length > 1 ? side[1] : sideCh0;

        let env = this._env;
        let lastRed = this._lastReduction;
        for (let i = 0; i < N; i++) {
            // Detect on side
            const a = sideCh0 ? Math.abs(sideCh0[i]) : 0;
            const b = sideCh1 ? Math.abs(sideCh1[i]) : a;
            const s = (a + b) * 0.5;
            const coef = s > env ? aCoef : rCoef;
            env = s + coef * (env - s);

            const db = env > 1e-7 ? 20 * Math.log10(env) : -120;
            const over = Math.max(0, db - threshold);
            // Compressed reduction
            const reduction = Math.min(range, over * (1 - 1 / Math.max(1, ratio)));
            lastRed = reduction;
            const gain = Math.pow(10, -reduction / 20);

            // Apply to dry, write to out
            for (let c = 0; c < out.length; c++) {
                const dryCh = dry && dry[c < dry.length ? c : 0];
                const x = dryCh ? dryCh[i] : 0;
                out[c][i] = x * gain;
            }
        }
        this._env = env;
        this._lastReduction = lastRed;

        this._postCounter++;
        if (this._postCounter >= this._postEvery) {
            this._postCounter = 0;
            this.port.postMessage({ gainReductionDb: lastRed });
        }

        return true;
    }
}

registerProcessor("sidechain-ducker", SidechainDuckerProcessor);
