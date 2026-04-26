/**
 * pitch-dsp.ts
 *
 * Plain-TypeScript port of `app/public/worklets/pitch-shifter-processor.js`.
 * Same algorithm (YIN + 2-head granular OLA + WSOLA + LPC formant), no Web
 * Audio dependencies — runs in any V8 (Node Worker, Electron renderer, etc.).
 *
 * Public API:
 *   const dsp = new PitchDsp({ sampleRate: 48000 });
 *   dsp.setScale({ keyIndex: 0, intervals: [0,2,4,5,7,9,11], amount: 1 });
 *   dsp.setFormantPreserve(true);
 *   const out = dsp.process(inFloat32);   // mono in → mono out, same length
 *   const status = dsp.lastStatus();      // { ratio, targetMidi, ... }
 *
 * Block size for `process()` is arbitrary — the internal pipeline runs YIN
 * + autocorrect once per `quantum` (default 128 samples). For best latency
 * call with the same block size as the audio device callback.
 *
 * Latency budget identical to the worklet (see header of the .js file):
 * detection 2.67ms + ratio latch 1.33ms + grain group delay 2.67ms +
 * device output buffer = ~6.7ms + native I/O buffer.
 */

// ── Granular shifter ────────────────────────────────────────────────
const GRAIN_SIZE = 256;
const NUM_HEADS = 2;
const HEAD_STAGGER = GRAIN_SIZE / NUM_HEADS; // 128
const BUF_SIZE = GRAIN_SIZE * 32;            // 8192

// WSOLA
const WSOLA_SEARCH = 200;
const WSOLA_CORR_LEN = 64;

// LPC formant preservation
const LPC_ORDER = 12;
const LPC_WINDOW = 512;
const LPC_UPDATE_INTERVAL = 256;
const LPC_HIST_SIZE = LPC_ORDER + 1;

// YIN
const YIN_WINDOW = 1024;
const YIN_THRESHOLD = 0.18;
const YIN_MIN_FREQ = 80;
const YIN_MAX_FREQ = 1200;

// Autocorrect
const STICKY_CENTS = 0.60;
const SILENCE_HOLD_MS = 200;
const SILENCE_RMS = 0.0008;

const DEFAULT_QUANTUM = 128;

export interface PitchInfo {
    frequency: number;
    midi: number;
    exactMidi: number;
    confidence: number;
    cents: number;
    rms: number;
}

export interface DspStatus {
    ratio: number;
    targetRatio: number;
    sourceMidi: number | null;
    targetMidi: number | null;
    rms: number;
}

export interface PitchDspOptions {
    sampleRate: number;
    /** Internal control-rate quantum (samples). Default 128. Smaller =
     *  fresher YIN but more CPU. */
    quantum?: number;
}

export interface ScaleConfig {
    keyIndex: number;            // 0..11 (C..B)
    intervals: number[] | null;  // semitone offsets within scale
    amount?: number;             // 0..1 (1 = full snap)
}

export class PitchDsp {
    readonly sampleRate: number;
    readonly quantum: number;

    // Delay-line
    private buffer = new Float32Array(BUF_SIZE);
    private writeIdx = 0;

    // Read heads
    private headPhase = new Float32Array(NUM_HEADS);
    private headRead = new Float32Array(NUM_HEADS);
    private headRatio = new Float32Array(NUM_HEADS);

    // Ratio
    private targetRatio = 1;

    // LPC
    private lpcInputBuf = new Float32Array(LPC_WINDOW);
    private lpcInputIdx = 0;
    private invHist = new Float32Array(LPC_HIST_SIZE);
    private invHistIdx = 0;
    private synthHist = new Float32Array(LPC_HIST_SIZE);
    private synthHistIdx = 0;
    private lpcA = new Float32Array(LPC_HIST_SIZE);
    private lpcAtarget = new Float32Array(LPC_HIST_SIZE);
    private lpcAdelta = new Float32Array(LPC_HIST_SIZE);
    private lpcInterpRemaining = 0;
    private samplesSinceLpcUpdate = LPC_UPDATE_INTERVAL;
    private lpcReady = false;
    private formantOn = false;
    private lpcAutocorr = new Float32Array(LPC_HIST_SIZE);
    private lpcA_new = new Float32Array(LPC_HIST_SIZE);
    private lpcA_temp = new Float32Array(LPC_HIST_SIZE);
    private lpcWindow = new Float32Array(LPC_WINDOW);
    private lpcWinFunc = new Float32Array(LPC_WINDOW);

