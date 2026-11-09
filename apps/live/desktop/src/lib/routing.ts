/** Audio setup helpers: device lists from `mixai-live-engine devices`, routing hints, nominal latency. */

export interface DeviceInfo {
    id: string;
    name: string;
    host: string;
    input_channels: number;
    output_channels: number;
    default_rate: number;
    is_default_input: boolean;
    is_default_output: boolean;
    voicemeeter: boolean;
    virtual_cable: boolean;
}

export interface DevicesResponse {
    hosts: string[];
    devices: DeviceInfo[];
}

export const BUFFERS = [64, 96, 128, 256] as const;
export const RATES = [44_100, 48_000, 96_000] as const;

/**
 * Engine estimate: input ring pre-fills 2 buffers + half the stereo target (1 buffer) before output,
 * same formula as `live_engine::io` (`(buf * 2 + buf * 2 / 2) / rate`).
 */
export function nominalLatencyMs(buffer: number, rate: number): number {
    if (rate <= 0) return 0;
    return ((buffer * 2 + (buffer * 2) / 2) / rate) * 1000;
}

export const inputs = (d: DeviceInfo[]) => d.filter((x) => x.input_channels > 0);
export const outputs = (d: DeviceInfo[]) => d.filter((x) => x.output_channels > 0);

/** Stereo pairs [[0,1],[2,3],…] for a device with `n` channels (mono devices get [[0,0]]). */
export function channelPairs(n: number): [number, number][] {
    if (n <= 0) return [];
    if (n === 1) return [[0, 0]];
    const out: [number, number][] = [];
    for (let i = 0; i + 1 < n; i += 2) out.push([i, i + 1]);
    return out;
}

export type RoutingKind = "voicemeeter" | "interface" | "different" | "none";

export interface Routing {
    kind: RoutingKind;
    input?: DeviceInfo;
    output?: DeviceInfo;
}

const isVirtual = (d: DeviceInfo) => d.voicemeeter || d.virtual_cable;

/** The Voicemeeter strip a processed voice should go to: a hardware-less virtual input ("In 5"/AUX first). */
function voicemeeterTarget(outs: DeviceInfo[]): DeviceInfo | undefined {
    const vm = outs.filter((d) => d.voicemeeter);
    return (
        vm.find((d) => /\bin\s*5\b/i.test(d.name)) ??
        vm.find((d) => /aux/i.test(d.name)) ??
        vm.find((d) => /vaio3|in\s*\d/i.test(d.name)) ??
        vm[0]
    );
}

/** Real interface for the mic: the default input when it is not virtual, else the first physical input. */
function physicalInput(ins: DeviceInfo[]): DeviceInfo | undefined {
    return ins.find((d) => d.is_default_input && !isVirtual(d)) ?? ins.find((d) => !isVirtual(d));
}

/**
 * Recommended routing:
 * - Voicemeeter installed → mic straight from the interface (low latency), voice into a Voicemeeter strip.
 * - Otherwise → the same physical interface for input and output (no clock drift).
 */
export function recommendRouting(devices: DeviceInfo[]): Routing {
    const ins = inputs(devices);
    const outs = outputs(devices);
    const input = physicalInput(ins);
    if (!input) return { kind: "none" };
    const vm = voicemeeterTarget(outs);
    if (vm) return { kind: "voicemeeter", input, output: vm };
    const same = outs.find((d) => d.name === input.name && !isVirtual(d));
    if (same) return { kind: "interface", input, output: same };
    const fallback = outs.find((d) => d.is_default_output && !isVirtual(d)) ?? outs.find((d) => !isVirtual(d));
    return fallback ? { kind: "different", input, output: fallback } : { kind: "none" };
}

/** Hint for the CURRENT pick (shown under the selects). */
export function routingHint(input: DeviceInfo | undefined, output: DeviceInfo | undefined): RoutingKind {
    if (!input || !output) return "none";
    if (output.voicemeeter && !isVirtual(input)) return "voicemeeter";
    if (input.name === output.name) return "interface";
    return "different";
}

export const hasVoicemeeter = (d: DeviceInfo[]) => d.some((x) => x.voicemeeter);

/** Find a device by the identifier saved in settings (id first, then name). */
export function findDevice(list: DeviceInfo[], key: string | undefined): DeviceInfo | undefined {
    if (!key) return undefined;
    return list.find((d) => d.id === key) ?? list.find((d) => d.name === key);
}
