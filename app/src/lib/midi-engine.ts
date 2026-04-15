"use client";

/**
 * Web MIDI API Engine for DJ Controller Support
 *
 * Provides:
 * - Device detection and connection management
 * - MIDI message parsing (Note On/Off, CC, 14-bit)
 * - Configurable mappings (JSON-based, importable)
 * - Built-in DDJ-FLX4 preset
 * - MIDI learn mode for custom mapping
 */

// ─── Types ───────────────────────────────────────────────────────────────

export type MidiAction =
    // Transport
    | "play" | "cue" | "pause" | "sync"
    // Tempo
    | "tempo-slider" | "tempo-range"
    // Jog Wheel
    | "jog-touch" | "jog-vinyl" | "jog-bend" | "jog-search"
    // EQ
    | "eq-hi" | "eq-mid" | "eq-low" | "trim"
    // Mixer
    | "volume-fader" | "crossfader" | "filter" | "headphone-cue"
    // Loop
    | "loop-in" | "loop-out" | "reloop" | "loop-halve" | "loop-double"
    // Beat Loops (distinct sizes)
    | "beatloop-0.25" | "beatloop-0.5" | "beatloop-1" | "beatloop-2"
    | "beatloop-4" | "beatloop-8" | "beatloop-16" | "beatloop-32"
    // Hot Cues
    | "hotcue-1" | "hotcue-2" | "hotcue-3" | "hotcue-4"
    | "hotcue-5" | "hotcue-6" | "hotcue-7" | "hotcue-8"
    | "hotcue-1-clear" | "hotcue-2-clear" | "hotcue-3-clear" | "hotcue-4-clear"
    | "hotcue-5-clear" | "hotcue-6-clear" | "hotcue-7-clear" | "hotcue-8-clear"
    // Beat Jump
    | "beatjump-back-1" | "beatjump-fwd-1" | "beatjump-back-4" | "beatjump-fwd-4"
    // Pads
    | "pad-mode-hotcue" | "pad-mode-beatloop" | "pad-mode-beatjump" | "pad-mode-sampler"
    // Shift
    | "shift"
    // Beat FX
    | "fx-select" | "fx-on-off" | "fx-level"
    // Color FX
    | "color-fx-level" | "color-fx-select"
    // Master
    | "master-volume" | "master-cue"
    // Vinyl Brake
    | "vinyl-brake"
    // Pad Mode (generic cycle)
    | "pad-mode"
    // Browser / Load
    | "browse-turn" | "browse-press" | "back" | "load-deck"
    // Headphone
    | "headphone-mix" | "headphone-level"
    // Sampler
    | "sampler-1" | "sampler-2" | "sampler-3" | "sampler-4"
    | "sampler-5" | "sampler-6" | "sampler-7" | "sampler-8"
    // MIDI Clock
    | "midi-clock-start" | "midi-clock-stop";

export interface MidiMapping {
    /** MIDI status byte (channel + message type), e.g. 0x90 for Note On ch1 */
    status: number;
    /** MIDI note/CC number */
    midino: number;
    /** What this control does */
    action: MidiAction;
    /** Which deck (null for master/global controls) */
    deck: "A" | "B" | null;
    /** Control type */
    type: "note" | "cc" | "cc-14bit-msb" | "cc-14bit-lsb";
    /** Optional description */
    description?: string;
}

export interface MidiPreset {
    name: string;
    author: string;
    description: string;
    deviceNameMatch?: string; // Regex to auto-detect this controller
    mappings: MidiMapping[];
}

export interface MidiDevice {
    id: string;
    name: string;
    manufacturer: string;
    input: MIDIInput;
    output: MIDIOutput | null;
}

export interface MidiMessage {
    status: number; // Full status byte
    channel: number; // 0-15
    type: "noteOn" | "noteOff" | "cc";
    note: number; // note or CC number
    value: number; // velocity or CC value
    raw: Uint8Array;
}

// ─── MIDI Message Parser ─────────────────────────────────────────────────

export function parseMidiMessage(data: Uint8Array): MidiMessage | null {
    if (data.length < 2) return null;

    const status = data[0];
    const type = status & 0xf0;
    const channel = status & 0x0f;
    const note = data[1];
    const value = data.length > 2 ? data[2] : 0;

    switch (type) {
        case 0x90: // Note On (velocity 0 = Note Off)
            return {
                status, channel,
                type: value > 0 ? "noteOn" : "noteOff",
                note, value, raw: data,
            };
        case 0x80: // Note Off
            return {
                status, channel, type: "noteOff",
                note, value, raw: data,
            };
        case 0xb0: // Control Change
            return {
                status, channel, type: "cc",
                note, value, raw: data,
            };
        default:
            return null;
    }
}

// ─── MIDI Engine ─────────────────────────────────────────────────────────

export type MidiActionHandler = (action: MidiAction, deck: "A" | "B" | null, value: number, isPress: boolean) => void;

export class MidiEngine {
    private midiAccess: MIDIAccess | null = null;
    private devices: Map<string, MidiDevice> = new Map();
    private activeMapping: MidiPreset | null = null;
    private mappingLookup: Map<string, MidiMapping> = new Map();
    private handler: MidiActionHandler | null = null;
    private learnCallback: ((msg: MidiMessage) => void) | null = null;

    // 14-bit CC accumulator
    private cc14BitAccum: Map<string, number> = new Map();

    onDeviceChange?: (devices: MidiDevice[]) => void;
    onMessage?: (msg: MidiMessage) => void;

    async init(): Promise<boolean> {
        if (!navigator.requestMIDIAccess) {
            console.warn("Web MIDI API not supported in this browser");
            return false;
        }

        try {
            this.midiAccess = await navigator.requestMIDIAccess({ sysex: false });

            // Listen for device changes
            this.midiAccess.onstatechange = () => this.refreshDevices();

            this.refreshDevices();
            return true;
        } catch (err) {
            console.error("Failed to access MIDI devices:", err);
            return false;
        }
    }

    private refreshDevices() {
        if (!this.midiAccess) return;

        const newDevices = new Map<string, MidiDevice>();
        const inputs = this.midiAccess.inputs;
        const outputs = this.midiAccess.outputs;

        inputs.forEach((input) => {
            // Find matching output
            let matchingOutput: MIDIOutput | null = null;
            outputs.forEach((output) => {
                if (output.name === input.name || output.manufacturer === input.manufacturer) {
                    matchingOutput = output;
                }
            });

            const device: MidiDevice = {
                id: input.id,
                name: input.name || "Unknown MIDI Device",
                manufacturer: input.manufacturer || "",
                input,
                output: matchingOutput,
            };

            newDevices.set(input.id, device);

            // Attach message handler
            input.onmidimessage = (e: MIDIMessageEvent) => {
                const msg = parseMidiMessage(new Uint8Array(e.data));
                if (!msg) return;

                this.onMessage?.(msg);

                // MIDI learn mode
                if (this.learnCallback) {
                    this.learnCallback(msg);
                    return;
                }

                // Route through mapping
                this.routeMessage(msg);
            };
        });

        this.devices = newDevices;
        this.onDeviceChange?.(this.getDevices());
    }

    getDevices(): MidiDevice[] {
        return Array.from(this.devices.values());
    }

