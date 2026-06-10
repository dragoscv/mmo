"use client";

/**
 * Pioneer DDJ-FLX4 driver
 *
 * The DDJ-FLX4 follows the standard Pioneer DDJ MIDI layout:
 *
 *   Deck A: channel 0 (status 0x90)
 *   Deck B: channel 1 (status 0x91)
 *   Hot-cue pads Deck A: channel 7 (status 0x97), notes 0x00..0x07
 *   Hot-cue pads Deck B: channel 9 (status 0x99), notes 0x00..0x07
 *
 *   Transport notes (per deck channel):
 *     0x0B Play          0x0C Cue          0x58 Sync
 *     0x54 Headphone Cue 0x4D Reloop/Loop  0x10 Loop In  0x11 Loop Out
 *
 *   Pad-mode notes (per deck channel):
 *     0x1B Hot Cue       0x69 Beat Loop    0x6B Beat Jump    0x6D Sampler
 *
 * The FLX4's hot-cue pads have hardware-fixed orange colour — the device
 * does not honour per-cue RGB. We still write velocity from the colour
 * preset's perceived brightness so monochrome / dim presets visibly differ.
 */

import { BaseControllerDriver, type ControllerDriverInfo, type DriverDeckState, type DriverMixerState } from "../controller-driver";
import type { PadMode } from "@/lib/mixer-engine";

// ── Channels ────────────────────────────────────────────────────────────
// Deck transport buttons use channels 0/1 (status 0x90/0x91).
// Pad buttons use a separate "performance pad" channel per deck:
//   Deck A pads: ch 7 (0x97), with-SHIFT mirror ch 8 (0x98)
//   Deck B pads: ch 9 (0x99), with-SHIFT mirror ch 10 (0x9A)
const DECK_A_CH = 0;
const DECK_B_CH = 1;
const PADS_A_CH = 7;
const PADS_A_SHIFT_CH = 8;
const PADS_B_CH = 9;
const PADS_B_SHIFT_CH = 10;

// ── Transport / mode notes (verified against the Mixxx FLX4 mapping
//    and the official Pioneer DDJ-FLX4 MIDI message table) ──────────────
const NOTE_PLAY = 0x0B;
const NOTE_PLAY_SHIFT = 0x47;       // SHIFT+PLAY mirror
const NOTE_CUE = 0x0C;
const NOTE_CUE_SHIFT = 0x48;        // SHIFT+CUE mirror
const NOTE_SYNC = 0x58;             // SYNC LED (no Mixxx ref, per Pioneer table)
const NOTE_HEADPHONE_CUE = 0x54;    // HEADPHONE CUE LED
const NOTE_RELOOP = 0x4D;
const NOTE_RELOOP_SHIFT = 0x50;     // SHIFT mirror — Mixxx setReloopLight()
const NOTE_LOOP_IN = 0x10;
const NOTE_LOOP_OUT = 0x11;
const NOTE_LOOP_IN_SHIFT = 0x4C;    // Mixxx setLoopButtonLights()
const NOTE_LOOP_OUT_SHIFT = 0x4E;

// Pad-mode buttons. Values per Mixxx FLX4 lights table.
const NOTE_PAD_HOTCUE = 0x1B;
const NOTE_PAD_BEATLOOP = 0x6D;
const NOTE_PAD_BEATJUMP = 0x20;
const NOTE_PAD_SAMPLER = 0x22;

// Misc transport / mode notes (per Pioneer FLX4 MIDI table).
const NOTE_SLIP = 0x40;             // SLIP toggle LED
const NOTE_QUANTIZE = 0x36;         // QUANTIZE toggle LED (best-effort; not all FW expose it)

// Beat FX section (Pioneer master FX bus). On channel 4 (status 0x94).
const BEAT_FX_CH = 4;
const NOTE_BEAT_FX_ON = 0x47;       // ON/OFF LED (also lights via SHIFT alias 0x43)
const NOTE_BEAT_FX_ON_SHIFT = 0x43;

// VU meter CC (per Mixxx vuMeterUpdate). Sent on each deck channel.
const CC_VU_METER = 0x02;