    // WSOLA scratch
    private wsolaRef = new Float32Array(WSOLA_CORR_LEN);

    // YIN scratch
    private yinTau: number;
    private yinBuffer: Float32Array;
    private yinSignal = new Float32Array(YIN_WINDOW);

    // Autocorrect state
    private scalePCs: Set<number> | null = null;
    private amount = 1;
    private lastSourceMidi: number | null = null;
    private lastTargetMidi: number | null = null;
    private stableTargetMidi: number | null = null;
    private silenceQuanta = 0;
    private lastRms = 0;
    private lastPitchInfo: PitchInfo = { frequency: 0, midi: -1, exactMidi: 0, confidence: 0, cents: 0, rms: 0 };

    // Bypass
    private bypassFlag = false;

    // Pitch listener (called once per quantum)
    onPitch: ((p: PitchInfo) => void) | null = null;

    constructor(opts: PitchDspOptions) {
        this.sampleRate = opts.sampleRate;
        this.quantum = opts.quantum ?? DEFAULT_QUANTUM;

        this.lpcA[0] = 1;
        this.lpcAtarget[0] = 1;

        for (let n = 0; n < LPC_WINDOW; n++) {
            this.lpcWinFunc[n] = 0.54 - 0.46 * Math.cos((2 * Math.PI * n) / (LPC_WINDOW - 1));
        }

        for (let k = 0; k < NUM_HEADS; k++) {
            this.headPhase[k] = (HEAD_STAGGER * k) % GRAIN_SIZE;
            this.headRead[k] = (BUF_SIZE - GRAIN_SIZE + HEAD_STAGGER * k) % BUF_SIZE;
            this.headRatio[k] = 1;
        }

        this.yinTau = Math.floor(this.sampleRate / YIN_MIN_FREQ);
        this.yinBuffer = new Float32Array(this.yinTau + 2);
    }

    // ── Public control ──────────────────────────────────────────────

    setScale(cfg: ScaleConfig): void {
        if (cfg.intervals === null) {
            this.scalePCs = null;
        } else {
            const set = new Set<number>();
            for (const iv of cfg.intervals) {
                set.add(((((cfg.keyIndex | 0) + (iv | 0)) % 12) + 12) % 12);
            }
            this.scalePCs = set.size > 0 ? set : null;
        }
        if (typeof cfg.amount === "number") {
            this.amount = Math.max(0, Math.min(1, cfg.amount));
        }
    }

    setFormantPreserve(on: boolean): void {
        this.formantOn = !!on;
    }

    setBypass(on: boolean): void {
        this.bypassFlag = !!on;
    }

    reset(): void {
        this.lastSourceMidi = null;
        this.lastTargetMidi = null;
        this.stableTargetMidi = null;
        this.targetRatio = 1;
    }

    lastPitch(): PitchInfo {
        return this.lastPitchInfo;
    }

    lastStatus(): DspStatus {
        let avgRatio = 0;
        for (let k = 0; k < NUM_HEADS; k++) avgRatio += this.headRatio[k];
        avgRatio /= NUM_HEADS;
        return {
            ratio: avgRatio,
            targetRatio: this.targetRatio,
            sourceMidi: this.lastSourceMidi,
            targetMidi: this.lastTargetMidi,
            rms: this.lastRms,
        };
    }

    // ── Audio processing ────────────────────────────────────────────

    /** Process an arbitrary-length mono block. Output written to `out`
     *  (must have same length as `input`). For best latency call with
     *  block size == device buffer size. */
    process(input: Float32Array, out: Float32Array): void {
        const len = input.length;
        let off = 0;
        while (off < len) {
            const take = Math.min(this.quantum, len - off);
            this.processQuantum(input.subarray(off, off + take), out.subarray(off, off + take));
            off += take;
        }
    }

