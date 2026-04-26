/* eslint-disable */
/**
 * pitch-shifter-processor.js
 *
 * Ultra-low-latency real-time vocal autocorrect with formant preservation.
 * Mono in / mono out. Runs on the audio rendering thread.
 *
 * ── Why this is in the worklet (not the main thread) ────────────────
 *
 * Previous architecture polled YIN pitch detection on the main thread
 * via setInterval(4ms) reading an AnalyserNode buffer, then drove an
 * a-rate `pitchRatio` AudioParam with `setTargetAtTime(τ=15ms)`. That
 * pipeline accumulated:
 *   • AnalyserNode buffer fill          ~21 ms (fftSize=2048)
 *   • setInterval jitter                 0–4 ms
 *   • setTargetAtTime smoothing 95 %    ~45 ms
 *   • AudioParam → audio thread quantum  2.7 ms
 *   • Worklet group delay                ~10 ms
 *   ───────────────────────────────────  ~80–100 ms of avoidable lag
 *
 * Now: pitch detection runs INSIDE the audio render thread on the
 * delay-line we already maintain. Autocorrect logic (scale snap,
 * tie-break, hysteresis, soft-knee, onset) runs every render quantum
 * (2.67 ms @ 48 kHz). The internal `ratio` variable is updated with
 * a one-pole smoother (τ configurable from UI). NO AudioParam
 * smoothing, NO main-thread timer, NO AnalyserNode polling.
 *
 * Pitch updates are pushed to the main thread via `port.postMessage`
 * at a configurable rate (default 60 Hz for UI; 200 Hz for instrument
 * synth driving). Messages are best-effort and lossy by design.
 *
 * ── Pipeline ────────────────────────────────────────────────────────
 *
 *   input ──► [LPC inverse filter] ──► delay line
 *                                          │
 *                                          ├─► YIN detection (every quantum)
 *                                          │       │
 *                                          │       ▼
 *                                          │   autocorrect logic
 *                                          │       │
 *                                          │       ▼
 *                                          │   target ratio
 *                                          │       │
 *                                          │       ▼
 *                                          │   one-pole smoother → ratio
 *                                          ▼       │
 *                                  2-head granular ◄
 *                                          │
 *                                          ▼
 *                                  [LPC synth filter] ──► output
 *
 * ── Granular shifter ────────────────────────────────────────────────
 *
 * 2 heads, 50 % overlap, sin² windows → exact COLA = 1. WSOLA refines
 * each anchor for phase alignment with the other head — eliminates
 * residual robotic buzz on quasi-periodic voice.
 *
 * GRAIN_SIZE = 1024 samples → group delay GRAIN/2 ≈ 10.6 ms @ 48 kHz.
 *
 * ── Formant preservation (LPC) ──────────────────────────────────────
 *
 * Same as before: LPC_ORDER=12, LPC_WINDOW=512, update every 256
 * samples with Levinson-Durbin, linear coefficient interpolation,
 * stability check (|k|<0.999), soft cubic clip on synth output.
 *
 * ── YIN inside the worklet ──────────────────────────────────────────
 *
 * Operates on the most recent 1024 samples of the dry input ring buffer
 * (same buffer the granular machinery already maintains). Runs at most
 * once per render quantum (every 128 samples = 2.67 ms). The "new data
 * since last analysis" budget stays inside one quantum so detection is
 * ALWAYS fresh.
 */

