/**
 * Watch Together display name for this TV (shown to other room members / used for the room name).
 * Stored in the shared prefs blob as `tvDeviceName`; empty = the hub's hardware name ("Samsung <model>").
 * The hub `hello.name` itself comes from `lib/hub.ts hubDeviceName()` (foundation) — see the reply's
 * shared-change request for wiring this override into `hello`.
 */
import { hubDeviceName } from "../../lib/hub";
import { readPrefs, writePrefs } from "../../lib/prefs";

export const DEVICE_NAME_KEY = "tvDeviceName";

export function readDeviceName(): string {
    const v = readPrefs()[DEVICE_NAME_KEY];
    return typeof v === "string" && v.trim() ? v.trim() : hubDeviceName();
}

export function customDeviceName(): string {
    const v = readPrefs()[DEVICE_NAME_KEY];
    return typeof v === "string" ? v : "";
}

export function writeDeviceName(name: string): void {
    writePrefs({ [DEVICE_NAME_KEY]: name.trim().slice(0, 40) });
}