    setMapping(preset: MidiPreset) {
        this.activeMapping = preset;
        this.mappingLookup.clear();
        this.cc14BitAccum.clear();

        for (const m of preset.mappings) {
            const key = `${m.status}:${m.midino}`;
            this.mappingLookup.set(key, m);
        }
    }

    getActiveMapping(): MidiPreset | null {
        return this.activeMapping;
    }

    setHandler(handler: MidiActionHandler) {
        this.handler = handler;
    }

    /** Enter MIDI learn mode — next MIDI message triggers the callback */
    startLearn(callback: (msg: MidiMessage) => void) {
        this.learnCallback = callback;
    }

    stopLearn() {
        this.learnCallback = null;
    }

    isLearning(): boolean {
        return this.learnCallback !== null;
    }

    private routeMessage(msg: MidiMessage) {
        if (!this.handler) return;

        // Try exact status:note match
        const key = `${msg.status}:${msg.note}`;
        const mapping = this.mappingLookup.get(key);

        if (!mapping) return;

        if (mapping.type === "cc-14bit-msb") {
            // Store MSB, wait for LSB
            this.cc14BitAccum.set(`${mapping.action}:${mapping.deck}`, msg.value << 7);
            return;
        }

        if (mapping.type === "cc-14bit-lsb") {
            // Combine with stored MSB
            const msbKey = `${mapping.action}:${mapping.deck}`;
            const msb = this.cc14BitAccum.get(msbKey) || 0;
            const fullValue = msb | msg.value;
            const normalized = fullValue / 16383; // 0.0 - 1.0
            this.handler(mapping.action, mapping.deck, normalized, true);
            return;
        }

        if (mapping.type === "note") {
            const isPress = msg.type === "noteOn";
            this.handler(mapping.action, mapping.deck, msg.value / 127, isPress);
        } else {
            // Regular CC
            this.handler(mapping.action, mapping.deck, msg.value / 127, true);
        }
    }

    /** Send a message to the controller (for LED feedback) */
    sendToDevice(deviceId: string, data: number[]) {
        const device = this.devices.get(deviceId);
        if (device?.output) {
            device.output.send(new Uint8Array(data));
        }
    }

    /** Send LED feedback to all connected output devices */
    sendToAllDevices(data: number[]) {
        this.devices.forEach((device) => {
            if (device.output) {
                device.output.send(new Uint8Array(data));
            }
        });
    }

    /** Send a Note On to light an LED (status = 0x90+ch, note, velocity/color) */
    sendLED(channel: number, note: number, velocity: number) {
        const status = 0x90 | (channel & 0x0F);
        this.sendToAllDevices([status, note, velocity]);
    }

    /** Turn off an LED */
    sendLEDOff(channel: number, note: number) {
        const status = 0x80 | (channel & 0x0F);
        this.sendToAllDevices([status, note, 0]);
    }

    /** Update deck LEDs based on deck state */
    updateDeckLEDs(deck: "A" | "B", state: {
        isPlaying: boolean;
        padMode: string;
        slipMode: boolean;
        quantize: boolean;
        keyLock: boolean;
        headphoneCue: boolean;
        beatFxOn: boolean;
        loopEnabled: boolean;
    }) {
        const ch = deck === "A" ? 0 : 1;
        // Play button LED
        this.sendLED(ch, 0x0B, state.isPlaying ? 127 : 0);
        // Loop LED
        this.sendLED(ch, 0x4D, state.loopEnabled ? 127 : 0);
        // Headphone cue LED
        this.sendLED(ch, 0x54, state.headphoneCue ? 127 : 0);
    }

    /** Add a custom mapping to the current preset (for MIDI Learn) */
    addLearnedMapping(mapping: MidiMapping): boolean {
        if (!this.activeMapping) return false;
        // Remove existing mapping for same action + deck
        this.activeMapping.mappings = this.activeMapping.mappings.filter(
            m => !(m.action === mapping.action && m.deck === mapping.deck)
        );
        this.activeMapping.mappings.push(mapping);
        // Rebuild lookup
        this.setMapping(this.activeMapping);
        return true;
    }

    /** Get the first connected device with output capability */
    getFirstOutputDevice(): MidiDevice | null {
        for (const device of this.devices.values()) {
            if (device.output) return device;
        }
        return null;
    }

    /** Send MIDI clock pulse */
    sendClock() {
        this.sendToAllDevices([0xF8]);
    }

    /** Send MIDI clock start */
    sendClockStart() {
        this.sendToAllDevices([0xFA]);
    }

    /** Send MIDI clock stop */
    sendClockStop() {
        this.sendToAllDevices([0xFC]);
    }

    /** Auto-detect controller from connected devices */
    autoDetectPreset(presets: MidiPreset[]): MidiPreset | null {
        for (const device of this.devices.values()) {
            for (const preset of presets) {
                if (preset.deviceNameMatch) {
                    const regex = new RegExp(preset.deviceNameMatch, "i");
                    if (regex.test(device.name) || regex.test(device.manufacturer)) {
                        return preset;
                    }
                }
            }
        }
        return null;
    }

    /** Auto-detect external devices (grooveboxes, synths, etc.) */
    autoDetectExternalDevices(profiles: ExternalDeviceProfile[]): { profile: ExternalDeviceProfile; device: MidiDevice }[] {
        const found: { profile: ExternalDeviceProfile; device: MidiDevice }[] = [];
        for (const device of this.devices.values()) {
            for (const profile of profiles) {
                const regex = new RegExp(profile.deviceNameMatch, "i");
                if (regex.test(device.name) || regex.test(device.manufacturer)) {
                    found.push({ profile, device });
                }
            }
        }
        return found;
    }

    /** Send a CC message to a specific device */
    sendCC(deviceId: string, channel: number, cc: number, value: number) {
        const status = 0xB0 | (channel & 0x0F);
        this.sendToDevice(deviceId, [status, cc, Math.round(Math.max(0, Math.min(127, value)))]);
    }

    /** Send a Note On message to a specific device */
    sendNoteOn(deviceId: string, channel: number, note: number, velocity: number) {
        const status = 0x90 | (channel & 0x0F);
        this.sendToDevice(deviceId, [status, note, Math.round(Math.max(0, Math.min(127, velocity)))]);
    }

    /** Send a Note Off message to a specific device */
    sendNoteOff(deviceId: string, channel: number, note: number) {
        const status = 0x80 | (channel & 0x0F);
        this.sendToDevice(deviceId, [status, note, 0]);
    }

    /** Send MIDI Start (0xFA) to a specific device */
    sendStartToDevice(deviceId: string) {
        this.sendToDevice(deviceId, [0xFA]);
    }

    /** Send MIDI Stop (0xFC) to a specific device */
    sendStopToDevice(deviceId: string) {
        this.sendToDevice(deviceId, [0xFC]);
    }

    /** Send MIDI Clock (0xF8) to a specific device */
    sendClockToDevice(deviceId: string) {
        this.sendToDevice(deviceId, [0xF8]);
    }

    destroy() {
        this.devices.forEach(d => {
            d.input.onmidimessage = null;
        });
        this.devices.clear();
        this.mappingLookup.clear();
        this.handler = null;
        this.learnCallback = null;
    }
}

// ─── Built-in Presets ────────────────────────────────────────────────────