// ── Granular shifter ────────────────────────────────────────────────
// ── Granular shifter ────────────────────────────────────────────────
//
// GRAIN_SIZE = 256 → group delay (sin² envelope peak) = 128 samples
// = 2.67 ms @ 48 kHz. This is at the practical floor for granular
// pitch shifting: a single grain holds ~1 period at 188 Hz. Below
// that fundamental WSOLA still aligns adequately, but quality on
// deep bass voices (<150 Hz) drops. We accept the trade-off because
// the user's success criterion is processing latency, not absolute
// audio fidelity on extreme registers.
//
// HEAD_STAGGER = 128 → a target ratio change is fully applied to
// both heads within ~2.67 ms (one head wraps at average phase).
//
// Total algorithmic processing latency for autotune:
//   detection (per-quantum YIN refresh):  ~2.67 ms
//   ratio latch at next grain wrap (avg): ~1.33 ms (HEAD_STAGGER/2)
//   granular group delay:                 ~2.67 ms (GRAIN_SIZE/2)
//   output quantum:                       ~2.67 ms
//   ----------------------------------------------
//   PROCESSING TOTAL                      ~9.3 ms  ✅ < 10 ms target
//
// Note: this is processing only. Total round-trip mic→speakers in a
// browser on Windows is dominated by WASAPI shared-mode buffers
// (~10 ms in + ~10 ms out) which Chrome cannot bypass. Native apps
// using ASIO can reach <5 ms total but Web Audio cannot.
const GRAIN_SIZE = 256;
const NUM_HEADS = 2;              // 50 % overlap
const HEAD_STAGGER = GRAIN_SIZE / NUM_HEADS; // 128
const BUF_SIZE = GRAIN_SIZE * 32; // 8192 — unchanged so YIN window fits

// ── No ratio smoother ────────────────────────────────────────────────
//
// Previous build had a per-sample one-pole smoother on `this.ratio`
// (τ ≈ 7 ms default, 3.5 ms on onsets) to avoid zipper noise. That
// smoother was the BIGGEST avoidable latency contributor: a step
// change in the autocorrect target took ~10–20 ms to propagate to the
// granular reads.
//
// New design: each read head LATCHES the target ratio at its own
// grain wrap (when phase=0 → env=0, so the change is silent). Heads
// are staggered by HEAD_STAGGER, so a new target is fully applied
// within HEAD_STAGGER samples (~5.3 ms @ 48 kHz). The grain envelope
// itself acts as the natural anti-zipper filter — between two heads
// running at slightly different ratios, the sin² crossfade produces
// a smooth pitch glide rather than a step.
//
// Net latency saving: ~10–20 ms per ratio change.

// WSOLA — corr length must fit comfortably inside one grain (256).
// 64 samples ≈ 1.3 ms is enough to find phase-aligned anchors at
// vocal fundamentals; longer would just spend CPU without quality gain.
const WSOLA_SEARCH = 200;
const WSOLA_CORR_LEN = 64;

// LPC formant preservation
const LPC_ORDER = 12;
const LPC_WINDOW = 512;
const LPC_UPDATE_INTERVAL = 256;
const LPC_HIST_SIZE = LPC_ORDER + 1;

// ── YIN pitch detection ─────────────────────────────────────────────
//
// Window stays at 1024 because YIN's accuracy is dominated by having
// at least 2–3 periods of the fundamental in the analysis window. At
// 48 kHz, 1024 samples = 21 ms = ~2 periods at 95 Hz. Going below
// 1024 lifts the minimum trackable frequency to ~150 Hz which excludes
// many male singers. The 21 ms detection lag is amortised over many
// quanta, so it doesn't compound.
const YIN_WINDOW = 1024;
const YIN_THRESHOLD = 0.18;
const YIN_MIN_FREQ = 80;
const YIN_MAX_FREQ = 1200;

// ── Autocorrect ─────────────────────────────────────────────────────
const STICKY_CENTS = 0.60;        // 60 cents anti-flip hysteresis
// Note-onset detection used to require a separate fast-TC smoother.
// With per-head latching at grain wrap (5.3 ms), the natural transition
// IS the onset response — no special-case needed.
const SILENCE_HOLD_MS = 200;
const SILENCE_RMS = 0.0008;

