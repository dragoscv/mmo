import { describe, expect, it } from "vitest";
import { channelPairs, findDevice, nominalLatencyMs, recommendRouting, routingHint, type DeviceInfo } from "./routing";

const dev = (name: string, over: Partial<DeviceInfo> = {}): DeviceInfo => ({
    id: `wasapi:${name}`,
    name,
    host: "WASAPI",
    input_channels: 0,
    output_channels: 0,
    default_rate: 48000,
    is_default_input: false,
    is_default_output: false,
    voicemeeter: false,
    virtual_cable: false,
    ...over,
});

const iface = dev("Focusrite USB", { input_channels: 2, output_channels: 4, is_default_input: true });
const vmOut = dev("Voicemeeter Input", { output_channels: 8, voicemeeter: true, is_default_output: true });
const vm5 = dev("Voicemeeter In 5", { output_channels: 2, voicemeeter: true });
const vmIn = dev("Voicemeeter Out B1", { input_channels: 2, voicemeeter: true });

describe("routing", () => {
    it("with Voicemeeter: mic from the interface, voice into strip In 5", () => {
        const r = recommendRouting([vmIn, vmOut, vm5, iface]);
        expect(r.kind).toBe("voicemeeter");
        expect(r.input?.name).toBe("Focusrite USB");
        expect(r.output?.name).toBe("Voicemeeter In 5");
    });

    it("without Voicemeeter: the same interface both ways", () => {
        const r = recommendRouting([iface, dev("Speakers", { output_channels: 2, is_default_output: true })]);
        expect(r.kind).toBe("interface");
        expect(r.output?.name).toBe("Focusrite USB");
    });

    it("hints the current pick and handles empty lists", () => {
        expect(routingHint(iface, vm5)).toBe("voicemeeter");
        expect(routingHint(iface, iface)).toBe("interface");
        expect(routingHint(iface, dev("Speakers", { output_channels: 2 }))).toBe("different");
        expect(recommendRouting([]).kind).toBe("none");
    });

    it("channel pairs, latency estimate and saved-device lookup", () => {
        expect(channelPairs(4)).toEqual([[0, 1], [2, 3]]);
        expect(channelPairs(1)).toEqual([[0, 0]]);
        expect(nominalLatencyMs(128, 48000)).toBeCloseTo(8, 5);
        expect(findDevice([iface], "Focusrite USB")).toBe(iface);
        expect(findDevice([iface], "wasapi:Focusrite USB")).toBe(iface);
        expect(findDevice([iface], undefined)).toBeUndefined();
    });
});
