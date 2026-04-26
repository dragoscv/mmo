/**
 * smoke-passthrough.ts
 *
 * Manual sanity test for the native audio engine. Run via:
 *
 *   cd server
 *   pnpm exec tsx src/audio/smoke-passthrough.ts          # mic → speakers, no DSP
 *   pnpm exec tsx src/audio/smoke-passthrough.ts --tune   # with autocorrect
 *   pnpm exec tsx src/audio/smoke-passthrough.ts --list   # just list devices and exit
 *
 * Exits after 10 s. Prints metrics + last detected pitch.
 */

import { NativeAudioEngine, listDevices, listBackends } from "./native-engine";

const args = new Set(process.argv.slice(2));

if (args.has("--list")) {
    // eslint-disable-next-line no-console
    console.log("Backends:");
    // eslint-disable-next-line no-console
    console.log(listBackends());
    // eslint-disable-next-line no-console
    console.log("\nDevices (auto):");
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(listDevices("auto"), null, 2));
    process.exit(0);
}

const tune = args.has("--tune");

const engine = new NativeAudioEngine();
const metrics0 = engine.start({
    autoCorrect: tune,
    formantPreserve: tune,
    scale: tune ? { keyIndex: 0, intervals: [0, 2, 4, 5, 7, 9, 11], amount: 1 } : undefined,
    frameSize: 128,
    sampleRate: 48000,
});

// eslint-disable-next-line no-console
console.log("Started:", metrics0);

const t0 = Date.now();
const interval = setInterval(() => {
    const m = engine.metrics();
    const p = engine.lastPitch();
    // eslint-disable-next-line no-console
    console.log(
        `[${((Date.now() - t0) / 1000).toFixed(1)}s] ` +
        `cb=${m.callbackCount} fr=${m.frameSize} ` +
        `dspMax=${m.dspBlockMaxMs.toFixed(2)}ms dspAvg=${m.dspBlockAvgMs.toFixed(2)}ms ` +
        `streamLatency=${m.streamLatencyMs.toFixed(1)}ms ` +
        (p ? `pitch=${p.frequency.toFixed(1)}Hz midi=${p.midi} conf=${p.confidence.toFixed(2)}` : "no-pitch"),
    );
}, 1000);

setTimeout(() => {
    clearInterval(interval);
    engine.stop();
    // eslint-disable-next-line no-console
    console.log("Stopped.");
    process.exit(0);
}, 10000);
