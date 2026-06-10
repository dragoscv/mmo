"use client";

/**
 * Audio EQ Engine — manages Web Audio API nodes for equalization and effects.
 *
 * Chain: source → preGain → [10-band EQ filters] → compressor → [effects] → analyser → destination
 */

// ─── Types ───────────────────────────────────────────────────────────────

export interface EQBand {
    frequency: number;
    gain: number;       // dB, -12 to +12
    Q: number;
    type: BiquadFilterType;
    label: string;
}

export interface EffectState {
    // Compressor
    compressorEnabled: boolean;
    compressorThreshold: number;  // -100 to 0 dB
    compressorKnee: number;       // 0 to 40 dB
    compressorRatio: number;      // 1 to 20
    compressorAttack: number;     // 0 to 1 s
    compressorRelease: number;    // 0 to 1 s
    // Reverb
    reverbEnabled: boolean;
    reverbMix: number;  // 0-1 (dry/wet)
    reverbDecay: number; // 0.1 to 10 seconds
    // Delay
    delayEnabled: boolean;
    delayTime: number;   // 0 to 2 seconds
    delayFeedback: number; // 0 to 0.9
    delayMix: number;    // 0-1
    // Stereo width
    stereoEnabled: boolean;
    stereoWidth: number; // 0 to 2 (1 = normal)
    // Bass boost
    bassBoostEnabled: boolean;
    bassBoostAmount: number; // 0-1
}

export interface EQPreset {
    name: string;
    bands: number[]; // gain values for each band
    icon?: string;
}

export const DEFAULT_BANDS: EQBand[] = [
    { frequency: 31, gain: 0, Q: 1.4, type: "lowshelf", label: "31" },
    { frequency: 62, gain: 0, Q: 1.4, type: "peaking", label: "62" },
    { frequency: 125, gain: 0, Q: 1.4, type: "peaking", label: "125" },
    { frequency: 250, gain: 0, Q: 1.4, type: "peaking", label: "250" },
    { frequency: 500, gain: 0, Q: 1.4, type: "peaking", label: "500" },
    { frequency: 1000, gain: 0, Q: 1.4, type: "peaking", label: "1K" },
    { frequency: 2000, gain: 0, Q: 1.4, type: "peaking", label: "2K" },
    { frequency: 4000, gain: 0, Q: 1.4, type: "peaking", label: "4K" },
    { frequency: 8000, gain: 0, Q: 1.4, type: "peaking", label: "8K" },
    { frequency: 16000, gain: 0, Q: 1.4, type: "highshelf", label: "16K" },
];

export const EQ_PRESETS: EQPreset[] = [
    { name: "Flat", bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], icon: "—" },
    { name: "Bass Boost", bands: [6, 5, 4, 2, 0, 0, 0, 0, 0, 0], icon: "🔊" },
    { name: "Treble Boost", bands: [0, 0, 0, 0, 0, 0, 2, 4, 5, 6], icon: "✨" },
    { name: "V-Shape", bands: [5, 4, 2, 0, -2, -2, 0, 2, 4, 5], icon: "V" },
    { name: "Club", bands: [0, 0, 4, 3, 2, 2, 3, 4, 3, 0], icon: "🎵" },
    { name: "Electronic", bands: [5, 4, 1, 0, -1, 2, 1, 3, 5, 4], icon: "⚡" },
    { name: "Pop", bands: [-1, 1, 3, 4, 3, 0, -1, -1, 1, 2], icon: "🎤" },
    { name: "Rock", bands: [4, 3, 1, 0, -1, 1, 3, 4, 4, 3], icon: "🎸" },
    { name: "Hip-Hop", bands: [5, 4, 1, 2, -1, -1, 1, 0, 2, 3], icon: "🎧" },
    { name: "Jazz", bands: [0, 0, 1, 3, 3, 3, 2, 1, 2, 2], icon: "🎷" },
    { name: "Reggae", bands: [0, 0, 0, -1, 0, 1, 2, 0, 0, 0], icon: "🌴" },
    { name: "Vocal", bands: [-2, -1, 0, 2, 4, 4, 3, 1, 0, -1], icon: "🎙️" },
    { name: "Late Night", bands: [-3, -1, 0, 1, 2, 2, 1, 0, -2, -4], icon: "🌙" },
    { name: "Loudness", bands: [4, 3, 0, 0, -1, 0, -1, 0, 3, 4], icon: "📢" },
    { name: "Cinema", bands: [4, 3, 1, 0, 3, 4, 2, 1, 2, 3], icon: "🎬" },
];

