"use client";

import type { DeckSide } from "./mixer-engine";
import { dlog } from "@/lib/dev-debugger";

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
    | "fx-select" | "fx-select-prev" | "fx-on-off" | "fx-level"
    | "fx-channel-1" | "fx-channel-2" | "fx-beats-up" | "fx-beats-down"
    | "fx-disable-all"
    // Quantize / Slip / Censor
    | "quantize" | "slip-mode" | "censor"
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
    deck: "A" | "B" | "C" | "D" | null;
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
    /** True for output-only devices that don't expose a real MIDI input. */
    outputOnly?: boolean;
}

export interface MidiMessage {
    status: number; // Full status byte
    channel: number; // 0-15, or -1 for system messages
    type: "noteOn" | "noteOff" | "cc" | "programChange" | "start" | "stop" | "continue" | "clock";
    note: number; // note or CC number (or program number for PC)
    value: number; // velocity or CC value (0 for PC/system)
    raw: Uint8Array;
    /** ID of the input port that produced this message. Set by the engine,
     *  not by the parser — used to filter messages coming from external
     *  devices (grooveboxes, synths) so they don't accidentally trigger
     *  controller-preset deck actions, and so per-device panels can
     *  reject messages from unrelated controllers. */
    sourceId?: string;
}

// ─── MIDI Message Parser ─────────────────────────────────────────────────

export function parseMidiMessage(data: Uint8Array): MidiMessage | null {
    if (data.length < 1) return null;

    const status = data[0];

    // System real-time messages (single byte, no channel)
    if (status === 0xFA) return { status, channel: -1, type: "start", note: 0, value: 0, raw: data };
    if (status === 0xFC) return { status, channel: -1, type: "stop", note: 0, value: 0, raw: data };
    if (status === 0xFB) return { status, channel: -1, type: "continue", note: 0, value: 0, raw: data };
    if (status === 0xF8) return { status, channel: -1, type: "clock", note: 0, value: 0, raw: data };

    if (data.length < 2) return null;

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
        case 0xc0: // Program Change
            return {
                status, channel, type: "programChange",
                note, value: 0, raw: data,
            };
        default:
            return null;
    }
}

// ─── MIDI Engine ─────────────────────────────────────────────────────────

export type MidiActionHandler = (action: MidiAction, deck: DeckSide | null, value: number, isPress: boolean) => void;

export class MidiEngine {
    private midiAccess: MIDIAccess | null = null;
    private devices: Map<string, MidiDevice> = new Map();
    private activeMapping: MidiPreset | null = null;
    private mappingLookup: Map<string, MidiMapping> = new Map();
    private handler: MidiActionHandler | null = null;
    private learnCallback: ((msg: MidiMessage) => void) | null = null;

    // 14-bit CC accumulator
    private cc14BitAccum: Map<string, number> = new Map();

    // Diagnostic: throttle unmapped-message logs to one per unique key.
    private unmappedSeen: Set<string> = new Set();

    /** Input-port IDs whose MIDI messages must NOT be routed through the
     *  active controller preset (e.g. Circuit Tracks, other grooveboxes
     *  / synths). Their messages are still parsed and forwarded to
     *  `onMessage` listeners and to MIDI Learn — only the
     *  preset-driven `routeMessage` step is skipped. */
    private externalInputIds: Set<string> = new Set();

    onDeviceChange?: (devices: MidiDevice[]) => void;
    onMessage?: (msg: MidiMessage) => void;