// VU peak-hold tuning. Hold the peak for ~700 ms before letting it drop;
// then decay by ~1.5 % of full-scale per frame (≈ 30 ms at 30 Hz).
const VU_PEAK_HOLD_MS = 700;
const VU_PEAK_DECAY = 0.015;

const PAD_MODE_NOTES: Record<PadMode, number> = {
    hotcue: NOTE_PAD_HOTCUE,
    beatloop: NOTE_PAD_BEATLOOP,
    beatjump: NOTE_PAD_BEATJUMP,
    sampler: NOTE_PAD_SAMPLER,
};

// Pad cell "first note" by mode. Pad i (0..7) lights at FIRST_NOTE + i.
//   Hot Cue:   0x00..0x07
//   Beat Loop: 0x60..0x67
//   Beat Jump: 0x20..0x27   (matches Mixxx beatjumpSizeForPad)
//   Sampler:   0x30..0x37   (matches Mixxx samplerPlayOutputCallback)
const PAD_FIRST_NOTE: Record<PadMode, number> = {
    hotcue: 0x00,
    beatloop: 0x60,
    beatjump: 0x20,
    sampler: 0x30,
};

// All pad-cell base notes — needed when blanking, since switching pad mode
// must also extinguish the pads from the previously-active mode.
const ALL_PAD_FIRST_NOTES = [0x00, 0x60, 0x20, 0x30] as const;

// FLX4 LEDs are monochrome (white / amber / red, no RGB and no PWM).
// Velocity is interpreted as on/off only — anything below ~0x40 is "off".
// We send 0x7F for ON and 0x00 for OFF to be safe.
const ON = 0x7F;
const OFF = 0x00;

/**
 * Pioneer-proprietary SysEx wake-up message.
 *
 * Reverse-engineered from a USB capture by the Mixxx project. The DDJ-FLX4
 * (like other modern Pioneer DDJ controllers) ships in a "silent" LED mode:
 * it accepts MIDI Note Off / Note On writes but ignores them until the
 * controller has received this exact SysEx blob. The controller also
 * silently drops back into silent mode if it doesn't receive the message
 * again within ~250 ms — hence the keep-alive timer.
 *
 * Source: https://github.com/mixxxdj/mixxx/blob/main/res/controllers/Pioneer-DDJ-FLX4-script.js
 */
const FLX4_WAKE_SYSEX = [
    0xF0, 0x00, 0x40, 0x05, 0x00, 0x00, 0x04, 0x05, 0x00, 0x50, 0x02, 0xF7,
];
const KEEP_ALIVE_INTERVAL_MS = 200;

export class PioneerDDJFLX4Driver extends BaseControllerDriver {
    readonly info: ControllerDriverInfo = {
        id: "pioneer-ddj-flx4",
        name: "Pioneer DDJ-FLX4",
        vendor: "Pioneer DJ",
        deviceNameMatch: /DDJ[\s\-_.]?FLX[\s\-_.]?4/i,
        capabilities: {
            rgbHotCues: false,    // hardware-fixed orange
            rgbPadModes: false,
            screen: false,
            jogDisplay: false,
            motorisedJog: false,
            vuMeters: true,        // master VU only
        },
        description:
            "Two-deck Pioneer controller. Full LED feedback for play / cue / sync / loop / headphone-cue, pad-mode buttons and hot-cue pads. Hot-cue colours are fixed orange in hardware — colour presets adjust brightness instead.",
    };

