/**
 * Hidden vidsrc embed flag.
 *
 * The web app NEVER decides whether vidsrc is enabled — only the
 * companion does, and only when explicitly toggled here (or via the
 * settings file). Default OFF. The web UI surfaces vidsrc embed slots
 * only after the companion reports `enabled: true` via /video/flags.
 */

import { store } from "../store";

const KEY = "video.externalEmbed.vidsrc.enabled";

export function isVidsrcEnabled(): boolean {
    return Boolean(store.get(KEY) as boolean | undefined);
}

export function setVidsrcEnabled(v: boolean): void {
    store.set(KEY, v);
}