    async init(): Promise<boolean> {
        if (!navigator.requestMIDIAccess) {
            console.warn("[MIDI] Web MIDI API not supported in this browser");
            dlog("midi", "Web MIDI API not supported", undefined, "warn");
            return false;
        }

        try {
            // Check MIDI permission status first
            try {
                const permStatus = await navigator.permissions.query({ name: "midi" as PermissionName });
                console.log("[MIDI] Permission status:", permStatus.state);
            } catch (permErr) {
                console.log("[MIDI] Could not query permission:", permErr);
            }

            // Try sysex=true first — needed to receive System Real-Time messages
            // (Start 0xFA, Stop 0xFC, Clock 0xF8, Continue 0xFB)
            // Fall back to sysex=false if user denies the permission
            try {
                console.log("[MIDI] Requesting MIDIAccess (sysex=true)...");
                this.midiAccess = await navigator.requestMIDIAccess({ sysex: true });
                console.log("[MIDI] Got MIDIAccess (sysex=true), inputs:", this.midiAccess.inputs.size, "outputs:", this.midiAccess.outputs.size);
            } catch (err) {
                console.warn("[MIDI] sysex=true failed, trying sysex=false:", err);
                try {
                    this.midiAccess = await navigator.requestMIDIAccess({ sysex: false });
                    console.log("[MIDI] Got MIDIAccess (sysex=false), inputs:", this.midiAccess.inputs.size, "outputs:", this.midiAccess.outputs.size);
                } catch (err2) {
                    console.warn("[MIDI] sysex=false also failed:", err2);
                    return false;
                }
            }

            console.log("[MIDI] MIDIAccess inputs:", this.midiAccess.inputs.size, "outputs:", this.midiAccess.outputs.size);

            // Log ALL raw ports regardless of state
            this.midiAccess.inputs.forEach((input, key) => {
                console.log(`[MIDI] Raw Input: key=${key} id="${input.id}" name="${input.name}" manufacturer="${input.manufacturer}" state=${input.state} connection=${input.connection}`);
            });
            this.midiAccess.outputs.forEach((output, key) => {
                console.log(`[MIDI] Raw Output: key=${key} id="${output.id}" name="${output.name}" manufacturer="${output.manufacturer}" state=${output.state} connection=${output.connection}`);
            });

            // Listen for device changes
            this.midiAccess.onstatechange = (e) => {
                const port = (e as MIDIConnectionEvent).port;
                console.log(`[MIDI] statechange: ${port?.type} "${port?.name}" state=${port?.state} conn=${port?.connection}`);
                this.refreshDevices();
                // Delayed re-scans for Windows — port may not be fully ready yet
                setTimeout(() => this.refreshDevices(), 300);
                setTimeout(() => this.refreshDevices(), 1000);
            };

            await this.refreshDevices();

            // On Windows, devices may appear slightly after init completes
            // Schedule additional re-scans
            if (this.devices.size === 0) {
                console.log("[MIDI] No devices found, scheduling delayed re-scans...");
                setTimeout(() => this.refreshDevices(), 1000);
                setTimeout(() => this.refreshDevices(), 3000);
            }

            return true;
        } catch (err) {
            console.error("[MIDI] Failed to access MIDI devices:", err);
            return false;
        }
    }

    private async refreshDevices() {
        if (!this.midiAccess) return;

        const newDevices = new Map<string, MidiDevice>();
        const inputs = this.midiAccess.inputs;
        const outputs = this.midiAccess.outputs;

        console.log(`[MIDI] refreshDevices: ${inputs.size} inputs, ${outputs.size} outputs`);

        // Build output lookups. Windows tends to mangle port names —
        //   input  "MIDIIN2 (DDJ-FLX4)"  ↔  output "MIDIOUT2 (DDJ-FLX4)"
        //   input  "DDJ-FLX4"            ↔  output "Out DDJ-FLX4 1"
        // …so we extract a "canonical core" token (anything inside the
        // first parenthesis, falling back to the whole name with the
        // MIDI direction prefix stripped) and index outputs by that.
        const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
        const canonicalCore = (raw: string): string => {
            if (!raw) return "";
            const paren = raw.match(/\(([^)]+)\)/);
            const core = paren ? paren[1] : raw
                .replace(/^\s*(midiin|midi in|in|midiout|midi out|out)\s*\d*[\s:_-]*/i, "")
                .replace(/[\s:_-]*\d+\s*$/, "");
            return norm(core);
        };