    protected override onInit(): void {
        // The FLX4 (and other modern Pioneer DDJs) ship in a USB-audio-only
        // standby mode. Until we send the activation SysEx blob, the
        // controller does NOT emit MIDI input messages — so jog wheels,
        // pads, knobs etc. all appear "dead" to the host. SysEx is also
        // required for LED writes to take effect.
        if (process.env.NODE_ENV !== "production" && this.ctx) {
             
            console.info(`[FLX4] init deviceId=${this.ctx.deviceId} — sending wake-up SysEx`);
        }

        // 1. Wake the controller. If SysEx is denied this throws inside
        //    the engine and the warning surfaces from sendToDevice; the
        //    keep-alive below will keep retrying so a late permission
        //    grant still revives the controller.
        this.sendRaw(FLX4_WAKE_SYSEX);

        // 2. Start the keep-alive timer. Pioneer firmware drops back into
        //    "silent" mode if it doesn't see this message at least every
        //    ~250 ms, so we re-send every 200 ms.
        if (typeof window !== "undefined") {
            this.keepAliveTimer = window.setInterval(() => {
                this.sendRaw(FLX4_WAKE_SYSEX);
            }, KEEP_ALIVE_INTERVAL_MS);
        }

        // 3. Now that the controller is "awake", blank every LED to a
        //    known state so the next applyState pushes a clean diff.
        this.blankAllLeds();
    }

    protected override onDestroy(): void {
        if (this.keepAliveTimer !== null && typeof window !== "undefined") {
            window.clearInterval(this.keepAliveTimer);
            this.keepAliveTimer = null;
        }
        // Reset VU bars on disconnect.
        if (this.ctx) {
            this.ctx.engine.sendCC(this.ctx.deviceId, DECK_A_CH, CC_VU_METER, 0);
            this.ctx.engine.sendCC(this.ctx.deviceId, DECK_B_CH, CC_VU_METER, 0);
        }
        this.lastVu = {};
        this.vuSmoothed = {};
        this.vuPeak = {};
        this.vuPeakAt = {};
        this.blankAllLeds();
    }

    private keepAliveTimer: number | null = null;
    /** Last VU value sent per deck (post-quantization, used to gate sends). */
    private lastVu: Record<number, number> = {};
    /** Smoothed VU level per deck — fast attack, slow decay. */
    private vuSmoothed: Record<number, number> = {};
    /** Held peak per deck for the peak-hold ghost. */
    private vuPeak: Record<number, number> = {};
    /** Timestamp when the held peak was last refreshed. */
    private vuPeakAt: Record<number, number> = {};

    private blankAllLeds(): void {
        const decks: Array<{ ch: number; padCh: number; padShiftCh: number }> = [
            { ch: DECK_A_CH, padCh: PADS_A_CH, padShiftCh: PADS_A_SHIFT_CH },
            { ch: DECK_B_CH, padCh: PADS_B_CH, padShiftCh: PADS_B_SHIFT_CH },
        ];
        for (const { ch, padCh, padShiftCh } of decks) {
            // Transport (and SHIFT mirrors)
            this.sendNote(ch, NOTE_PLAY, OFF);
            this.sendNote(ch, NOTE_PLAY_SHIFT, OFF);
            this.sendNote(ch, NOTE_CUE, OFF);
            this.sendNote(ch, NOTE_CUE_SHIFT, OFF);
            this.sendNote(ch, NOTE_SYNC, OFF);
            this.sendNote(ch, NOTE_HEADPHONE_CUE, OFF);
            // Loop section (both regular + shifted notes)
            this.sendNote(ch, NOTE_RELOOP, OFF);
            this.sendNote(ch, NOTE_RELOOP_SHIFT, OFF);
            this.sendNote(ch, NOTE_LOOP_IN, OFF);
            this.sendNote(ch, NOTE_LOOP_IN_SHIFT, OFF);
            this.sendNote(ch, NOTE_LOOP_OUT, OFF);
            this.sendNote(ch, NOTE_LOOP_OUT_SHIFT, OFF);
            // Pad-mode buttons
            this.sendNote(ch, NOTE_PAD_HOTCUE, OFF);
            this.sendNote(ch, NOTE_PAD_BEATLOOP, OFF);
            this.sendNote(ch, NOTE_PAD_BEATJUMP, OFF);
            this.sendNote(ch, NOTE_PAD_SAMPLER, OFF);
            // Slip / quantize toggles
            this.sendNote(ch, NOTE_SLIP, OFF);
            this.sendNote(ch, NOTE_QUANTIZE, OFF);
            // Pad cells — clear every pad slot in every mode, both
            // regular + SHIFT mirror, so a stale pad doesn't stay lit
            // after a mode swap.
            for (const base of ALL_PAD_FIRST_NOTES) {
                for (let i = 0; i < 8; i++) {
                    this.sendNote(padCh, base + i, OFF);
                    this.sendNote(padShiftCh, base + i, OFF);
                }
            }
        }
        // Beat FX section + VU bars
        this.sendNote(BEAT_FX_CH, NOTE_BEAT_FX_ON, OFF);
        this.sendNote(BEAT_FX_CH, NOTE_BEAT_FX_ON_SHIFT, OFF);
        if (this.ctx) {
            this.ctx.engine.sendCC(this.ctx.deviceId, DECK_A_CH, CC_VU_METER, 0);
            this.ctx.engine.sendCC(this.ctx.deviceId, DECK_B_CH, CC_VU_METER, 0);
        }
        this.lastVu = {};
        this.vuSmoothed = {};
        this.vuPeak = {};
        this.vuPeakAt = {};
    }