    /** Process exactly one control quantum. */
    private processQuantum(inCh: Float32Array, outCh: Float32Array): void {
        const blockLen = outCh.length;

        if (this.formantOn && this.samplesSinceLpcUpdate >= LPC_UPDATE_INTERVAL) {
            this.computeLpc();
            this.samplesSinceLpcUpdate = 0;
        }

        // YIN + autocorrect once per quantum
        const pitchInfo = this.detectPitch();
        this.lastPitchInfo = pitchInfo;
        this.autocorrectStep(pitchInfo);
        if (this.onPitch) this.onPitch(pitchInfo);

        const bypass = this.bypassFlag;
        const formantOn = this.formantOn;

        for (let i = 0; i < blockLen; i++) {
            const dry = inCh[i];

            this.lpcInputBuf[this.lpcInputIdx] = dry;
            this.lpcInputIdx = (this.lpcInputIdx + 1) % LPC_WINDOW;

            if (bypass) {
                this.buffer[this.writeIdx] = dry;
                this.writeIdx = (this.writeIdx + 1) % BUF_SIZE;
                outCh[i] = dry;
                continue;
            }

            let toShift = dry;
            if (formantOn && this.lpcReady) {
                if (this.lpcInterpRemaining > 0) {
                    for (let k = 1; k <= LPC_ORDER; k++) this.lpcA[k] += this.lpcAdelta[k];
                    this.lpcInterpRemaining--;
                }
                let r = dry;
                for (let k = 1; k <= LPC_ORDER; k++) {
                    const idx = (this.invHistIdx - k + LPC_HIST_SIZE) % LPC_HIST_SIZE;
                    r += this.lpcA[k] * this.invHist[idx];
                }
                toShift = r;
                this.invHist[this.invHistIdx] = dry;
                this.invHistIdx = (this.invHistIdx + 1) % LPC_HIST_SIZE;
            }

            this.buffer[this.writeIdx] = toShift;
            this.writeIdx = (this.writeIdx + 1) % BUF_SIZE;

            const target = this.targetRatio;

            let wet = 0;
            const w = this.writeIdx;
            for (let k = 0; k < NUM_HEADS; k++) {
                const phase = this.headPhase[k];
                const headR = this.headRatio[k];
                const t = phase / GRAIN_SIZE;
                const s = Math.sin(Math.PI * t);
                const env = s * s;
                if (env > 0) {
                    let rp = this.headRead[k];
                    if (rp < 0) rp += BUF_SIZE;
                    else if (rp >= BUF_SIZE) rp -= BUF_SIZE;
                    wet += this.read(rp) * env;
                }
                let newPhase = phase + 1;
                let newRead = this.headRead[k] + headR;
                if (newPhase >= GRAIN_SIZE) {
                    newPhase = 0;
                    const newR = target;
                    this.headRatio[k] = newR;
                    const lag = GRAIN_SIZE * (newR > 1 ? newR : 1);
                    const nominal = w - lag;
                    const otherK = (k + 1) % NUM_HEADS;
                    const otherRead = this.headRead[otherK];
                    const otherR = this.headRatio[otherK];
                    let anchored = this.wsolaAnchor(nominal, otherRead, otherR, newR);
                    if (anchored < 0) anchored += BUF_SIZE;
                    else if (anchored >= BUF_SIZE) anchored -= BUF_SIZE;
                    newRead = anchored;
                }
                this.headPhase[k] = newPhase;
                this.headRead[k] = newRead;
            }

            let shifted = wet;
            if (formantOn && this.lpcReady) {
                let y = wet;
                for (let k = 1; k <= LPC_ORDER; k++) {
                    const idx = (this.synthHistIdx - k + LPC_HIST_SIZE) % LPC_HIST_SIZE;
                    y -= this.lpcA[k] * this.synthHist[idx];
                }
                const ay = y < 0 ? -y : y;
                if (ay > 3) {
                    const sgn = y < 0 ? -1 : 1;
                    y = sgn * (3 + (1 - 1 / (1 + (ay - 3) * 0.5)));
                }
                this.synthHist[this.synthHistIdx] = y;
                this.synthHistIdx = (this.synthHistIdx + 1) % LPC_HIST_SIZE;
                shifted = y;
            }

            outCh[i] = shifted;
        }

        if (formantOn) this.samplesSinceLpcUpdate += blockLen;
    }

    // ── Helpers ─────────────────────────────────────────────────────

    private read(idx: number): number {
        let i = idx;
        if (i < 0) i += BUF_SIZE;
        else if (i >= BUF_SIZE) i -= BUF_SIZE;
        const i0 = i | 0;
        const i1 = (i0 + 1) % BUF_SIZE;
        const frac = i - i0;
        return this.buffer[i0] * (1 - frac) + this.buffer[i1] * frac;
    }