export const PIONEER_DDJ_FLX4_PRESET: MidiPreset = {
    name: "Pioneer DDJ-FLX4",
    author: "MMO",
    description: "Full mapping for Pioneer DDJ-FLX4 based on Mixxx community mapping",
    deviceNameMatch: "DDJ.FLX4|DDJ-FLX4",
    mappings: [
        // ── DECK 1 (Channel 0) ──────────────────────
        // Transport
        { status: 0x90, midino: 0x0B, action: "play", deck: "A", type: "note", description: "Play/Pause" },
        { status: 0x90, midino: 0x0C, action: "cue", deck: "A", type: "note", description: "Cue" },
        { status: 0x90, midino: 0x58, action: "sync", deck: "A", type: "note", description: "Beat Sync" },
        { status: 0x90, midino: 0x3F, action: "shift", deck: "A", type: "note", description: "Shift" },

        // Jog Wheel
        { status: 0x90, midino: 0x36, action: "jog-touch", deck: "A", type: "note", description: "Jog Touch" },
        { status: 0xB0, midino: 0x22, action: "jog-vinyl", deck: "A", type: "cc", description: "Jog Platter (Vinyl On)" },
        { status: 0xB0, midino: 0x23, action: "jog-bend", deck: "A", type: "cc", description: "Jog Platter (Vinyl Off)" },
        { status: 0xB0, midino: 0x21, action: "jog-bend", deck: "A", type: "cc", description: "Jog Side" },

        // Tempo
        { status: 0xB0, midino: 0x00, action: "tempo-slider", deck: "A", type: "cc-14bit-msb", description: "Tempo MSB" },
        { status: 0xB0, midino: 0x20, action: "tempo-slider", deck: "A", type: "cc-14bit-lsb", description: "Tempo LSB" },

        // EQ
        { status: 0xB0, midino: 0x04, action: "trim", deck: "A", type: "cc-14bit-msb", description: "Trim MSB" },
        { status: 0xB0, midino: 0x24, action: "trim", deck: "A", type: "cc-14bit-lsb", description: "Trim LSB" },
        { status: 0xB0, midino: 0x07, action: "eq-hi", deck: "A", type: "cc-14bit-msb", description: "EQ Hi MSB" },
        { status: 0xB0, midino: 0x27, action: "eq-hi", deck: "A", type: "cc-14bit-lsb", description: "EQ Hi LSB" },
        { status: 0xB0, midino: 0x0B, action: "eq-mid", deck: "A", type: "cc-14bit-msb", description: "EQ Mid MSB" },
        { status: 0xB0, midino: 0x2B, action: "eq-mid", deck: "A", type: "cc-14bit-lsb", description: "EQ Mid LSB" },
        { status: 0xB0, midino: 0x0F, action: "eq-low", deck: "A", type: "cc-14bit-msb", description: "EQ Low MSB" },
        { status: 0xB0, midino: 0x2F, action: "eq-low", deck: "A", type: "cc-14bit-lsb", description: "EQ Low LSB" },

        // Volume Fader
        { status: 0xB0, midino: 0x13, action: "volume-fader", deck: "A", type: "cc-14bit-msb", description: "Ch Fader MSB" },
        { status: 0xB0, midino: 0x33, action: "volume-fader", deck: "A", type: "cc-14bit-lsb", description: "Ch Fader LSB" },

        // Headphone Cue
        { status: 0x90, midino: 0x54, action: "headphone-cue", deck: "A", type: "note", description: "Headphone Cue" },

        // Loop
        { status: 0x90, midino: 0x10, action: "loop-in", deck: "A", type: "note", description: "Loop In" },
        { status: 0x90, midino: 0x11, action: "loop-out", deck: "A", type: "note", description: "Loop Out" },
        { status: 0x90, midino: 0x4D, action: "reloop", deck: "A", type: "note", description: "Reloop/Exit" },
        { status: 0x90, midino: 0x51, action: "loop-halve", deck: "A", type: "note", description: "Loop Half" },
        { status: 0x90, midino: 0x53, action: "loop-double", deck: "A", type: "note", description: "Loop Double" },

        // Hot Cues (ch 0x97 for Deck 1)
        { status: 0x97, midino: 0x00, action: "hotcue-1", deck: "A", type: "note", description: "Hot Cue 1" },
        { status: 0x97, midino: 0x01, action: "hotcue-2", deck: "A", type: "note", description: "Hot Cue 2" },
        { status: 0x97, midino: 0x02, action: "hotcue-3", deck: "A", type: "note", description: "Hot Cue 3" },
        { status: 0x97, midino: 0x03, action: "hotcue-4", deck: "A", type: "note", description: "Hot Cue 4" },
        { status: 0x97, midino: 0x04, action: "hotcue-5", deck: "A", type: "note", description: "Hot Cue 5" },
        { status: 0x97, midino: 0x05, action: "hotcue-6", deck: "A", type: "note", description: "Hot Cue 6" },
        { status: 0x97, midino: 0x06, action: "hotcue-7", deck: "A", type: "note", description: "Hot Cue 7" },
        { status: 0x97, midino: 0x07, action: "hotcue-8", deck: "A", type: "note", description: "Hot Cue 8" },
        // Hot Cue clear (ch 0x98 + shift)
        { status: 0x98, midino: 0x00, action: "hotcue-1-clear", deck: "A", type: "note", description: "Clear Hot Cue 1" },
        { status: 0x98, midino: 0x01, action: "hotcue-2-clear", deck: "A", type: "note", description: "Clear Hot Cue 2" },
        { status: 0x98, midino: 0x02, action: "hotcue-3-clear", deck: "A", type: "note", description: "Clear Hot Cue 3" },
        { status: 0x98, midino: 0x03, action: "hotcue-4-clear", deck: "A", type: "note", description: "Clear Hot Cue 4" },

        // ── DECK 2 (Channel 1) ──────────────────────
        // Transport
        { status: 0x91, midino: 0x0B, action: "play", deck: "B", type: "note", description: "Play/Pause" },
        { status: 0x91, midino: 0x0C, action: "cue", deck: "B", type: "note", description: "Cue" },
        { status: 0x91, midino: 0x58, action: "sync", deck: "B", type: "note", description: "Beat Sync" },
        { status: 0x91, midino: 0x3F, action: "shift", deck: "B", type: "note", description: "Shift" },

        // Jog Wheel
        { status: 0x91, midino: 0x36, action: "jog-touch", deck: "B", type: "note", description: "Jog Touch" },
        { status: 0xB1, midino: 0x22, action: "jog-vinyl", deck: "B", type: "cc", description: "Jog Platter (Vinyl On)" },
        { status: 0xB1, midino: 0x23, action: "jog-bend", deck: "B", type: "cc", description: "Jog Platter (Vinyl Off)" },
        { status: 0xB1, midino: 0x21, action: "jog-bend", deck: "B", type: "cc", description: "Jog Side" },

        // Tempo
        { status: 0xB1, midino: 0x00, action: "tempo-slider", deck: "B", type: "cc-14bit-msb", description: "Tempo MSB" },
        { status: 0xB1, midino: 0x20, action: "tempo-slider", deck: "B", type: "cc-14bit-lsb", description: "Tempo LSB" },

        // EQ
        { status: 0xB1, midino: 0x04, action: "trim", deck: "B", type: "cc-14bit-msb", description: "Trim MSB" },
        { status: 0xB1, midino: 0x24, action: "trim", deck: "B", type: "cc-14bit-lsb", description: "Trim LSB" },
        { status: 0xB1, midino: 0x07, action: "eq-hi", deck: "B", type: "cc-14bit-msb", description: "EQ Hi MSB" },
        { status: 0xB1, midino: 0x27, action: "eq-hi", deck: "B", type: "cc-14bit-lsb", description: "EQ Hi LSB" },
        { status: 0xB1, midino: 0x0B, action: "eq-mid", deck: "B", type: "cc-14bit-msb", description: "EQ Mid MSB" },
        { status: 0xB1, midino: 0x2B, action: "eq-mid", deck: "B", type: "cc-14bit-lsb", description: "EQ Mid LSB" },
        { status: 0xB1, midino: 0x0F, action: "eq-low", deck: "B", type: "cc-14bit-msb", description: "EQ Low MSB" },
        { status: 0xB1, midino: 0x2F, action: "eq-low", deck: "B", type: "cc-14bit-lsb", description: "EQ Low LSB" },

        // Volume Fader
        { status: 0xB1, midino: 0x13, action: "volume-fader", deck: "B", type: "cc-14bit-msb", description: "Ch Fader MSB" },
        { status: 0xB1, midino: 0x33, action: "volume-fader", deck: "B", type: "cc-14bit-lsb", description: "Ch Fader LSB" },

        // Headphone Cue
        { status: 0x91, midino: 0x54, action: "headphone-cue", deck: "B", type: "note", description: "Headphone Cue" },

        // Loop
        { status: 0x91, midino: 0x10, action: "loop-in", deck: "B", type: "note", description: "Loop In" },
        { status: 0x91, midino: 0x11, action: "loop-out", deck: "B", type: "note", description: "Loop Out" },
        { status: 0x91, midino: 0x4D, action: "reloop", deck: "B", type: "note", description: "Reloop/Exit" },
        { status: 0x91, midino: 0x51, action: "loop-halve", deck: "B", type: "note", description: "Loop Half" },
        { status: 0x91, midino: 0x53, action: "loop-double", deck: "B", type: "note", description: "Loop Double" },

        // Hot Cues (ch 0x99 for Deck 2)
        { status: 0x99, midino: 0x00, action: "hotcue-1", deck: "B", type: "note", description: "Hot Cue 1" },
        { status: 0x99, midino: 0x01, action: "hotcue-2", deck: "B", type: "note", description: "Hot Cue 2" },
        { status: 0x99, midino: 0x02, action: "hotcue-3", deck: "B", type: "note", description: "Hot Cue 3" },
        { status: 0x99, midino: 0x03, action: "hotcue-4", deck: "B", type: "note", description: "Hot Cue 4" },
        { status: 0x99, midino: 0x04, action: "hotcue-5", deck: "B", type: "note", description: "Hot Cue 5" },
        { status: 0x99, midino: 0x05, action: "hotcue-6", deck: "B", type: "note", description: "Hot Cue 6" },
        { status: 0x99, midino: 0x06, action: "hotcue-7", deck: "B", type: "note", description: "Hot Cue 7" },
        { status: 0x99, midino: 0x07, action: "hotcue-8", deck: "B", type: "note", description: "Hot Cue 8" },
        // Hot Cue clear
        { status: 0x9A, midino: 0x00, action: "hotcue-1-clear", deck: "B", type: "note", description: "Clear Hot Cue 1" },
        { status: 0x9A, midino: 0x01, action: "hotcue-2-clear", deck: "B", type: "note", description: "Clear Hot Cue 2" },
        { status: 0x9A, midino: 0x02, action: "hotcue-3-clear", deck: "B", type: "note", description: "Clear Hot Cue 3" },
        { status: 0x9A, midino: 0x03, action: "hotcue-4-clear", deck: "B", type: "note", description: "Clear Hot Cue 4" },

        // ── MASTER (Channel 6 = 0xB6) ───────────────
        { status: 0xB6, midino: 0x1F, action: "crossfader", deck: null, type: "cc-14bit-msb", description: "Crossfader MSB" },
        { status: 0xB6, midino: 0x3F, action: "crossfader", deck: null, type: "cc-14bit-lsb", description: "Crossfader LSB" },

        // Filter/CFX
        { status: 0xB6, midino: 0x17, action: "filter", deck: "A", type: "cc-14bit-msb", description: "Filter A MSB" },
        { status: 0xB6, midino: 0x37, action: "filter", deck: "A", type: "cc-14bit-lsb", description: "Filter A LSB" },
        { status: 0xB6, midino: 0x18, action: "filter", deck: "B", type: "cc-14bit-msb", description: "Filter B MSB" },
        { status: 0xB6, midino: 0x38, action: "filter", deck: "B", type: "cc-14bit-lsb", description: "Filter B LSB" },

        // Beat FX
        { status: 0x94, midino: 0x63, action: "fx-select", deck: null, type: "note", description: "FX Select" },
        { status: 0x94, midino: 0x47, action: "fx-on-off", deck: null, type: "note", description: "FX On/Off" },
        { status: 0xB4, midino: 0x02, action: "fx-level", deck: null, type: "cc", description: "FX Level/Depth" },

        // ── BROWSER / LOAD ──────────────────────────
        // Browse encoder (rotate & press)
        { status: 0xB6, midino: 0x40, action: "browse-turn", deck: null, type: "cc", description: "Browse Encoder Turn" },
        { status: 0x96, midino: 0x41, action: "browse-press", deck: null, type: "note", description: "Browse Encoder Press" },
        { status: 0x96, midino: 0x42, action: "back", deck: null, type: "note", description: "Back Button" },
        // Load buttons (on each deck side)
        { status: 0x96, midino: 0x46, action: "load-deck", deck: "A", type: "note", description: "Load Deck A" },
        { status: 0x96, midino: 0x48, action: "load-deck", deck: "B", type: "note", description: "Load Deck B" },

        // ── PAD MODES (Deck 1) ──────────────────────
        { status: 0x90, midino: 0x1B, action: "pad-mode-hotcue", deck: "A", type: "note", description: "Pad Mode: Hot Cue" },
        { status: 0x90, midino: 0x69, action: "pad-mode-beatloop", deck: "A", type: "note", description: "Pad Mode: Beat Loop" },
        { status: 0x90, midino: 0x6B, action: "pad-mode-beatjump", deck: "A", type: "note", description: "Pad Mode: Beat Jump" },
        { status: 0x90, midino: 0x6D, action: "pad-mode-sampler", deck: "A", type: "note", description: "Pad Mode: Sampler" },

        // Beat Loop pads (Deck 1, ch 0x97 mode 2)
        { status: 0x97, midino: 0x08, action: "beatloop-0.25", deck: "A", type: "note", description: "Beat Loop 1/4" },
        { status: 0x97, midino: 0x09, action: "beatloop-0.5", deck: "A", type: "note", description: "Beat Loop 1/2" },
        { status: 0x97, midino: 0x0A, action: "beatloop-1", deck: "A", type: "note", description: "Beat Loop 1" },
        { status: 0x97, midino: 0x0B, action: "beatloop-2", deck: "A", type: "note", description: "Beat Loop 2" },

        // Beat Jump pads (Deck 1)
        { status: 0x97, midino: 0x10, action: "beatjump-back-1", deck: "A", type: "note", description: "Beat Jump Back 1" },
        { status: 0x97, midino: 0x11, action: "beatjump-fwd-1", deck: "A", type: "note", description: "Beat Jump Fwd 1" },
        { status: 0x97, midino: 0x12, action: "beatjump-back-4", deck: "A", type: "note", description: "Beat Jump Back 4" },
        { status: 0x97, midino: 0x13, action: "beatjump-fwd-4", deck: "A", type: "note", description: "Beat Jump Fwd 4" },

        // ── PAD MODES (Deck 2) ──────────────────────
        { status: 0x91, midino: 0x1B, action: "pad-mode-hotcue", deck: "B", type: "note", description: "Pad Mode: Hot Cue" },
        { status: 0x91, midino: 0x69, action: "pad-mode-beatloop", deck: "B", type: "note", description: "Pad Mode: Beat Loop" },
        { status: 0x91, midino: 0x6B, action: "pad-mode-beatjump", deck: "B", type: "note", description: "Pad Mode: Beat Jump" },
        { status: 0x91, midino: 0x6D, action: "pad-mode-sampler", deck: "B", type: "note", description: "Pad Mode: Sampler" },

        // Beat Loop pads (Deck 2, ch 0x99 mode 2)
        { status: 0x99, midino: 0x08, action: "beatloop-0.25", deck: "B", type: "note", description: "Beat Loop 1/4" },
        { status: 0x99, midino: 0x09, action: "beatloop-0.5", deck: "B", type: "note", description: "Beat Loop 1/2" },
        { status: 0x99, midino: 0x0A, action: "beatloop-1", deck: "B", type: "note", description: "Beat Loop 1" },
        { status: 0x99, midino: 0x0B, action: "beatloop-2", deck: "B", type: "note", description: "Beat Loop 2" },

        // Beat Jump pads (Deck 2)
        { status: 0x99, midino: 0x10, action: "beatjump-back-1", deck: "B", type: "note", description: "Beat Jump Back 1" },
        { status: 0x99, midino: 0x11, action: "beatjump-fwd-1", deck: "B", type: "note", description: "Beat Jump Fwd 1" },
        { status: 0x99, midino: 0x12, action: "beatjump-back-4", deck: "B", type: "note", description: "Beat Jump Back 4" },
        { status: 0x99, midino: 0x13, action: "beatjump-fwd-4", deck: "B", type: "note", description: "Beat Jump Fwd 4" },

        // ── HEADPHONE ───────────────────────────────
        { status: 0xB6, midino: 0x0D, action: "headphone-mix", deck: null, type: "cc", description: "Headphone Mix" },
        { status: 0xB6, midino: 0x0E, action: "headphone-level", deck: null, type: "cc", description: "Headphone Level" },
    ],
};