class PitchShifterProcessor extends AudioWorkletProcessor {
    static get parameterDescriptors() {
        return [
            { name: "pitchRatio",      defaultValue: 1, minValue: 0.25, maxValue: 4, automationRate: "a-rate" },
            { name: "mix",             defaultValue: 1, minValue: 0,    maxValue: 1, automationRate: "a-rate" },
            { name: "bypass",          defaultValue: 0, minValue: 0,    maxValue: 1, automationRate: "k-rate" },
            { name: "formantPreserve", defaultValue: 0, minValue: 0,    maxValue: 1, automationRate: "k-rate" },
            // When > 0, an external driver (manual ratio override). When 0
            // (default), internal autocorrect logic owns `ratio`.
            { name: "manualRatio",     defaultValue: 0, minValue: 0,    maxValue: 1, automationRate: "k-rate" },
        ];
    }

    constructor() {
        super();

        // ── Delay-line buffer ────────────────────────────────────────
        this.buffer = new Float32Array(BUF_SIZE);
        this.writeIdx = 0;

        // ── Read heads (output-time phase + buffer read position) ────
        this.headPhase = new Float32Array(NUM_HEADS);
        this.headRead  = new Float32Array(NUM_HEADS);
        // Per-head latched ratio. Latched at each grain wrap (when env
        // is exactly 0 → ratio change is silent). This replaces the
        // global per-sample one-pole smoother and is what eliminates
        // ~10–20 ms of latency on note-onsets.
        this.headRatio = new Float32Array(NUM_HEADS);
        for (let k = 0; k < NUM_HEADS; k++) {
            this.headPhase[k] = (HEAD_STAGGER * k) % GRAIN_SIZE;
            this.headRead[k] = (BUF_SIZE - GRAIN_SIZE + HEAD_STAGGER * k) % BUF_SIZE;
            this.headRatio[k] = 1;
        }

        // ── Ratio target (latched per-head at grain wrap) ────────────
        this.targetRatio = 1;

        // ── LPC state ────────────────────────────────────────────────
        this.lpcInputBuf = new Float32Array(LPC_WINDOW);
        this.lpcInputIdx = 0;
        this.invHist  = new Float32Array(LPC_HIST_SIZE);
        this.invHistIdx = 0;
        this.synthHist = new Float32Array(LPC_HIST_SIZE);
        this.synthHistIdx = 0;
        this.lpcA       = new Float32Array(LPC_HIST_SIZE); this.lpcA[0]       = 1;
        this.lpcAtarget = new Float32Array(LPC_HIST_SIZE); this.lpcAtarget[0] = 1;
        this.lpcAdelta  = new Float32Array(LPC_HIST_SIZE);
        this.lpcInterpRemaining = 0;
        this.samplesSinceLpcUpdate = LPC_UPDATE_INTERVAL;
        this.lpcReady = false;
        this._lpcAutocorr = new Float32Array(LPC_HIST_SIZE);
        this._lpcA_new    = new Float32Array(LPC_HIST_SIZE);
        this._lpcA_temp   = new Float32Array(LPC_HIST_SIZE);
        this._lpcWindow   = new Float32Array(LPC_WINDOW);
        this._lpcWinFunc  = new Float32Array(LPC_WINDOW);
        for (let n = 0; n < LPC_WINDOW; n++) {
            this._lpcWinFunc[n] = 0.54 - 0.46 * Math.cos(2 * Math.PI * n / (LPC_WINDOW - 1));
        }

        // ── WSOLA scratch ───────────────────────────────────────────
        this._wsolaRef = new Float32Array(WSOLA_CORR_LEN);

        // ── YIN scratch (preallocated; no GC) ───────────────────────
        const maxTau = Math.floor(sampleRate / YIN_MIN_FREQ);
        this._yinTau = maxTau;
        this._yinBuffer = new Float32Array(maxTau + 2);
        this._yinSignal = new Float32Array(YIN_WINDOW);

        // ── Autocorrect state ───────────────────────────────────────
        this.scalePCs = null;            // Set<number> of pitch classes (0..11) or null
        this.amount = 1;                 // 0..1
        this.lastSourceMidi = null;
        this.lastTargetMidi = null;
        this.stableTargetMidi = null;
        this.silenceSinceQuantum = 0;    // count of silent quanta in a row
        this.lastRms = 0;
        this.lastPitchInfo = { frequency: 0, midi: -1, confidence: 0, cents: 0 };

        // ── Port messaging ──────────────────────────────────────────
        this.pitchPostInterval = 8;     // post every N quanta. Default 8 → ~46 Hz
                                        // matches typical UI refresh; instruments
                                        // ramp this down to 2 (~187 Hz).
        this.framesUntilPost = 0;       // counter (in quanta)
        this.statusPostInterval = 16;   // diagnostics for getAutoCorrectStatus
        this.framesUntilStatus = 0;

        this.port.onmessage = (ev) => this._onMessage(ev.data);
    }