    /**
     * Phase generator for blinking LEDs. Returns true on/false off based on
     * a wall-clock period. Mirrors the ~500 ms beat-LED blink Pioneer uses
     * on the play / cue / loop buttons.
     */
    private blinkPhase(periodMs: number): boolean {
        return Math.floor(Date.now() / periodMs) % 2 === 0;
    }

    protected onApplyState(state: DriverMixerState, prev: DriverMixerState | null): void {
        this.applyDeck(DECK_A_CH, PADS_A_CH, PADS_A_SHIFT_CH, state.decks.A, prev?.decks.A);
        this.applyDeck(DECK_B_CH, PADS_B_CH, PADS_B_SHIFT_CH, state.decks.B, prev?.decks.B);

        // ── Beat FX (master FX bus) ────────────────────────────────
        if (!prev || prev.beatFxOn !== state.beatFxOn) {
            this.sendNote(BEAT_FX_CH, NOTE_BEAT_FX_ON, state.beatFxOn ? ON : OFF);
            this.sendNote(BEAT_FX_CH, NOTE_BEAT_FX_ON_SHIFT, state.beatFxOn ? ON : OFF);
        }

        // ── VU meters ──────────────────────────────────────────────
        // Send raw CC (no diff cache) but quantise to ~7-bit so we
        // don't spam the controller every frame for tiny changes.
        this.pushVu(DECK_A_CH, state.decks.A.vuLevel);
        this.pushVu(DECK_B_CH, state.decks.B.vuLevel);
    }

    /**
     * VU meter renderer with asymmetric smoothing + peak hold.
     *
     * Behaviour mirrors a hardware level meter:
     *  - Fast attack (level rises instantly to catch transients).
     *  - Slow decay (level falls smoothly so the bar doesn't flicker).
     *  - Peak hold: the highest recent level lingers for ~700 ms, then
     *    drops gracefully. Because the FLX4 has a single value-per-deck
     *    LED ladder we ship `max(smoothed, peak)` so the topmost lit
     *    segment stays parked at the recent peak.
     */
    private pushVu(channel: number, level: number): void {
        if (!this.ctx) return;

        const now = (typeof performance !== "undefined" ? performance.now() : Date.now());
        const prev = this.vuSmoothed[channel] ?? 0;
        // Fast attack, slow decay (~250 ms to fall by ~63 %).
        const smoothed = level >= prev
            ? prev * 0.4 + level * 0.6
            : prev * 0.88 + level * 0.12;
        this.vuSmoothed[channel] = smoothed;

        // Peak hold: latch new peaks immediately, hold for VU_PEAK_HOLD_MS,
        // then decay at VU_PEAK_DECAY units / frame.
        const peakPrev = this.vuPeak[channel] ?? 0;
        const peakAt = this.vuPeakAt[channel] ?? 0;
        let peak = peakPrev;
        if (smoothed >= peakPrev) {
            peak = smoothed;
            this.vuPeakAt[channel] = now;
        } else if (now - peakAt > VU_PEAK_HOLD_MS) {
            peak = Math.max(smoothed, peakPrev - VU_PEAK_DECAY);
        }
        this.vuPeak[channel] = peak;

        const display = Math.max(smoothed, peak);
        const value = Math.max(0, Math.min(127, Math.round(display * 127)));
        // 18 CC units ≈ one of the 7 LED segments; stepping by ~9 (one
        // half-segment) is the sweet spot between fluidity and traffic.
        const q = Math.round(value / 9) * 9;
        if (this.lastVu[channel] === q) return;
        this.lastVu[channel] = q;
        this.ctx.engine.sendCC(this.ctx.deviceId, channel, CC_VU_METER, q);
    }

