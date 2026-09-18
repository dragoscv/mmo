/**
 * Tizen remote → logical key mapping. Arrow/Enter are standard; Back is 10009,
 * media keys need `tizen.tvinputdevice.registerKey` or the platform swallows them.
 */

export type TvKey =
    | "up" | "down" | "left" | "right" | "enter" | "back"
    | "play" | "pause" | "playpause" | "stop" | "rewind" | "fastforward"
    | "red" | "green" | "yellow" | "blue" | "exit" | "other";

const CODES: Record<number, TvKey> = {
    37: "left", 38: "up", 39: "right", 40: "down", 13: "enter",
    10009: "back", 27: "back", 8: "back",
    415: "play", 19: "pause", 10252: "playpause", 413: "stop",
    412: "rewind", 417: "fastforward",
    403: "red", 404: "green", 405: "yellow", 406: "blue",
    10182: "exit",
};

// Desktop fallbacks so the app is testable in a normal browser.
const DESKTOP: Record<string, TvKey> = {
    " ": "playpause", k: "playpause", j: "rewind", l: "fastforward", Escape: "back", Backspace: "back",
};

export function keyFromEvent(e: KeyboardEvent): TvKey {
    const byCode = CODES[e.keyCode];
    if (byCode) return byCode;
    const byKey = DESKTOP[e.key];
    return byKey ?? "other";
}

const REGISTER = [
    "MediaPlayPause", "MediaPlay", "MediaPause", "MediaStop", "MediaRewind", "MediaFastForward",
    "ColorF0Red", "ColorF1Green", "ColorF2Yellow", "ColorF3Blue",
];

/** Registers the media/colour keys; a no-op outside Tizen. */
export function registerTvKeys(): void {
    const dev = typeof tizen !== "undefined" ? tizen?.tvinputdevice : undefined;
    if (!dev) return;
    for (const name of REGISTER) {
        try { dev.registerKey(name); } catch { /* key not supported on this model */ }
    }
}

export function exitApp(): void {
    try {
        if (typeof tizen !== "undefined" && tizen?.application) {
            tizen.application.getCurrentApplication().exit();
            return;
        }
    } catch { /* fallthrough */ }
    window.close();
}

export function isTizen(): boolean {
    return typeof tizen !== "undefined" && !!tizen;
}
