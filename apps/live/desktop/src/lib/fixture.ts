/**
 * A synthetic session for the RENDERED design pass (WP21-20).
 *
 * A browser has no Tauri runtime, so without this the console renders empty ("Lanțul e gol") and the
 * hero visuals, the ribbon and the spectrum are never actually seen. With `VITE_LIVE_FIXTURE=1` at
 * build time — which only the cloud render mode sets (`scripts/e2e-cloud/vm-run.sh`) — the store is
 * seeded with a plausible session and the buses are fed synthetic frames.
 *
 * The flag is a **build-time constant**, so in a real build this module's body is dead code and the
 * app never invents a session. It is a test seam, not a feature.
 */
import { meterBus } from "./meter-bus";
import {
    reduce,
    initialProtocol,
    type Hello,
    type ProtocolState,
    type ServerMsg,
    type SessionState,
} from "./protocol";

export function fixtureEnabled(): boolean {
    return import.meta.env.VITE_LIVE_FIXTURE === "1";
}

const SAMPLE_RATE = 48000;

/** One insert with the parameters its visual reads, so the drawing is driven by real values. */
function insert(id: number, fx: string, params: [string, number][], enabled = true) {
    return { id, fx, enabled, params };
}

function state(): SessionState {
    return {
        preset: "Pop Polish",
        chain: [
            insert(1, "gate", [["threshold", -38], ["range", -24], ["attack", 3]]),
            insert(2, "eq", [["low_gain", 3], ["mid1_freq", 480], ["mid1_gain", -4], ["mid2_freq", 2600], ["mid2_gain", 2], ["high_gain", 1.5]]),
            insert(3, "deesser", [["frequency", 5500], ["range", 6]]),
            insert(4, "compressor", [["threshold", -18], ["ratio", 3.5], ["knee", 6], ["makeup", 3]]),
            insert(5, "autotune", [["key", 0], ["scale", 1], ["amount", 0.9], ["retune", 12], ["humanize", 0.2], ["formant", 0], ["fast", 1]]),
            insert(6, "saturator", [["drive", 0.35], ["character", 1]]),
            insert(7, "delay", [["time", 320], ["feedback", 0.38], ["mix", 0.22], ["ping_pong", 1]]),
            insert(8, "reverb", [["decay", 0.55], ["damping", 0.4], ["mix", 0.28], ["size", 0.6]]),
            insert(9, "limiter", [["ceiling", -1], ["release", 120]]),
        ],
        mix: {
            input_db: 0,
            main_db: -3,
            monitor_db: -6,
            monitor_dry: 0.2,
            monitor_untuned: false,
            bypass: false,
            mute: false,
            panic: false,
        },
        setlist: {
            version: 1,
            name: "Club set",
            songs: [
                {
                    title: "Warm up",
                    key: "A minor",
                    bpm: 96,
                    parts: [
                        { name: "Verse", preset: "Natural Vocal" },
                        { name: "Chorus", preset: "Pop Polish" },
                    ],
                },
                { title: "Second", key: "C major", bpm: 112, parts: [{ name: "Verse", preset: "Harmony Stack" }] },
            ],
        },
        position: { song: 0, part: 1 },
        presets: ["Natural Vocal", "Pop Polish", "Harmony Stack", "Hard Snap", "Speech / MC", "Ballad Hall"],
        factory_presets: ["Natural Vocal", "Pop Polish", "Harmony Stack", "Hard Snap", "Speech / MC", "Ballad Hall"],
        modified_presets: [],
        bpm: 96,
        revision: 1,
    };
}

/** The messages the engine would have sent, in order. */
export function fixtureMessages(): ServerMsg[] {
    const hello: Hello = {
        protocol: 1,
        version: "0.1.0+fixture",
        role: "controller",
        engine_name: "MixAI Live (fixture)",
        sample_rate: SAMPLE_RATE,
        buffer_frames: 128,
        devices: {
            host: "WASAPI Exclusive",
            input: "Audio Interface IN",
            output: "Audio Interface Out",
            sample_rate: SAMPLE_RATE,
            buffer_frames: 128,
        },
    } as Hello;
    const session: SessionState = state();
    return [
        { type: "hello", ...hello },
        { type: "state", state: session },
        {
            type: "devices",
            devices: [
                { id: 1, token: "fixture-controller", role: "controller", label: "this laptop", created_ms: 0 },
                { id: 2, token: "fixture-performer", role: "performer", label: "guitar phone", created_ms: 1200 },
                { id: 3, token: "fixture-viewer", role: "viewer", label: "watch", created_ms: 2400 },
            ],
        } as ServerMsg,
    ];
}

/** Apply the fixture to a protocol state (pure, so the shape is testable). */
export function applyFixture(s: ProtocolState): ProtocolState {
    return fixtureMessages().reduce(reduce, s);
}

let timers: number[] = [];

/** Seed the store and start the synthetic meters/spectrum. Idempotent. */
export function installFixture(set: (p: ProtocolState) => void): void {
    if (timers.length) return;
    set(applyFixture(initialProtocol));

    // Meters at the real rate, so the ballistics and the ribbon behave as they do live.
    let t = 0;
    timers.push(
        window.setInterval(() => {
            t += 1 / 30;
            const voiceGain = 0.55 + 0.3 * Math.sin(t * 1.7) * Math.sin(t * 0.31);
            const cents = 14 * Math.sin(t * 2.3) + 6 * Math.sin(t * 0.7);
            const midi = 57; // A3
            meterBus.publish({
                in_peak: 0.6 * voiceGain,
                in_rms: 0.3 * voiceGain,
                out_peak: [0.7 * voiceGain, 0.68 * voiceGain],
                out_rms: [0.35 * voiceGain, 0.34 * voiceGain],
                gr: [0, -2.5 * voiceGain, 0, -4 * voiceGain, 0, 0, 0, 0, 0],
                dsp_load: 0.22 + 0.05 * Math.sin(t),
                dsp_load_max: 0.34,
                xruns: 0,
                clipped: false,
                safety_gr: [voiceGain > 0.8 ? 0.6 : 0, 0],
                tune: { freq: 220 * 2 ** (cents / 1200), midi, cents, target: midi, correction_cents: -cents },
                latency_probe: "idle",
                chain_latency_samples: 1,
                monitor_chain_latency_samples: 1,
            });
        }, 1000 / 30),
    );

    // Spectrum at 15 Hz: a voice-like harmonic stack that moves.
    timers.push(
        window.setInterval(() => {
            t += 1 / 15;
            const bins = new Array(128).fill(0);
            for (let i = 0; i < bins.length; i++) {
                const hz = ((i + 0.5) * (SAMPLE_RATE / 2)) / bins.length;
                const f0 = 220 * 2 ** ((6 * Math.sin(t * 2.3)) / 1200);
                let v = 0;
                for (let h = 1; h <= 8; h++) {
                    const f = f0 * h;
                    v += (72 / h) * Math.exp(-0.5 * (Math.log2(hz / f) / 0.09) ** 2);
                }
                v += 34 * Math.exp(-0.5 * (Math.log2(hz / 5000) / 0.6) ** 2) * (0.6 + 0.4 * Math.sin(t));
                // The byte scale is 0 = -90 dB, 255 = 0 dB: these coefficients put the peak around
                // -15 dB and the high-frequency tail around -35 dB, which is where a healthy voice
                // sits, so the rendered panels look like the real thing rather than a hairline.
                bins[i] = Math.max(0, Math.min(255, Math.round(v)));
            }
            meterBus.publishSpectrum(bins);
        }, 1000 / 15),
    );
}
