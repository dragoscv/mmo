"use client";

/**
 * Controller driver registry.
 *
 * Drivers are tried in declaration order — the first whose `deviceNameMatch`
 * regex matches a MIDI device's name "wins". `GenericMidiDriver` is the
 * universal fallback (matches everything), so place specific drivers first.
 */

import { GenericMidiDriver, type ControllerDriver } from "../controller-driver";
import { PioneerDDJFLX4Driver } from "./ddj-flx4";
import { PioneerDDJ400Driver, PioneerDDJ1000Driver } from "./pioneer-generic";

/** Factory list — order matters (specific → generic). */
export const DRIVER_FACTORIES: Array<{ id: string; create: () => ControllerDriver }> = [
    { id: "pioneer-ddj-flx4", create: () => new PioneerDDJFLX4Driver() },
    { id: "pioneer-ddj-1000", create: () => new PioneerDDJ1000Driver() },
    { id: "pioneer-ddj-400", create: () => new PioneerDDJ400Driver() },
    { id: "generic-midi", create: () => new GenericMidiDriver() },
];

/** Registry of all driver `info` blocks (for UI listing). */
export function listDriverInfos() {
    return DRIVER_FACTORIES.map(f => f.create().info);
}

export function createDriverById(id: string): ControllerDriver | null {
    const f = DRIVER_FACTORIES.find(x => x.id === id);
    return f ? f.create() : null;
}

/**
 * Return the first driver whose `deviceNameMatch` regex matches `name`.
 * `GenericMidiDriver` (last in the list) catches everything as a fallback.
 */
export function detectDriverForDevice(name: string): ControllerDriver | null {
    for (const f of DRIVER_FACTORIES) {
        const driver = f.create();
        if (driver.info.deviceNameMatch.test(name)) return driver;
    }
    return null;
}