/** Export a preset as JSON for sharing */
export function exportPreset(preset: MidiPreset): string {
    return JSON.stringify(preset, null, 2);
}

/** Import a preset from JSON */
export function importPreset(json: string): MidiPreset | null {
    try {
        const parsed = JSON.parse(json);
        if (!parsed.name || !Array.isArray(parsed.mappings)) return null;
        return parsed as MidiPreset;
    } catch {
        return null;
    }
}

// ─── Pioneer DDJ-400 Preset ─────────────────────────────────────────────

export const PIONEER_DDJ_400_PRESET: MidiPreset = {
    name: "Pioneer DDJ-400",
    author: "MMO",
    description: "Full mapping for Pioneer DDJ-400 (2-channel rekordbox controller)",
    deviceNameMatch: "DDJ.400|DDJ-400",
    mappings: [
        // Deck 1 (Channel 0)
        { status: 0x90, midino: 0x0B, action: "play", deck: "A", type: "note", description: "Play/Pause" },
        { status: 0x90, midino: 0x0C, action: "cue", deck: "A", type: "note", description: "Cue" },
        { status: 0x90, midino: 0x58, action: "sync", deck: "A", type: "note", description: "Sync" },
        { status: 0xB0, midino: 0x00, action: "tempo-slider", deck: "A", type: "cc-14bit-msb", description: "Tempo MSB" },
        { status: 0xB0, midino: 0x20, action: "tempo-slider", deck: "A", type: "cc-14bit-lsb", description: "Tempo LSB" },
        { status: 0xB0, midino: 0x07, action: "eq-hi", deck: "A", type: "cc", description: "EQ Hi" },
        { status: 0xB0, midino: 0x0B, action: "eq-mid", deck: "A", type: "cc", description: "EQ Mid" },
        { status: 0xB0, midino: 0x0F, action: "eq-low", deck: "A", type: "cc", description: "EQ Low" },
        { status: 0xB0, midino: 0x04, action: "trim", deck: "A", type: "cc", description: "Trim" },
        { status: 0xB0, midino: 0x13, action: "volume-fader", deck: "A", type: "cc-14bit-msb", description: "Volume MSB" },
        { status: 0xB0, midino: 0x33, action: "volume-fader", deck: "A", type: "cc-14bit-lsb", description: "Volume LSB" },
        { status: 0x90, midino: 0x54, action: "headphone-cue", deck: "A", type: "note", description: "Headphone Cue" },
        { status: 0xB0, midino: 0x22, action: "jog-vinyl", deck: "A", type: "cc", description: "Jog Vinyl" },
        { status: 0xB0, midino: 0x23, action: "jog-bend", deck: "A", type: "cc", description: "Jog Bend" },
        { status: 0x90, midino: 0x36, action: "jog-touch", deck: "A", type: "note", description: "Jog Touch" },
        { status: 0x90, midino: 0x10, action: "loop-in", deck: "A", type: "note", description: "Loop In" },
        { status: 0x90, midino: 0x11, action: "loop-out", deck: "A", type: "note", description: "Loop Out" },
        { status: 0x90, midino: 0x4D, action: "reloop", deck: "A", type: "note", description: "Reloop" },
        { status: 0x97, midino: 0x00, action: "hotcue-1", deck: "A", type: "note", description: "Hot Cue 1" },
        { status: 0x97, midino: 0x01, action: "hotcue-2", deck: "A", type: "note", description: "Hot Cue 2" },
        { status: 0x97, midino: 0x02, action: "hotcue-3", deck: "A", type: "note", description: "Hot Cue 3" },
        { status: 0x97, midino: 0x03, action: "hotcue-4", deck: "A", type: "note", description: "Hot Cue 4" },
        { status: 0x97, midino: 0x04, action: "hotcue-5", deck: "A", type: "note", description: "Hot Cue 5" },
        { status: 0x97, midino: 0x05, action: "hotcue-6", deck: "A", type: "note", description: "Hot Cue 6" },
        { status: 0x97, midino: 0x06, action: "hotcue-7", deck: "A", type: "note", description: "Hot Cue 7" },
        { status: 0x97, midino: 0x07, action: "hotcue-8", deck: "A", type: "note", description: "Hot Cue 8" },
        // Deck 2 (Channel 1)
        { status: 0x91, midino: 0x0B, action: "play", deck: "B", type: "note", description: "Play/Pause" },
        { status: 0x91, midino: 0x0C, action: "cue", deck: "B", type: "note", description: "Cue" },
        { status: 0x91, midino: 0x58, action: "sync", deck: "B", type: "note", description: "Sync" },
        { status: 0xB1, midino: 0x00, action: "tempo-slider", deck: "B", type: "cc-14bit-msb", description: "Tempo MSB" },
        { status: 0xB1, midino: 0x20, action: "tempo-slider", deck: "B", type: "cc-14bit-lsb", description: "Tempo LSB" },
        { status: 0xB1, midino: 0x07, action: "eq-hi", deck: "B", type: "cc", description: "EQ Hi" },
        { status: 0xB1, midino: 0x0B, action: "eq-mid", deck: "B", type: "cc", description: "EQ Mid" },
        { status: 0xB1, midino: 0x0F, action: "eq-low", deck: "B", type: "cc", description: "EQ Low" },
        { status: 0xB1, midino: 0x04, action: "trim", deck: "B", type: "cc", description: "Trim" },
        { status: 0xB1, midino: 0x13, action: "volume-fader", deck: "B", type: "cc-14bit-msb", description: "Volume MSB" },
        { status: 0xB1, midino: 0x33, action: "volume-fader", deck: "B", type: "cc-14bit-lsb", description: "Volume LSB" },
        { status: 0x91, midino: 0x54, action: "headphone-cue", deck: "B", type: "note", description: "Headphone Cue" },
        { status: 0xB1, midino: 0x22, action: "jog-vinyl", deck: "B", type: "cc", description: "Jog Vinyl" },
        { status: 0xB1, midino: 0x23, action: "jog-bend", deck: "B", type: "cc", description: "Jog Bend" },
        { status: 0x91, midino: 0x36, action: "jog-touch", deck: "B", type: "note", description: "Jog Touch" },
        { status: 0x91, midino: 0x10, action: "loop-in", deck: "B", type: "note", description: "Loop In" },
        { status: 0x91, midino: 0x11, action: "loop-out", deck: "B", type: "note", description: "Loop Out" },
        { status: 0x91, midino: 0x4D, action: "reloop", deck: "B", type: "note", description: "Reloop" },
        { status: 0x99, midino: 0x00, action: "hotcue-1", deck: "B", type: "note", description: "Hot Cue 1" },
        { status: 0x99, midino: 0x01, action: "hotcue-2", deck: "B", type: "note", description: "Hot Cue 2" },
        { status: 0x99, midino: 0x02, action: "hotcue-3", deck: "B", type: "note", description: "Hot Cue 3" },
        { status: 0x99, midino: 0x03, action: "hotcue-4", deck: "B", type: "note", description: "Hot Cue 4" },
        { status: 0x99, midino: 0x04, action: "hotcue-5", deck: "B", type: "note", description: "Hot Cue 5" },
        { status: 0x99, midino: 0x05, action: "hotcue-6", deck: "B", type: "note", description: "Hot Cue 6" },
        { status: 0x99, midino: 0x06, action: "hotcue-7", deck: "B", type: "note", description: "Hot Cue 7" },
        { status: 0x99, midino: 0x07, action: "hotcue-8", deck: "B", type: "note", description: "Hot Cue 8" },
        // Master
        { status: 0xB6, midino: 0x1F, action: "crossfader", deck: null, type: "cc-14bit-msb", description: "Crossfader MSB" },
        { status: 0xB6, midino: 0x3F, action: "crossfader", deck: null, type: "cc-14bit-lsb", description: "Crossfader LSB" },
        { status: 0xB6, midino: 0x17, action: "filter", deck: "A", type: "cc", description: "Filter A" },
        { status: 0xB6, midino: 0x18, action: "filter", deck: "B", type: "cc", description: "Filter B" },
        { status: 0xB6, midino: 0x0D, action: "headphone-mix", deck: null, type: "cc", description: "Headphone Mix" },
        { status: 0xB6, midino: 0x0E, action: "headphone-level", deck: null, type: "cc", description: "Headphone Level" },
        { status: 0x96, midino: 0x40, action: "browse-turn", deck: null, type: "cc", description: "Browse" },
        { status: 0x96, midino: 0x41, action: "browse-press", deck: null, type: "note", description: "Browse Press" },
        { status: 0x96, midino: 0x46, action: "load-deck", deck: "A", type: "note", description: "Load A" },
        { status: 0x96, midino: 0x48, action: "load-deck", deck: "B", type: "note", description: "Load B" },
        // Beat FX
        { status: 0x94, midino: 0x47, action: "fx-on-off", deck: null, type: "note", description: "FX On/Off" },
        { status: 0xB4, midino: 0x02, action: "fx-level", deck: null, type: "cc", description: "FX Level" },
    ],
};

