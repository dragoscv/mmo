"use client";

/**
 * Generic Pioneer DDJ driver.
 *
 * Used as a fallback for DDJ-400 / DDJ-1000 / other Pioneer DDJ models that
 * follow the same MIDI note layout as the FLX4 (channel 0/1 transport,
 * channel 7/9 hot-cue pads). Capabilities are conservative — derived
 * drivers should override `info` for richer feature flags.
 */

import { PioneerDDJFLX4Driver } from "./ddj-flx4";
import type { ControllerDriverInfo } from "../controller-driver";

export class PioneerDDJ400Driver extends PioneerDDJFLX4Driver {
    override readonly info: ControllerDriverInfo = {
        id: "pioneer-ddj-400",
        name: "Pioneer DDJ-400",
        vendor: "Pioneer DJ",
        deviceNameMatch: /DDJ[\s\-_.]?400/i,
        capabilities: {
            rgbHotCues: false,
            rgbPadModes: false,
            screen: false,
            jogDisplay: false,
            motorisedJog: false,
            vuMeters: true,
        },
        description: "Two-deck Pioneer entry-level controller. Same MIDI layout as the FLX4 — full LED feedback for transport, pad modes and hot-cue pads.",
    };
}

export class PioneerDDJ1000Driver extends PioneerDDJFLX4Driver {
    override readonly info: ControllerDriverInfo = {
        id: "pioneer-ddj-1000",
        name: "Pioneer DDJ-1000",
        vendor: "Pioneer DJ",
        deviceNameMatch: /DDJ[\s\-_.]?1000/i,
        capabilities: {
            rgbHotCues: true,
            rgbPadModes: true,
            screen: true,
            jogDisplay: true,
            motorisedJog: false,
            vuMeters: true,
        },
        description: "Four-deck flagship Pioneer controller with RGB pads and jog displays. Currently using the FLX4 layout — RGB and screen support to follow.",
    };
}