    private applyDeck(
        ch: number,
        padCh: number,
        padShiftCh: number,
        deck: DriverDeckState,
        prev: DriverDeckState | undefined,
    ): void {
        const set = (channel: number, note: number, on: boolean) =>
            this.sendNote(channel, note, on ? ON : OFF);

        // ── PLAY LED ───────────────────────────────────────────────
        // Pioneer convention: solid while playing, flash when the
        // track is in the last 30 s, fast-flash in the last 15 s.
        let playOn = deck.isPlaying;
        if (deck.isPlaying && deck.duration > 0) {
            const remaining = deck.duration - deck.currentTime;
            if (remaining < 15) playOn = this.blinkPhase(150);
            else if (remaining < 30) playOn = this.blinkPhase(400);
        }
        set(ch, NOTE_PLAY, playOn);
        set(ch, NOTE_PLAY_SHIFT, playOn);

        // ── CUE LED ────────────────────────────────────────────────
        // Solid whenever a track is loaded so the dj can see the cue
        // is armed. Flashes while paused at position 0 (the implicit
        // cue point) to invite a press. Off when no track is loaded.
        let cueOn = deck.isLoaded;
        if (deck.isLoaded && !deck.isPlaying && deck.currentTime <= 0.05) {
            cueOn = this.blinkPhase(400);
        } else if (deck.isCueing) {
            cueOn = true;
        }
        set(ch, NOTE_CUE, cueOn);
        set(ch, NOTE_CUE_SHIFT, cueOn);

        // ── SYNC LED ───────────────────────────────────────────────
        if (!prev || prev.syncEnabled !== deck.syncEnabled) {
            set(ch, NOTE_SYNC, deck.syncEnabled);
        }

        // ── HEADPHONE CUE LED ──────────────────────────────────────
        if (!prev || prev.headphoneCue !== deck.headphoneCue) {
            set(ch, NOTE_HEADPHONE_CUE, deck.headphoneCue);
        }

        // ── SLIP / QUANTIZE toggles ───────────────────────────────
        if (!prev || prev.slipMode !== deck.slipMode) {
            set(ch, NOTE_SLIP, deck.slipMode);
        }
        if (!prev || prev.quantize !== deck.quantize) {
            set(ch, NOTE_QUANTIZE, deck.quantize);
        }

        // ── Loop section ───────────────────────────────────────────
        // Reloop pulses gently while the loop is engaged so the dj
        // can see audio is locked into the loop. Loop In / Loop Out
        // boundary buttons stay solid while a loop is active.
        const reloopOn = deck.loopEnabled ? this.blinkPhase(500) : false;
        set(ch, NOTE_RELOOP, reloopOn);
        set(ch, NOTE_RELOOP_SHIFT, reloopOn);
        if (!prev || prev.loopEnabled !== deck.loopEnabled) {
            set(ch, NOTE_LOOP_IN, deck.loopEnabled);
            set(ch, NOTE_LOOP_IN_SHIFT, deck.loopEnabled);
            set(ch, NOTE_LOOP_OUT, deck.loopEnabled);
            set(ch, NOTE_LOOP_OUT_SHIFT, deck.loopEnabled);
        }

        // ── Pad-mode buttons (exactly one lit) ──────────────────────
        const padModeChanged = !prev || prev.padMode !== deck.padMode;
        if (padModeChanged) {
            for (const mode of ["hotcue", "beatloop", "beatjump", "sampler"] as const) {
                set(ch, PAD_MODE_NOTES[mode], mode === deck.padMode);
            }
        }

        // ── Pad cells ───────────────────────────────────────────────
        // When the mode changes, blank pad slots from the previous
        // mode and paint pad slots in the new mode. When the mode
        // stays the same we only emit diffs for hot-cue slots that
        // changed (the only pad type whose "lit" state varies with
        // mixer state).
        if (padModeChanged && prev) {
            const prevBase = PAD_FIRST_NOTE[prev.padMode];
            for (let i = 0; i < 8; i++) {
                this.sendNote(padCh, prevBase + i, OFF);
                this.sendNote(padShiftCh, prevBase + i, OFF);
            }
        }

        const base = PAD_FIRST_NOTE[deck.padMode];
        for (let i = 0; i < 8; i++) {
            const note = base + i;
            const isSet = deck.hotCues[i] != null;
            const prevSet = prev?.hotCues[i] != null;

            switch (deck.padMode) {
                case "hotcue": {
                    if (padModeChanged || isSet !== prevSet) {
                        this.sendNote(padCh, note, isSet ? ON : OFF);
                        this.sendNote(padShiftCh, note, isSet ? ON : OFF);
                    }
                    break;
                }
                case "beatloop":
                case "beatjump":
                case "sampler": {
                    // All eight pads lit so the dj can see the slots
                    // are addressable. (Sampler will get per-slot
                    // playback feedback once the engine exposes it.)
                    if (padModeChanged) {
                        this.sendNote(padCh, note, ON);
                        this.sendNote(padShiftCh, note, ON);
                    }
                    break;
                }
            }
        }
    }