// ─── Pioneer DDJ-1000 Preset ────────────────────────────────────────────

export const PIONEER_DDJ_1000_PRESET: MidiPreset = {
    name: "Pioneer DDJ-1000",
    author: "MMO",
    description: "Full mapping for Pioneer DDJ-1000 (4-channel pro rekordbox controller)",
    deviceNameMatch: "DDJ.1000|DDJ-1000",
    mappings: [
        // Deck 1 (Channel 0)
        { status: 0x90, midino: 0x0B, action: "play", deck: "A", type: "note", description: "Play/Pause" },
        { status: 0x90, midino: 0x0C, action: "cue", deck: "A", type: "note", description: "Cue" },
        { status: 0x90, midino: 0x58, action: "sync", deck: "A", type: "note", description: "Sync" },
        { status: 0xB0, midino: 0x00, action: "tempo-slider", deck: "A", type: "cc-14bit-msb", description: "Tempo MSB" },
        { status: 0xB0, midino: 0x20, action: "tempo-slider", deck: "A", type: "cc-14bit-lsb", description: "Tempo LSB" },
        { status: 0xB0, midino: 0x07, action: "eq-hi", deck: "A", type: "cc-14bit-msb", description: "EQ Hi MSB" },
        { status: 0xB0, midino: 0x27, action: "eq-hi", deck: "A", type: "cc-14bit-lsb", description: "EQ Hi LSB" },
        { status: 0xB0, midino: 0x0B, action: "eq-mid", deck: "A", type: "cc-14bit-msb", description: "EQ Mid MSB" },
        { status: 0xB0, midino: 0x2B, action: "eq-mid", deck: "A", type: "cc-14bit-lsb", description: "EQ Mid LSB" },
        { status: 0xB0, midino: 0x0F, action: "eq-low", deck: "A", type: "cc-14bit-msb", description: "EQ Low MSB" },
        { status: 0xB0, midino: 0x2F, action: "eq-low", deck: "A", type: "cc-14bit-lsb", description: "EQ Low LSB" },
        { status: 0xB0, midino: 0x04, action: "trim", deck: "A", type: "cc-14bit-msb", description: "Trim MSB" },
        { status: 0xB0, midino: 0x24, action: "trim", deck: "A", type: "cc-14bit-lsb", description: "Trim LSB" },
        { status: 0xB0, midino: 0x13, action: "volume-fader", deck: "A", type: "cc-14bit-msb", description: "Volume MSB" },
        { status: 0xB0, midino: 0x33, action: "volume-fader", deck: "A", type: "cc-14bit-lsb", description: "Volume LSB" },
        { status: 0x90, midino: 0x54, action: "headphone-cue", deck: "A", type: "note", description: "Headphone Cue" },
        { status: 0xB0, midino: 0x22, action: "jog-vinyl", deck: "A", type: "cc", description: "Jog Vinyl" },
        { status: 0xB0, midino: 0x23, action: "jog-bend", deck: "A", type: "cc", description: "Jog Bend" },
        { status: 0x90, midino: 0x36, action: "jog-touch", deck: "A", type: "note", description: "Jog Touch" },
        { status: 0x90, midino: 0x10, action: "loop-in", deck: "A", type: "note", description: "Loop In" },
        { status: 0x90, midino: 0x4D, action: "reloop", deck: "A", type: "note", description: "Reloop" },
        { status: 0x90, midino: 0x51, action: "loop-halve", deck: "A", type: "note", description: "Loop Halve" },
        { status: 0x90, midino: 0x53, action: "loop-double", deck: "A", type: "note", description: "Loop Double" },
        { status: 0x97, midino: 0x00, action: "hotcue-1", deck: "A", type: "note", description: "Hot Cue 1" },
        { status: 0x97, midino: 0x01, action: "hotcue-2", deck: "A", type: "note", description: "Hot Cue 2" },
        { status: 0x97, midino: 0x02, action: "hotcue-3", deck: "A", type: "note", description: "Hot Cue 3" },
        { status: 0x97, midino: 0x03, action: "hotcue-4", deck: "A", type: "note", description: "Hot Cue 4" },
        { status: 0x97, midino: 0x04, action: "hotcue-5", deck: "A", type: "note", description: "Hot Cue 5" },
        { status: 0x97, midino: 0x05, action: "hotcue-6", deck: "A", type: "note", description: "Hot Cue 6" },
        { status: 0x97, midino: 0x06, action: "hotcue-7", deck: "A", type: "note", description: "Hot Cue 7" },
        { status: 0x97, midino: 0x07, action: "hotcue-8", deck: "A", type: "note", description: "Hot Cue 8" },
        // Beat Jump pads Deck 1
        { status: 0x97, midino: 0x10, action: "beatjump-back-1", deck: "A", type: "note", description: "Beat Jump -1" },
        { status: 0x97, midino: 0x11, action: "beatjump-fwd-1", deck: "A", type: "note", description: "Beat Jump +1" },
        { status: 0x97, midino: 0x12, action: "beatjump-back-4", deck: "A", type: "note", description: "Beat Jump -4" },
        { status: 0x97, midino: 0x13, action: "beatjump-fwd-4", deck: "A", type: "note", description: "Beat Jump +4" },
        // Pad mode buttons Deck 1
        { status: 0x90, midino: 0x1B, action: "pad-mode-hotcue", deck: "A", type: "note", description: "Hot Cue Mode" },
        { status: 0x90, midino: 0x69, action: "pad-mode-beatloop", deck: "A", type: "note", description: "Beat Loop Mode" },
        { status: 0x90, midino: 0x6B, action: "pad-mode-beatjump", deck: "A", type: "note", description: "Beat Jump Mode" },
        { status: 0x90, midino: 0x6D, action: "pad-mode-sampler", deck: "A", type: "note", description: "Sampler Mode" },

        // Deck 2 (Channel 1)
        { status: 0x91, midino: 0x0B, action: "play", deck: "B", type: "note", description: "Play/Pause" },
        { status: 0x91, midino: 0x0C, action: "cue", deck: "B", type: "note", description: "Cue" },
        { status: 0x91, midino: 0x58, action: "sync", deck: "B", type: "note", description: "Sync" },
        { status: 0xB1, midino: 0x00, action: "tempo-slider", deck: "B", type: "cc-14bit-msb", description: "Tempo MSB" },
        { status: 0xB1, midino: 0x20, action: "tempo-slider", deck: "B", type: "cc-14bit-lsb", description: "Tempo LSB" },
        { status: 0xB1, midino: 0x07, action: "eq-hi", deck: "B", type: "cc-14bit-msb", description: "EQ Hi MSB" },
        { status: 0xB1, midino: 0x27, action: "eq-hi", deck: "B", type: "cc-14bit-lsb", description: "EQ Hi LSB" },
        { status: 0xB1, midino: 0x0B, action: "eq-mid", deck: "B", type: "cc-14bit-msb", description: "EQ Mid MSB" },
        { status: 0xB1, midino: 0x2B, action: "eq-mid", deck: "B", type: "cc-14bit-lsb", description: "EQ Mid LSB" },
        { status: 0xB1, midino: 0x0F, action: "eq-low", deck: "B", type: "cc-14bit-msb", description: "EQ Low MSB" },
        { status: 0xB1, midino: 0x2F, action: "eq-low", deck: "B", type: "cc-14bit-lsb", description: "EQ Low LSB" },
        { status: 0xB1, midino: 0x04, action: "trim", deck: "B", type: "cc-14bit-msb", description: "Trim MSB" },
        { status: 0xB1, midino: 0x24, action: "trim", deck: "B", type: "cc-14bit-lsb", description: "Trim LSB" },
        { status: 0xB1, midino: 0x13, action: "volume-fader", deck: "B", type: "cc-14bit-msb", description: "Volume MSB" },
        { status: 0xB1, midino: 0x33, action: "volume-fader", deck: "B", type: "cc-14bit-lsb", description: "Volume LSB" },
        { status: 0x91, midino: 0x54, action: "headphone-cue", deck: "B", type: "note", description: "Headphone Cue" },
        { status: 0xB1, midino: 0x22, action: "jog-vinyl", deck: "B", type: "cc", description: "Jog Vinyl" },
        { status: 0xB1, midino: 0x23, action: "jog-bend", deck: "B", type: "cc", description: "Jog Bend" },
        { status: 0x91, midino: 0x36, action: "jog-touch", deck: "B", type: "note", description: "Jog Touch" },
        { status: 0x91, midino: 0x10, action: "loop-in", deck: "B", type: "note", description: "Loop In" },
        { status: 0x91, midino: 0x4D, action: "reloop", deck: "B", type: "note", description: "Reloop" },
        { status: 0x91, midino: 0x51, action: "loop-halve", deck: "B", type: "note", description: "Loop Halve" },
        { status: 0x91, midino: 0x53, action: "loop-double", deck: "B", type: "note", description: "Loop Double" },
        { status: 0x99, midino: 0x00, action: "hotcue-1", deck: "B", type: "note", description: "Hot Cue 1" },
        { status: 0x99, midino: 0x01, action: "hotcue-2", deck: "B", type: "note", description: "Hot Cue 2" },
        { status: 0x99, midino: 0x02, action: "hotcue-3", deck: "B", type: "note", description: "Hot Cue 3" },
        { status: 0x99, midino: 0x03, action: "hotcue-4", deck: "B", type: "note", description: "Hot Cue 4" },
        { status: 0x99, midino: 0x04, action: "hotcue-5", deck: "B", type: "note", description: "Hot Cue 5" },
        { status: 0x99, midino: 0x05, action: "hotcue-6", deck: "B", type: "note", description: "Hot Cue 6" },
        { status: 0x99, midino: 0x06, action: "hotcue-7", deck: "B", type: "note", description: "Hot Cue 7" },
        { status: 0x99, midino: 0x07, action: "hotcue-8", deck: "B", type: "note", description: "Hot Cue 8" },
        // Beat Jump pads Deck 2
        { status: 0x99, midino: 0x10, action: "beatjump-back-1", deck: "B", type: "note", description: "Beat Jump -1" },
        { status: 0x99, midino: 0x11, action: "beatjump-fwd-1", deck: "B", type: "note", description: "Beat Jump +1" },
        { status: 0x99, midino: 0x12, action: "beatjump-back-4", deck: "B", type: "note", description: "Beat Jump -4" },
        { status: 0x99, midino: 0x13, action: "beatjump-fwd-4", deck: "B", type: "note", description: "Beat Jump +4" },
        // Pad modes Deck 2
        { status: 0x91, midino: 0x1B, action: "pad-mode-hotcue", deck: "B", type: "note", description: "Hot Cue Mode" },
        { status: 0x91, midino: 0x69, action: "pad-mode-beatloop", deck: "B", type: "note", description: "Beat Loop Mode" },
        { status: 0x91, midino: 0x6B, action: "pad-mode-beatjump", deck: "B", type: "note", description: "Beat Jump Mode" },
        { status: 0x91, midino: 0x6D, action: "pad-mode-sampler", deck: "B", type: "note", description: "Sampler Mode" },

        // Master
        { status: 0xB6, midino: 0x1F, action: "crossfader", deck: null, type: "cc-14bit-msb", description: "Crossfader MSB" },
        { status: 0xB6, midino: 0x3F, action: "crossfader", deck: null, type: "cc-14bit-lsb", description: "Crossfader LSB" },
        { status: 0xB6, midino: 0x17, action: "filter", deck: "A", type: "cc-14bit-msb", description: "Filter A MSB" },
        { status: 0xB6, midino: 0x37, action: "filter", deck: "A", type: "cc-14bit-lsb", description: "Filter A LSB" },
        { status: 0xB6, midino: 0x18, action: "filter", deck: "B", type: "cc-14bit-msb", description: "Filter B MSB" },
        { status: 0xB6, midino: 0x38, action: "filter", deck: "B", type: "cc-14bit-lsb", description: "Filter B LSB" },
        { status: 0xB6, midino: 0x0D, action: "headphone-mix", deck: null, type: "cc", description: "Headphone Mix" },
        { status: 0xB6, midino: 0x0E, action: "headphone-level", deck: null, type: "cc", description: "Headphone Level" },
        // Beat FX
        { status: 0x94, midino: 0x63, action: "fx-select", deck: null, type: "note", description: "FX Select" },
        { status: 0x94, midino: 0x47, action: "fx-on-off", deck: null, type: "note", description: "FX On/Off" },
        { status: 0xB4, midino: 0x02, action: "fx-level", deck: null, type: "cc", description: "FX Level" },
        // Browse
        { status: 0xB6, midino: 0x40, action: "browse-turn", deck: null, type: "cc", description: "Browse Turn" },
        { status: 0x96, midino: 0x41, action: "browse-press", deck: null, type: "note", description: "Browse Press" },
        { status: 0x96, midino: 0x42, action: "back", deck: null, type: "note", description: "Back" },
        { status: 0x96, midino: 0x46, action: "load-deck", deck: "A", type: "note", description: "Load A" },
        { status: 0x96, midino: 0x48, action: "load-deck", deck: "B", type: "note", description: "Load B" },
    ],
};