    private wsolaAnchor(nominalRead: number, otherRead: number, otherR: number, newR: number): number {
        const ref = this.wsolaRef;
        let refE = 0;
        for (let j = 0; j < WSOLA_CORR_LEN; j++) {
            const v = this.read(otherRead + j * otherR);
            ref[j] = v;
            refE += v * v;
        }
        if (refE < 1e-9) return nominalRead;

        let bestScore = -Infinity;
        let bestOffset = 0;
        for (let off = -WSOLA_SEARCH; off <= WSOLA_SEARCH; off++) {
            let dot = 0;
            let candE = 0;
            const start = nominalRead + off;
            for (let j = 0; j < WSOLA_CORR_LEN; j++) {
                const v = this.read(start + j * newR);
                dot += v * ref[j];
                candE += v * v;
            }
            if (candE < 1e-9) continue;
            const score = dot / Math.sqrt(candE * refE);
            if (score > bestScore) {
                bestScore = score;
                bestOffset = off;
            }
        }
        return nominalRead + bestOffset;
    }

    private computeLpc(): boolean {
        const win = this.lpcWindow;
        const start = this.lpcInputIdx;
        for (let n = 0; n < LPC_WINDOW; n++) {
            const idx = (start + n) % LPC_WINDOW;
            win[n] = this.lpcInputBuf[idx] * this.lpcWinFunc[n];
        }
        const r = this.lpcAutocorr;
        for (let k = 0; k <= LPC_ORDER; k++) {
            let acc = 0;
            for (let n = 0; n < LPC_WINDOW - k; n++) acc += win[n] * win[n + k];
            r[k] = acc;
        }
        if (r[0] < 1e-10) return false;
        const a = this.lpcA_new;
        const tmp = this.lpcA_temp;
        a.fill(0); a[0] = 1;
        let e = r[0];
        for (let i = 1; i <= LPC_ORDER; i++) {
            let acc = r[i];
            for (let j = 1; j < i; j++) acc += a[j] * r[i - j];
            const k = -acc / e;
            if (Math.abs(k) >= 0.999) return false;
            tmp.set(a);
            tmp[i] = k;
            for (let j = 1; j < i; j++) tmp[j] = a[j] + k * a[i - j];
            a.set(tmp);
            e *= 1 - k * k;
            if (e < 1e-12) break;
        }
        for (let k = 0; k <= LPC_ORDER; k++) {
            this.lpcAtarget[k] = a[k];
            this.lpcAdelta[k] = (a[k] - this.lpcA[k]) / LPC_UPDATE_INTERVAL;
        }
        this.lpcInterpRemaining = LPC_UPDATE_INTERVAL;
        this.lpcReady = true;
        return true;
    }