    runIdentifyAnimation(): void {
        if (!this.ctx) {
             
            console.warn("[DDJ-FLX4] identify: no context (driver not initialised)");
            return;
        }
         
        console.info(`[DDJ-FLX4] identify: flashing all LEDs on ${this.ctx.deviceId}`);
        // Suspend the diff loop's overwrites by clearing lastState & cache —
        // the bridge will keep calling applyState(snap), but we re-route
        // every send through the cache so the diff naturally produces no-ops.
        this.invalidateCache();
        this.lastState = null;

        const decks = [
            { ch: DECK_A_CH, padCh: PADS_A_CH, padShiftCh: PADS_A_SHIFT_CH },
            { ch: DECK_B_CH, padCh: PADS_B_CH, padShiftCh: PADS_B_SHIFT_CH },
        ];
        // Light EVERYTHING — go through `sendNote` so the cache reflects the
        // hardware state. Subsequent 800ms blank uses the same path.
        for (const { ch, padCh, padShiftCh } of decks) {
            for (const n of [
                NOTE_PLAY, NOTE_PLAY_SHIFT,
                NOTE_CUE, NOTE_CUE_SHIFT,
                NOTE_SYNC, NOTE_HEADPHONE_CUE,
                NOTE_RELOOP, NOTE_RELOOP_SHIFT,
                NOTE_LOOP_IN, NOTE_LOOP_IN_SHIFT,
                NOTE_LOOP_OUT, NOTE_LOOP_OUT_SHIFT,
                NOTE_PAD_HOTCUE, NOTE_PAD_BEATLOOP, NOTE_PAD_BEATJUMP, NOTE_PAD_SAMPLER,
            ]) {
                this.sendNote(ch, n, ON);
            }
            // Pads: light hot-cue slots in the active mode + sampler slots
            // so something is visible regardless of which mode is selected.
            for (const base of ALL_PAD_FIRST_NOTES) {
                for (let i = 0; i < 8; i++) {
                    this.sendNote(padCh, base + i, ON);
                    this.sendNote(padShiftCh, base + i, ON);
                }
            }
        }

        // Restore the real deck state after the flash.
        setTimeout(() => {
            if (!this.ctx) return;
             
            console.info("[DDJ-FLX4] identify: restoring state");
            this.invalidateCache();
            this.blankAllLeds();
            // The next bridge applyState() will repaint the live state because
            // `lastState` is null and our diff treats every field as new.
        }, 800);
    }
}