// ─── External Device Types (Grooveboxes, Synths, Drum Machines) ─────────

export type ExternalDeviceType = "groovebox" | "synth" | "drum-machine" | "sampler";

export interface ExternalDeviceTrack {
    name: string;
    type: "synth" | "drum" | "midi" | "audio";
    midiChannel: number; // 0-15
    color: string; // CSS color
    macroKnobs?: { cc: number; label: string }[];
    noteRange?: { low: number; high: number };
}

export interface ExternalDeviceProfile {
    id: string;
    name: string;
    manufacturer: string;
    type: ExternalDeviceType;
    deviceNameMatch: string; // Regex for auto-detection
    icon: string; // Emoji or icon identifier
    color: string; // Brand color
    tracks: ExternalDeviceTrack[];
    transport: {
        hasPlay: boolean;
        hasRecord: boolean;
        hasStop: boolean;
    };
    clock: {
        canSendClock: boolean;
        canReceiveClock: boolean;
        defaultSyncMode: "send" | "receive" | "none";
    };
    features: string[];
}

// ─── Novation Circuit Tracks Profile ─────────────────────────────────────

export const CIRCUIT_TRACKS_PROFILE: ExternalDeviceProfile = {
    id: "novation-circuit-tracks",
    name: "Circuit Tracks",
    manufacturer: "Novation",
    type: "groovebox",
    deviceNameMatch: "Circuit.Tracks|Circuit Tracks|CIRCUIT TRACKS",
    icon: "🎛️",
    color: "#FF6600", // Novation orange
    tracks: [
        {
            name: "Synth 1",
            type: "synth",
            midiChannel: 0, // Ch 1
            color: "#9333ea", // Purple
            macroKnobs: [
                { cc: 80, label: "Macro 1" },
                { cc: 81, label: "Macro 2" },
                { cc: 82, label: "Macro 3" },
                { cc: 83, label: "Macro 4" },
                { cc: 84, label: "Macro 5" },
                { cc: 85, label: "Macro 6" },
                { cc: 86, label: "Macro 7" },
                { cc: 87, label: "Macro 8" },
            ],
        },
        {
            name: "Synth 2",
            type: "synth",
            midiChannel: 1, // Ch 2
            color: "#06b6d4", // Cyan
            macroKnobs: [
                { cc: 80, label: "Macro 1" },
                { cc: 81, label: "Macro 2" },
                { cc: 82, label: "Macro 3" },
                { cc: 83, label: "Macro 4" },
                { cc: 84, label: "Macro 5" },
                { cc: 85, label: "Macro 6" },
                { cc: 86, label: "Macro 7" },
                { cc: 87, label: "Macro 8" },
            ],
        },
        {
            name: "Drum 1",
            type: "drum",
            midiChannel: 9, // Ch 10
            color: "#f97316", // Orange
            noteRange: { low: 60, high: 67 }, // 8 pads
        },
        {
            name: "Drum 2",
            type: "drum",
            midiChannel: 9,
            color: "#eab308", // Yellow
            noteRange: { low: 68, high: 75 },
        },
        {
            name: "Drum 3",
            type: "drum",
            midiChannel: 9,
            color: "#22c55e", // Green
            noteRange: { low: 76, high: 83 },
        },
        {
            name: "Drum 4",
            type: "drum",
            midiChannel: 9,
            color: "#ef4444", // Red
            noteRange: { low: 84, high: 91 },
        },
        {
            name: "MIDI 1",
            type: "midi",
            midiChannel: 2, // Ch 3
            color: "#3b82f6", // Blue
        },
        {
            name: "MIDI 2",
            type: "midi",
            midiChannel: 3, // Ch 4
            color: "#ec4899", // Pink
        },
    ],
    transport: {
        hasPlay: true,
        hasRecord: true,
        hasStop: true,
    },
    clock: {
        canSendClock: true,
        canReceiveClock: true,
        defaultSyncMode: "receive",
    },
    features: [
        "32 velocity-sensitive pads",
        "8 macro encoders per synth",
        "Master filter (LP/HP)",
        "Reverb, Delay, Sidechain FX",
        "32-step sequencer",
        "Pattern chaining",
        "microSD storage",
        "Built-in rechargeable battery",
    ],
};

/** All external device profiles */
export const EXTERNAL_DEVICE_PROFILES: ExternalDeviceProfile[] = [
    CIRCUIT_TRACKS_PROFILE,
];

/** All built-in presets */
export const BUILTIN_PRESETS: MidiPreset[] = [
    PIONEER_DDJ_FLX4_PRESET,
    PIONEER_DDJ_400_PRESET,
    PIONEER_DDJ_1000_PRESET,
];