export const DEFAULT_EFFECTS: EffectState = {
    compressorEnabled: false,
    compressorThreshold: -24,
    compressorKnee: 30,
    compressorRatio: 12,
    compressorAttack: 0.003,
    compressorRelease: 0.25,
    reverbEnabled: false,
    reverbMix: 0.3,
    reverbDecay: 2,
    delayEnabled: false,
    delayTime: 0.3,
    delayFeedback: 0.4,
    delayMix: 0.3,
    stereoEnabled: false,
    stereoWidth: 1,
    bassBoostEnabled: false,
    bassBoostAmount: 0.5,
};

// ─── Engine class ────────────────────────────────────────────────────────

export class EQEngine {
    private ctx: AudioContext;
    private filters: BiquadFilterNode[] = [];
    private preGain: GainNode;
    private compressor: DynamicsCompressorNode;
    // Reverb nodes
    private reverbConvolver: ConvolverNode;
    private reverbDry: GainNode;
    private reverbWet: GainNode;
    private reverbMerge: GainNode;
    // Delay nodes
    private delayNode: DelayNode;
    private delayFeedback: GainNode;
    private delayDry: GainNode;
    private delayWet: GainNode;
    private delayMerge: GainNode;
    // Bass boost
    private bassBoostFilter: BiquadFilterNode;
    // Chain endpoints
    private _input: AudioNode;
    private _output: AudioNode;

    constructor(ctx: AudioContext) {
        this.ctx = ctx;

        // Pre-gain
        this.preGain = ctx.createGain();
        this.preGain.gain.value = 1;

        // 10-band EQ filters
        this.filters = DEFAULT_BANDS.map((band) => {
            const filter = ctx.createBiquadFilter();
            filter.type = band.type;
            filter.frequency.value = band.frequency;
            filter.gain.value = band.gain;
            filter.Q.value = band.Q;
            return filter;
        });

        // Compressor
        this.compressor = ctx.createDynamicsCompressor();
        this.compressor.threshold.value = DEFAULT_EFFECTS.compressorThreshold;
        this.compressor.knee.value = DEFAULT_EFFECTS.compressorKnee;
        this.compressor.ratio.value = DEFAULT_EFFECTS.compressorRatio;
        this.compressor.attack.value = DEFAULT_EFFECTS.compressorAttack;
        this.compressor.release.value = DEFAULT_EFFECTS.compressorRelease;

        // Reverb
        this.reverbConvolver = ctx.createConvolver();
        this.reverbConvolver.buffer = this.createReverbIR(DEFAULT_EFFECTS.reverbDecay);
        this.reverbDry = ctx.createGain();
        this.reverbDry.gain.value = 1;
        this.reverbWet = ctx.createGain();
        this.reverbWet.gain.value = 0;
        this.reverbMerge = ctx.createGain();

        // Delay
        this.delayNode = ctx.createDelay(5);
        this.delayNode.delayTime.value = DEFAULT_EFFECTS.delayTime;
        this.delayFeedback = ctx.createGain();
        this.delayFeedback.gain.value = DEFAULT_EFFECTS.delayFeedback;
        this.delayDry = ctx.createGain();
        this.delayDry.gain.value = 1;
        this.delayWet = ctx.createGain();
        this.delayWet.gain.value = 0;
        this.delayMerge = ctx.createGain();

        // Bass boost
        this.bassBoostFilter = ctx.createBiquadFilter();
        this.bassBoostFilter.type = "lowshelf";
        this.bassBoostFilter.frequency.value = 100;
        this.bassBoostFilter.gain.value = 0;

        // Wire up chain
        this._input = this.preGain;

        // preGain → filter[0] → filter[1] → ... → filter[9]
        this.preGain.connect(this.filters[0]);
        for (let i = 0; i < this.filters.length - 1; i++) {
            this.filters[i].connect(this.filters[i + 1]);
        }
        const lastFilter = this.filters[this.filters.length - 1];

        // → bass boost
        lastFilter.connect(this.bassBoostFilter);

        // → compressor (always in chain, bypassed via ratio=1 when disabled)
        this.bassBoostFilter.connect(this.compressor);

        // compressor → reverb (dry/wet)
        this.compressor.connect(this.reverbDry);
        this.compressor.connect(this.reverbConvolver);
        this.reverbConvolver.connect(this.reverbWet);
        this.reverbDry.connect(this.reverbMerge);
        this.reverbWet.connect(this.reverbMerge);

        // reverb → delay (dry/wet)
        this.reverbMerge.connect(this.delayDry);
        this.reverbMerge.connect(this.delayNode);
        this.delayNode.connect(this.delayFeedback);
        this.delayFeedback.connect(this.delayNode);
        this.delayNode.connect(this.delayWet);
        this.delayDry.connect(this.delayMerge);
        this.delayWet.connect(this.delayMerge);

        this._output = this.delayMerge;
    }