    private detectPitch(): PitchInfo {
        const sig = this.yinSignal;
        const start = this.writeIdx - YIN_WINDOW;
        for (let n = 0; n < YIN_WINDOW; n++) {
            let i = start + n;
            if (i < 0) i += BUF_SIZE;
            else if (i >= BUF_SIZE) i -= BUF_SIZE;
            sig[n] = this.buffer[i];
        }

        let acc = 0;
        for (let i = 0; i < YIN_WINDOW; i++) acc += sig[i] * sig[i];
        const rms = Math.sqrt(acc / YIN_WINDOW);
        this.lastRms = rms;
        if (rms < 1e-5) {
            return { frequency: 0, midi: -1, exactMidi: 0, confidence: 0, cents: 0, rms };
        }

        const sr = this.sampleRate;
        const maxTau = Math.min(this.yinTau, Math.floor(sr / YIN_MIN_FREQ));
        const minTau = Math.max(2, Math.floor(sr / YIN_MAX_FREQ));
        const W = YIN_WINDOW - maxTau;
        if (W < 32) return { frequency: 0, midi: -1, exactMidi: 0, confidence: 0, cents: 0, rms };

        const yb = this.yinBuffer;
        yb[0] = 1;
        let runningSum = 0;
        for (let tau = 1; tau <= maxTau; tau++) {
            let sum = 0;
            for (let i = 0; i < W; i++) {
                const d = sig[i] - sig[i + tau];
                sum += d * d;
            }
            runningSum += sum;
            yb[tau] = runningSum > 0 ? (sum * tau) / runningSum : 1;
        }

        let tauEstimate = -1;
        for (let tau = minTau; tau <= maxTau; tau++) {
            if (yb[tau] < YIN_THRESHOLD) {
                let t = tau;
                while (t + 1 <= maxTau && yb[t + 1] < yb[t]) t++;
                tauEstimate = t;
                break;
            }
        }
        if (tauEstimate < 0) {
            let bestTau = -1;
            let bestVal = Infinity;
            for (let tau = minTau; tau <= maxTau; tau++) {
                if (yb[tau] < bestVal) {
                    bestVal = yb[tau];
                    bestTau = tau;
                }
            }
            if (bestTau < 0 || bestVal > 0.5) {
                return { frequency: 0, midi: -1, exactMidi: 0, confidence: 0, cents: 0, rms };
            }
            tauEstimate = bestTau;
        }

        const s0 = tauEstimate - 1 >= 0 ? yb[tauEstimate - 1] : yb[tauEstimate];
        const s1 = yb[tauEstimate];
        const s2 = tauEstimate + 1 <= maxTau ? yb[tauEstimate + 1] : s1;
        const denom = s0 + s2 - 2 * s1;
        const tauRefined = denom !== 0 ? tauEstimate + (0.5 * (s0 - s2)) / denom : tauEstimate;

        const frequency = sr / tauRefined;
        if (frequency < YIN_MIN_FREQ || frequency > YIN_MAX_FREQ) {
            return { frequency: 0, midi: -1, exactMidi: 0, confidence: 0, cents: 0, rms };
        }
        const exactMidi = 12 * Math.log2(frequency / 440) + 69;
        const midi = Math.round(exactMidi);
        const cents = (exactMidi - midi) * 100;
        const confidence = Math.max(0, Math.min(1, 1 - s1));
        return { frequency, midi, exactMidi, confidence, cents, rms };
    }

    private autocorrectStep(pitch: PitchInfo): void {
        if (!(pitch.confidence > 0.05 && pitch.frequency > 0)) {
            this.silenceQuanta++;
            const silentMs = (this.silenceQuanta * this.quantum * 1000) / this.sampleRate;
            if (silentMs > SILENCE_HOLD_MS || pitch.rms < SILENCE_RMS) {
                this.targetRatio = 1;
                this.lastTargetMidi = null;
                this.lastSourceMidi = null;
                this.stableTargetMidi = null;
            }
            return;
        }
        this.silenceQuanta = 0;

        if (!this.scalePCs) {
            this.targetRatio = 1;
            return;
        }

        const exactMidi = pitch.exactMidi;
        let bestDelta: number | null = null;
        let bestMidi = 0;
        for (let off = -6; off <= 6; off++) {
            const candidateMidi = Math.round(exactMidi) + off;
            const candidatePC = ((candidateMidi % 12) + 12) % 12;
            if (!this.scalePCs.has(candidatePC)) continue;
            const delta = candidateMidi - exactMidi;
            if (bestDelta === null) {
                bestDelta = delta;
                bestMidi = candidateMidi;
            } else {
                const ad = Math.abs(delta);
                const ab = Math.abs(bestDelta);
                if (ad < ab - 0.01 || (Math.abs(ad - ab) <= 0.01 && candidateMidi > bestMidi)) {
                    bestDelta = delta;
                    bestMidi = candidateMidi;
                }
            }
        }
        if (bestDelta === null) {
            this.targetRatio = 1;
            return;
        }

        let targetMidi = bestMidi;
        if (
            this.stableTargetMidi !== null &&
            targetMidi !== this.stableTargetMidi &&
            Math.abs(this.stableTargetMidi - exactMidi) < Math.abs(bestDelta) + STICKY_CENTS
        ) {
            targetMidi = this.stableTargetMidi;
            bestDelta = this.stableTargetMidi - exactMidi;
        }
        this.stableTargetMidi = targetMidi;

        const devCents = Math.abs(bestDelta) * 100;
        let knee: number;
        if (devCents <= 8) knee = 0;
        else if (devCents >= 40) knee = 1;
        else {
            const x = (devCents - 8) / (40 - 8);
            knee = x * x * (3 - 2 * x);
        }
        const semis = bestDelta * this.amount * knee;
        let r = Math.pow(2, semis / 12);
        if (r < 0.5) r = 0.5;
        if (r > 2) r = 2;
        this.targetRatio = r;

        this.lastSourceMidi = exactMidi;
        this.lastTargetMidi = targetMidi;
    }
}