        const outputsByName = new Map<string, MIDIOutput>();
        const outputsByNormName = new Map<string, MIDIOutput>();
        const outputsByCore = new Map<string, MIDIOutput[]>();
        const outputsByManufacturer = new Map<string, MIDIOutput[]>();
        outputs.forEach((output) => {
            console.log(`[MIDI] Output port: "${output.name}" manufacturer="${output.manufacturer}" state=${output.state}`);
            if (output.name) {
                outputsByName.set(output.name, output);
                const k = norm(output.name);
                if (k && !outputsByNormName.has(k)) outputsByNormName.set(k, output);
                const core = canonicalCore(output.name);
                if (core) {
                    const arr = outputsByCore.get(core) ?? [];
                    arr.push(output);
                    outputsByCore.set(core, arr);
                }
            }
            if (output.manufacturer) {
                const m = norm(output.manufacturer);
                const arr = outputsByManufacturer.get(m) ?? [];
                arr.push(output);
                outputsByManufacturer.set(m, arr);
            }
        });

        // Open ALL inputs (not just state=connected — some devices report "disconnected" until opened)
        const openPromises: Promise<void>[] = [];
        const usedOutputs = new Set<MIDIOutput>();
        inputs.forEach((input) => {
            console.log(`[MIDI] Attempting to open input: "${input.name}" manufacturer="${input.manufacturer}" state=${input.state} connection=${input.connection}`);

            openPromises.push(
                input.open().then(async () => {
                    console.log(`[MIDI] Opened input: "${input.name}" state=${input.state} connection=${input.connection}`);
                    let matchingOutput: MIDIOutput | null = null;
                    let matchReason = "";
                    if (input.name) {
                        // 1. Exact name match (rare but cheap to check)
                        matchingOutput = outputsByName.get(input.name) ?? null;
                        if (matchingOutput) matchReason = "exact-name";

                        // 2. Canonical core match (handles MIDIIN2 (X) ↔ MIDIOUT2 (X))
                        if (!matchingOutput) {
                            const core = canonicalCore(input.name);
                            const candidates = (outputsByCore.get(core) ?? []).filter(o => !usedOutputs.has(o));
                            if (candidates.length > 0) {
                                matchingOutput = candidates[0];
                                matchReason = `canonical-core "${core}"`;
                            }
                        }

                        // 3. Normalised-name fallback (full-string)
                        if (!matchingOutput) {
                            const k = norm(input.name);
                            matchingOutput = outputsByNormName.get(k) ?? null;
                            if (matchingOutput) matchReason = "norm-name";
                        }

                        // 4. Substring match (either way)
                        if (!matchingOutput) {
                            const k = norm(input.name);
                            if (k) {
                                for (const [outKey, out] of outputsByNormName) {
                                    if (usedOutputs.has(out)) continue;
                                    if (outKey.includes(k) || k.includes(outKey)) {
                                        matchingOutput = out;
                                        matchReason = "substring";
                                        break;
                                    }
                                }
                            }
                        }
                    }

                    // 5. Manufacturer fallback — pair with the only un-used
                    //    output from the same manufacturer.
                    if (!matchingOutput && input.manufacturer) {
                        const m = norm(input.manufacturer);
                        const candidates = (outputsByManufacturer.get(m) ?? []).filter(o => !usedOutputs.has(o));
                        if (candidates.length === 1) {
                            matchingOutput = candidates[0];
                            matchReason = `manufacturer "${input.manufacturer}"`;
                        }
                    }

                    // 6. Last-ditch: if there's exactly one input AND exactly
                    //    one output total, they almost certainly belong to
                    //    the same device.
                    if (!matchingOutput && inputs.size === 1 && outputs.size === 1) {
                        outputs.forEach(o => { matchingOutput = o; });
                        if (matchingOutput) matchReason = "single-input-single-output";
                    }

                    if (matchingOutput) {
                        usedOutputs.add(matchingOutput);
                        console.log(`[MIDI] Paired output for "${input.name}" → "${matchingOutput.name}" (via ${matchReason})`);
                        // Explicitly open the output. The Web MIDI spec auto-
                        // opens on first send(), but on Windows some drivers
                        // refuse the implicit open — safer to await it now.
                        try { await matchingOutput.open(); } catch (err) {
                            console.warn(`[MIDI] Failed to open output "${matchingOutput.name}"`, err);
                        }
                    } else {
                        console.warn(`[MIDI] No matching output found for input "${input.name}" — LEDs / motorised feedback disabled. ` +
                            `Available outputs: ${Array.from(outputs.values()).map(o => `"${o.name}"`).join(", ") || "(none)"}`);
                    }

                    const device: MidiDevice = {
                        id: input.id,
                        name: input.name || "Unknown MIDI Device",
                        manufacturer: input.manufacturer || "",
                        input,
                        output: matchingOutput,
                    };

                    newDevices.set(input.id, device);

                    // Attach message handler
                    const sourceId = input.id;
                    input.onmidimessage = (e: MIDIMessageEvent) => {
                        if (!e.data) return;
                        const msg = parseMidiMessage(new Uint8Array(e.data));
                        if (!msg) return;
                        msg.sourceId = sourceId;

                        // One-time "first message from this port" log so we
                        // can prove the device is actually emitting MIDI.
                        if (process.env.NODE_ENV !== "production") {
                            const seen = (this as unknown as { _firstSeen?: Set<string> })._firstSeen ?? new Set<string>();
                            (this as unknown as { _firstSeen?: Set<string> })._firstSeen = seen;
                            if (!seen.has(sourceId)) {
                                seen.add(sourceId);
                                // eslint-disable-next-line no-console
                                console.info(`[MIDI] First message from "${input.name}": status=0x${msg.status.toString(16)} data1=0x${msg.note.toString(16)} value=${msg.value} type=${msg.type}`);
                            }
                        }

                        this.onMessage?.(msg);

                        if (this.learnCallback) {
                            this.learnCallback(msg);
                            return;
                        }

                        // Skip preset-driven action routing for inputs that
                        // belong to recognised external devices (Circuit
                        // Tracks etc.). Otherwise their notes would collide
                        // with the active controller preset (e.g. CT Synth 1
                        // note C#5 would trigger Deck A reloop on the
                        // Pioneer DDJ-FLX4 mapping).
                        if (this.externalInputIds.has(sourceId)) return;

                        this.routeMessage(msg);
                    };
                }).catch((openErr) => {
                    console.warn(`[MIDI] Failed to open input: "${input.name}"`, openErr);
                    // Still add it so user can see it exists even if it can't open
                    newDevices.set(input.id, {
                        id: input.id,
                        name: `${input.name || "Unknown"} (failed to open)`,
                        manufacturer: input.manufacturer || "",
                        input,
                        output: null,
                    });
                })
            );
        });