    get input(): AudioNode { return this._input; }
    get output(): AudioNode { return this._output; }

    // ── Band control ─────────────────────────────────────────────────────

    setBandGain(index: number, gain: number) {
        if (this.filters[index]) {
            this.filters[index].gain.setTargetAtTime(gain, this.ctx.currentTime, 0.01);
        }
    }

    setBandQ(index: number, Q: number) {
        if (this.filters[index]) {
            this.filters[index].Q.setTargetAtTime(Q, this.ctx.currentTime, 0.01);
        }
    }

    setAllBands(gains: number[]) {
        gains.forEach((g, i) => this.setBandGain(i, g));
    }

    setPreGain(gain: number) {
        this.preGain.gain.setTargetAtTime(gain, this.ctx.currentTime, 0.01);
    }

    // ── Effects control ──────────────────────────────────────────────────

    updateCompressor(enabled: boolean, threshold: number, knee: number, ratio: number, attack: number, release: number) {
        const t = this.ctx.currentTime;
        if (!enabled) {
            // Bypass: ratio 1 = no compression
            this.compressor.ratio.setTargetAtTime(1, t, 0.01);
            return;
        }
        this.compressor.threshold.setTargetAtTime(threshold, t, 0.01);
        this.compressor.knee.setTargetAtTime(knee, t, 0.01);
        this.compressor.ratio.setTargetAtTime(ratio, t, 0.01);
        this.compressor.attack.setTargetAtTime(attack, t, 0.01);
        this.compressor.release.setTargetAtTime(release, t, 0.01);
    }

    updateReverb(enabled: boolean, mix: number, decay: number) {
        const t = this.ctx.currentTime;
        if (!enabled) {
            this.reverbDry.gain.setTargetAtTime(1, t, 0.02);
            this.reverbWet.gain.setTargetAtTime(0, t, 0.02);
            return;
        }
        this.reverbConvolver.buffer = this.createReverbIR(decay);
        this.reverbDry.gain.setTargetAtTime(1 - mix, t, 0.02);
        this.reverbWet.gain.setTargetAtTime(mix, t, 0.02);
    }

    updateDelay(enabled: boolean, time: number, feedback: number, mix: number) {
        const t = this.ctx.currentTime;
        if (!enabled) {
            this.delayDry.gain.setTargetAtTime(1, t, 0.02);
            this.delayWet.gain.setTargetAtTime(0, t, 0.02);
            this.delayFeedback.gain.setTargetAtTime(0, t, 0.02);
            return;
        }
        this.delayNode.delayTime.setTargetAtTime(time, t, 0.02);
        this.delayFeedback.gain.setTargetAtTime(feedback, t, 0.02);
        this.delayDry.gain.setTargetAtTime(1 - mix, t, 0.02);
        this.delayWet.gain.setTargetAtTime(mix, t, 0.02);
    }

    updateBassBoost(enabled: boolean, amount: number) {
        const gain = enabled ? amount * 12 : 0; // 0-12 dB
        this.bassBoostFilter.gain.setTargetAtTime(gain, this.ctx.currentTime, 0.01);
    }

    // ── Impulse response for reverb ──────────────────────────────────────

    private createReverbIR(decay: number): AudioBuffer {
        const rate = this.ctx.sampleRate;
        const length = Math.floor(rate * decay);
        const buffer = this.ctx.createBuffer(2, length, rate);
        for (let ch = 0; ch < 2; ch++) {
            const data = buffer.getChannelData(ch);
            for (let i = 0; i < length; i++) {
                data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 2);
            }
        }
        return buffer;
    }

    // ── Compressor reduction meter ───────────────────────────────────────

    getCompressorReduction(): number {
        return this.compressor.reduction;
    }

    destroy() {
        // Nodes are garbage collected when disconnected
        try {
            this.preGain.disconnect();
            this.filters.forEach(f => f.disconnect());
            this.bassBoostFilter.disconnect();
            this.compressor.disconnect();
            this.reverbDry.disconnect();
            this.reverbWet.disconnect();
            this.reverbConvolver.disconnect();
            this.reverbMerge.disconnect();
            this.delayNode.disconnect();
            this.delayFeedback.disconnect();
            this.delayDry.disconnect();
            this.delayWet.disconnect();
            this.delayMerge.disconnect();
        } catch {
            // Already disconnected
        }
    }
}