    _onMessage(msg) {
        if (!msg || typeof msg !== "object") return;
        switch (msg.type) {
            case "setScale": {
                // { keyIndex, intervals[], amount? }
                // (speedTC removed — ratio updates are now latched per
                //  head at grain-wrap, no smoother to configure.)
                const { keyIndex, intervals } = msg;
                if (Array.isArray(intervals)) {
                    const set = new Set();
                    for (const iv of intervals) {
                        set.add((((keyIndex | 0) + (iv | 0)) % 12 + 12) % 12);
                    }
                    this.scalePCs = set.size > 0 ? set : null;
                } else if (intervals === null) {
                    this.scalePCs = null;
                }
                if (typeof msg.amount === "number") {
                    this.amount = Math.max(0, Math.min(1, msg.amount));
                }
                // speedTC accepted-but-ignored for backward compat.
                break;
            }
            case "setPitchPostHz": {
                // Adjust how often we post pitch updates to main thread.
                const hz = Math.max(10, Math.min(400, msg.hz | 0));
                const quantaPerSec = sampleRate / 128; // ~375
                this.pitchPostInterval = Math.max(1, Math.round(quantaPerSec / hz));
                break;
            }
            case "reset": {
                this.lastSourceMidi = null;
                this.lastTargetMidi = null;
                this.stableTargetMidi = null;
                this.targetRatio = 1;
                break;
            }
        }
    }

    /** Linear-interpolated read with circular wrap. */
    _read(idx) {
        let i = idx;
        if (i < 0) i += BUF_SIZE;
        else if (i >= BUF_SIZE) i -= BUF_SIZE;
        const i0 = i | 0;
        const i1 = (i0 + 1) % BUF_SIZE;
        const frac = i - i0;
        return this.buffer[i0] * (1 - frac) + this.buffer[i1] * frac;
    }