        await Promise.allSettled(openPromises);

        // Expose any output port that wasn't paired with an input as a
        // standalone, output-only "device" so the UI can list it (and
        // controller drivers can still target it).
        outputs.forEach((output) => {
            if (usedOutputs.has(output)) return;
            const id = `out:${output.id}`;
            console.log(`[MIDI] Output without matching input: "${output.name}" → exposing as standalone device`);
            try { void output.open(); } catch { /* ignore */ }
            newDevices.set(id, {
                id,
                name: output.name || "Unknown MIDI Output",
                manufacturer: output.manufacturer || "",
                // Output-only stub: re-use the output here so the type holds.
                // We never call any input-only methods on `outputOnly` devices.
                input: output as unknown as MIDIInput,
                output,
                outputOnly: true,
            });
        });

        console.log(`[MIDI] refreshDevices complete: ${newDevices.size} devices`);
        newDevices.forEach((d) => {
            console.log(`[MIDI] Device: "${d.name}" manufacturer="${d.manufacturer}" hasOutput=${!!d.output}`);
        });

        this.devices = newDevices;
        this.onDeviceChange?.(this.getDevices());
    }

    getDevices(): MidiDevice[] {
        return Array.from(this.devices.values());
    }

    /** Get raw diagnostic info about MIDI access state */
    getDiagnostics(): string[] {
        const lines: string[] = [];
        if (!this.midiAccess) {
            lines.push("MIDIAccess: null (not initialized)");
            return lines;
        }
        lines.push(`MIDIAccess: OK, sysexEnabled=${this.midiAccess.sysexEnabled}`);
        lines.push(`Raw inputs: ${this.midiAccess.inputs.size}`);
        this.midiAccess.inputs.forEach((input, key) => {
            lines.push(`  IN  [${key}] "${input.name}" mfr="${input.manufacturer}" state=${input.state} conn=${input.connection}`);
        });
        lines.push(`Raw outputs: ${this.midiAccess.outputs.size}`);
        this.midiAccess.outputs.forEach((output, key) => {
            lines.push(`  OUT [${key}] "${output.name}" mfr="${output.manufacturer}" state=${output.state} conn=${output.connection}`);
        });
        lines.push(`Devices map: ${this.devices.size}`);
        this.devices.forEach((d) => {
            lines.push(`  DEV "${d.name}" mfr="${d.manufacturer}" hasOut=${!!d.output}`);
        });
        return lines;
    }

    setMapping(preset: MidiPreset) {
        this.activeMapping = preset;
        this.mappingLookup.clear();
        this.cc14BitAccum.clear();
        this.unmappedSeen.clear();

        for (const m of preset.mappings) {
            const key = `${m.status}:${m.midino}`;
            this.mappingLookup.set(key, m);
        }

        if (process.env.NODE_ENV !== "production") {
            // eslint-disable-next-line no-console
            console.info(`[MIDI] Active preset → "${preset.name}" (${preset.mappings.length} mappings, ${this.mappingLookup.size} unique status:note keys)`);
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
        let mapping = this.mappingLookup.get(key);

        // Fallback: some controllers send real Note Off (0x8x) for button
        // releases instead of "Note On with velocity 0". Our presets only
        // store the Note On variant (0x9x), so retry with the matching
        // Note On status byte before giving up.
        if (!mapping && msg.type === "noteOff" && (msg.status & 0xF0) === 0x80) {
            const noteOnStatus = 0x90 | (msg.status & 0x0F);
            mapping = this.mappingLookup.get(`${noteOnStatus}:${msg.note}`);
        }

        if (!mapping) {
            if (process.env.NODE_ENV !== "production") {
                // Surface unmapped messages so users can diagnose missing
                // preset entries. Throttled to one log per unique key.
                if (!this.unmappedSeen.has(key)) {
                    this.unmappedSeen.add(key);
                    // eslint-disable-next-line no-console
                    console.debug(`[MIDI] unmapped ${msg.type} status=0x${msg.status.toString(16)} data1=0x${msg.note.toString(16)} value=${msg.value}`);
                }
            }
            return;
        }

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
        if (!device?.output) return;
        try {
            device.output.send(new Uint8Array(data));
        } catch (err) {
            // SysEx (0xF0) rejected when sysexEnabled=false is the most
            // common cause. Log once per device so the user can see why
            // their controller isn't lighting up / responding.
            const isSysex = data[0] === 0xF0;
            const sysexOk = this.midiAccess?.sysexEnabled ?? false;
            const seen = (this as unknown as { _sendErrSeen?: Set<string> })._sendErrSeen ?? new Set<string>();
            (this as unknown as { _sendErrSeen?: Set<string> })._sendErrSeen = seen;
            const key = `${deviceId}:${isSysex ? "sysex" : "midi"}`;
            if (!seen.has(key)) {
                seen.add(key);
                // eslint-disable-next-line no-console
                console.warn(`[MIDI] send to "${device.name}" failed (sysex=${isSysex}, sysexEnabled=${sysexOk}):`, err);
                if (isSysex && !sysexOk) {
                    // eslint-disable-next-line no-console
                    console.warn(`[MIDI] ⚠  This controller ("${device.name}") needs SysEx to wake up. Re-grant SysEx permission for this site.`);
                }
            }
        }
    }

    /** Send LED feedback to all connected output devices */
    sendToAllDevices(data: number[]) {
        this.devices.forEach((device) => {
            if (!device.output) return;
            try {
                device.output.send(new Uint8Array(data));
            } catch {
                // Per-device error already logged via sendToDevice path.
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

    /** Mark a set of input-port IDs as belonging to external devices
     *  (Circuit Tracks, other grooveboxes / synths). Messages from these
     *  ports are still parsed and forwarded to `onMessage` listeners but
     *  bypass the active controller preset's action routing. */
    setExternalInputIds(ids: Iterable<string>) {
        this.externalInputIds = new Set(ids);
    }

    /** Whether a given input-port ID is currently flagged as external. */
    isExternalInput(id: string): boolean {
        return this.externalInputIds.has(id);
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

    /** Send a Program Change message to a specific device */
    sendProgramChange(deviceId: string, channel: number, program: number) {
        const status = 0xC0 | (channel & 0x0F);
        this.sendToDevice(deviceId, [status, Math.round(Math.max(0, Math.min(127, program)))]);
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
            if (!d.outputOnly) {
                d.input.onmidimessage = null;
                try { d.input.close(); } catch { /* ignore */ }
            }
            try { d.output?.close(); } catch { /* ignore */ }
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
        { status: 0x94, midino: 0x64, action: "fx-select-prev", deck: null, type: "note", description: "FX Select (Shift = previous)" },
        { status: 0x94, midino: 0x47, action: "fx-on-off", deck: null, type: "note", description: "FX On/Off" },
        { status: 0x95, midino: 0x47, action: "fx-on-off", deck: null, type: "note", description: "FX On/Off (CH2 mode)" },
        { status: 0x94, midino: 0x43, action: "fx-disable-all", deck: null, type: "note", description: "FX Disable All (Shift)" },
        { status: 0xB4, midino: 0x02, action: "fx-level", deck: null, type: "cc", description: "FX Level/Depth" },
        // Beat FX channel routing (which deck the FX bus targets)
        { status: 0x94, midino: 0x10, action: "fx-channel-1", deck: null, type: "note", description: "FX Channel: Deck A" },
        { status: 0x95, midino: 0x11, action: "fx-channel-2", deck: null, type: "note", description: "FX Channel: Deck B" },
        // Beat FX < / > (cycle FX unit / beats)
        { status: 0x94, midino: 0x4A, action: "fx-beats-down", deck: null, type: "note", description: "FX Beats / Prev Unit" },
        { status: 0x94, midino: 0x4B, action: "fx-beats-up", deck: null, type: "note", description: "FX Beats / Next Unit" },

        // ── Quantize toggle (Shift + Cue, per deck) ─────────────
        { status: 0x90, midino: 0x68, action: "quantize", deck: "A", type: "note", description: "Toggle Quantize" },
        { status: 0x91, midino: 0x68, action: "quantize", deck: "B", type: "note", description: "Toggle Quantize" },

        // ── Censor / Reverse Roll (Shift + Play) ────────────────
        { status: 0x90, midino: 0x0E, action: "censor", deck: "A", type: "note", description: "Reverse Roll (Censor)" },
        { status: 0x91, midino: 0x0E, action: "censor", deck: "B", type: "note", description: "Reverse Roll (Censor)" },

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
            noteRange: { low: 60, high: 60 }, // CT sends note 60 for Drum 1
        },
        {
            name: "Drum 2",
            type: "drum",
            midiChannel: 9,
            color: "#eab308", // Yellow
            noteRange: { low: 62, high: 62 }, // CT sends note 62 for Drum 2
        },
        {
            name: "Drum 3",
            type: "drum",
            midiChannel: 9,
            color: "#22c55e", // Green
            noteRange: { low: 64, high: 64 }, // CT sends note 64 for Drum 3
        },
        {
            name: "Drum 4",
            type: "drum",
            midiChannel: 9,
            color: "#ef4444", // Red
            noteRange: { low: 65, high: 65 }, // CT sends note 65 for Drum 4
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