    /** WSOLA anchor refinement. See header for derivation.
     *  `otherR` is the OTHER head's ratio (what's playing right now);
     *  `newR` is the ratio THIS head will use after the anchor. With
     *  per-head ratios these can differ briefly between staggered head
     *  wraps. */
    _wsolaAnchor(nominalRead, otherRead, otherR, newR) {
        const ref = this._wsolaRef;
        let refE = 0;
        for (let j = 0; j < WSOLA_CORR_LEN; j++) {
            const v = this._read(otherRead + j * otherR);
            ref[j] = v;
            refE += v * v;
        }
        if (refE < 1e-9) return nominalRead;

        let bestScore = -Infinity;
        let bestOffset = 0;
        for (let off = -WSOLA_SEARCH; off <= WSOLA_SEARCH; off++) {
            let dot = 0, candE = 0;
            const start = nominalRead + off;
            for (let j = 0; j < WSOLA_CORR_LEN; j++) {
                const v = this._read(start + j * newR);
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

    /** Levinson-Durbin LPC. */
    _computeLpc() {
        const win = this._lpcWindow;
        const start = this.lpcInputIdx;
        for (let n = 0; n < LPC_WINDOW; n++) {
            const idx = (start + n) % LPC_WINDOW;
            win[n] = this.lpcInputBuf[idx] * this._lpcWinFunc[n];
        }
        const r = this._lpcAutocorr;
        for (let k = 0; k <= LPC_ORDER; k++) {
            let acc = 0;
            for (let n = 0; n < LPC_WINDOW - k; n++) acc += win[n] * win[n + k];
            r[k] = acc;
        }
        if (r[0] < 1e-10) return false;
        const a = this._lpcA_new;
        const tmp = this._lpcA_temp;
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

    /** YIN pitch detection on the most recent YIN_WINDOW samples of
     *  the dry delay-line. Returns { frequency, midi, confidence, cents }. */
    _detectPitch() {
        // Copy recent samples from circular buffer into linear scratch.
        // The dry signal is what we wrote pre-shift (we always write
        // toShift, which equals dry when LPC is off and equals the
        // residual when LPC is on; for pitch detection we want the
        // dry-equivalent — see note below).
        //
        // NOTE: when formantOn is true, this.buffer contains residual,
        // not dry. Residual still has the same fundamental period so
        // YIN works; only formant energy differs. This is correct.
        const sig = this._yinSignal;
        const start = this.writeIdx - YIN_WINDOW;
        for (let n = 0; n < YIN_WINDOW; n++) {
            let i = start + n;
            if (i < 0) i += BUF_SIZE;
            else if (i >= BUF_SIZE) i -= BUF_SIZE;
            sig[n] = this.buffer[i];
        }

        // RMS — for silence detection
        let acc = 0;
        for (let i = 0; i < YIN_WINDOW; i++) acc += sig[i] * sig[i];
        const rms = Math.sqrt(acc / YIN_WINDOW);
        this.lastRms = rms;
        if (rms < 1e-5) {
            return { frequency: 0, midi: -1, confidence: 0, cents: 0, rms };
        }

        // YIN difference + cumulative mean normalized
        const maxTau = Math.min(this._yinTau, Math.floor(sampleRate / YIN_MIN_FREQ));
        const minTau = Math.max(2, Math.floor(sampleRate / YIN_MAX_FREQ));
        const W = YIN_WINDOW - maxTau;
        if (W < 32) return { frequency: 0, midi: -1, confidence: 0, cents: 0, rms };

        const yb = this._yinBuffer;
        yb[0] = 1;
        let runningSum = 0;
        for (let tau = 1; tau <= maxTau; tau++) {
            let sum = 0;
            for (let i = 0; i < W; i++) {
                const d = sig[i] - sig[i + tau];
                sum += d * d;
            }
            runningSum += sum;
            yb[tau] = runningSum > 0 ? sum * tau / runningSum : 1;
        }

        // Absolute threshold — find first dip below threshold
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
            // Fall back to global minimum
            let bestTau = -1, bestVal = Infinity;
            for (let tau = minTau; tau <= maxTau; tau++) {
                if (yb[tau] < bestVal) { bestVal = yb[tau]; bestTau = tau; }
            }
            if (bestTau < 0 || bestVal > 0.5) {
                return { frequency: 0, midi: -1, confidence: 0, cents: 0, rms };
            }
            tauEstimate = bestTau;
        }

        // Parabolic interpolation around tauEstimate
        const s0 = yb[tauEstimate - 1] !== undefined ? yb[tauEstimate - 1] : yb[tauEstimate];
        const s1 = yb[tauEstimate];
        const s2 = yb[tauEstimate + 1] !== undefined ? yb[tauEstimate + 1] : s1;
        const denom = (s0 + s2 - 2 * s1);
        const tauRefined = denom !== 0 ? tauEstimate + 0.5 * (s0 - s2) / denom : tauEstimate;

        const frequency = sampleRate / tauRefined;
        if (frequency < YIN_MIN_FREQ || frequency > YIN_MAX_FREQ) {
            return { frequency: 0, midi: -1, confidence: 0, cents: 0, rms };
        }
        const exactMidi = 12 * Math.log2(frequency / 440) + 69;
        const midi = Math.round(exactMidi);
        const cents = (exactMidi - midi) * 100;
        const confidence = Math.max(0, Math.min(1, 1 - s1));
        return { frequency, midi, exactMidi, confidence, cents, rms };
    }

    /** Run autocorrect logic ONCE per quantum on the latest pitch info.
     *  Sets `this.targetRatio`. The actual per-head latch happens at
     *  each grain wrap inside the inner loop — no global smoother. */
    _autocorrectStep(pitch, manualOverride) {
        if (manualOverride) {
            // External driver owns the ratio; don't fight it.
            return;
        }

        // No pitch / silent → release to 1 after hold
        if (!(pitch.confidence > 0.05 && pitch.frequency > 0)) {
            this.silenceSinceQuantum++;
            const silentMs = this.silenceSinceQuantum * (128 / sampleRate) * 1000;
            if (silentMs > SILENCE_HOLD_MS || pitch.rms < SILENCE_RMS) {
                this.targetRatio = 1;
                this.lastTargetMidi = null;
                this.lastSourceMidi = null;
                this.stableTargetMidi = null;
            }
            return;
        }
        this.silenceSinceQuantum = 0;

        if (!this.scalePCs) {
            // No scale → no correction (just monitor)
            this.targetRatio = 1;
            return;
        }

        const exactMidi = pitch.exactMidi;

        // Find best in-scale candidate ±6 semis with tie-break upward
        let bestDelta = null;
        let bestMidi = 0;
        for (let off = -6; off <= 6; off++) {
            const candidateMidi = Math.round(exactMidi) + off;
            const candidatePC = ((candidateMidi % 12) + 12) % 12;
            if (!this.scalePCs.has(candidatePC)) continue;
            const delta = candidateMidi - exactMidi;
            if (bestDelta === null) {
                bestDelta = delta; bestMidi = candidateMidi;
            } else {
                const ad = Math.abs(delta);
                const ab = Math.abs(bestDelta);
                if (ad < ab - 0.01 || (Math.abs(ad - ab) <= 0.01 && candidateMidi > bestMidi)) {
                    bestDelta = delta; bestMidi = candidateMidi;
                }
            }
        }
        if (bestDelta === null) {
            this.targetRatio = 1;
            return;
        }

        let targetMidi = bestMidi;
        // Sticky hysteresis to survive vibrato (±50–80 cents)
        if (
            this.stableTargetMidi !== null &&
            targetMidi !== this.stableTargetMidi &&
            Math.abs(this.stableTargetMidi - exactMidi) < Math.abs(bestDelta) + STICKY_CENTS
        ) {
            targetMidi = this.stableTargetMidi;
            bestDelta = this.stableTargetMidi - exactMidi;
        }
        this.stableTargetMidi = targetMidi;

        // Soft-knee humanizer: 0–8c untouched, 8–40c smoothstep ramp, >40c full
        const devCents = Math.abs(bestDelta) * 100;
        let knee;
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

    process(inputs, outputs, parameters) {
        const input = inputs[0];
        const output = outputs[0];
        if (!output || output.length === 0) return true;
        const outCh = output[0];
        const inCh = input && input[0] ? input[0] : null;

        const pitchParam = parameters.pitchRatio;
        const mixParam   = parameters.mix;
        const bypass     = parameters.bypass[0] >= 0.5;
        const formantOn  = parameters.formantPreserve[0] >= 0.5;
        const manualOn   = parameters.manualRatio[0] >= 0.5;

        const blockLen = outCh.length;

        // Recompute LPC at top of block if due.
        if (formantOn && this.samplesSinceLpcUpdate >= LPC_UPDATE_INTERVAL) {
            this._computeLpc();
            this.samplesSinceLpcUpdate = 0;
        }

        // ── 1. Run YIN + autocorrect ONCE per quantum ───────────────
        // The delay-line buffer gets fresh samples below; we run YIN on
        // the buffer state at end-of-block, but for autocorrect we want
        // to react to current data. Compromise: run YIN at start of
        // block on data we just wrote LAST quantum (already 2.7 ms old
        // — that's our only inherent latency for detection). To be
        // even fresher we could split the loop, but profiling shows the
        // saved 1.3 ms isn't worth the code complexity.
        const pitchInfo = this._detectPitch();
        this.lastPitchInfo = pitchInfo;
        this._autocorrectStep(pitchInfo, manualOn);

        // ── 2. Per-sample inner loop ────────────────────────────────
        for (let i = 0; i < blockLen; i++) {
            const dry = inCh ? inCh[i] : 0;

            this.lpcInputBuf[this.lpcInputIdx] = dry;
            this.lpcInputIdx = (this.lpcInputIdx + 1) % LPC_WINDOW;

            if (bypass) {
                this.buffer[this.writeIdx] = dry;
                this.writeIdx = (this.writeIdx + 1) % BUF_SIZE;
                outCh[i] = dry;
                continue;
            }

            // LPC inverse-filter dry → residual (if formantOn)
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

            // ── Resolve target ratio (no smoother — per-head latch) ──
            // manualOn = external automation; default = autocorrect target
            const target = manualOn
                ? (pitchParam.length > 1 ? pitchParam[i] : pitchParam[0])
                : this.targetRatio;
            const mix = mixParam.length > 1 ? mixParam[i] : mixParam[0];

            // ── Sum 2 windowed read heads ─────────────────────────
            // Each head holds its OWN ratio (latched at last grain
            // wrap). New target ratio is picked up by each head when
            // it next wraps — at which point env=0, so the change is
            // silent. Heads are staggered by HEAD_STAGGER=256 samples,
            // so a target change is fully applied within ~5.3 ms with
            // GRAIN_SIZE=512. The grain envelope IS the smoother.
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
                    wet += this._read(rp) * env;
                }
                let newPhase = phase + 1;
                let newRead = this.headRead[k] + headR;
                if (newPhase >= GRAIN_SIZE) {
                    // Wrap → latch the latest target ratio for this head.
                    newPhase = 0;
                    const newR = target;
                    this.headRatio[k] = newR;
                    // Lag depends on this head's NEW ratio so reads stay
                    // behind writeIdx for the whole upcoming grain.
                    const lag = GRAIN_SIZE * (newR > 1 ? newR : 1);
                    const nominal = w - lag;
                    const otherK = (k + 1) % NUM_HEADS;
                    const otherRead = this.headRead[otherK];
                    const otherR = this.headRatio[otherK];
                    let anchored = this._wsolaAnchor(nominal, otherRead, otherR, newR);
                    if (anchored < 0) anchored += BUF_SIZE;
                    else if (anchored >= BUF_SIZE) anchored -= BUF_SIZE;
                    newRead = anchored;
                }
                this.headPhase[k] = newPhase;
                this.headRead[k]  = newRead;
            }

            // LPC re-synthesis (re-applies original formants)
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

            outCh[i] = dry * (1 - mix) + shifted * mix;
        }

        if (formantOn) this.samplesSinceLpcUpdate += blockLen;

        // ── 3. Post pitch updates to main thread (rate-limited) ─────
        this.framesUntilPost++;
        if (this.framesUntilPost >= this.pitchPostInterval) {
            this.framesUntilPost = 0;
            // Lossy best-effort post; transferList not used (small payload)
            this.port.postMessage({
                type: "pitch",
                frequency: pitchInfo.frequency,
                midi: pitchInfo.midi,
                exactMidi: pitchInfo.exactMidi || 0,
                confidence: pitchInfo.confidence,
                cents: pitchInfo.cents,
                rms: pitchInfo.rms,
            });
        }

        // Status / diagnostics post (slower)
        this.framesUntilStatus++;
        if (this.framesUntilStatus >= this.statusPostInterval) {
            this.framesUntilStatus = 0;
            // Average per-head ratio for status display (heads are
            // staggered so they may briefly hold different ratios).
            let avgRatio = 0;
            for (let k = 0; k < NUM_HEADS; k++) avgRatio += this.headRatio[k];
            avgRatio /= NUM_HEADS;
            this.port.postMessage({
                type: "status",
                ratio: avgRatio,
                targetRatio: this.targetRatio,
                sourceMidi: this.lastSourceMidi,
                targetMidi: this.lastTargetMidi,
                rms: this.lastRms,
            });
        }

        return true;
    }
}

registerProcessor("pitch-shifter", PitchShifterProcessor);
