import { exitApp as platformExit } from "../platform";
/**
 * TV remote → logical key mapping. Arrow/Enter are standard; Back is 10009 (Tizen) / 461 (LG webOS);
 * on Tizen media keys need `tizen.tvinputdevice.registerKey` or the platform swallows them.
 */

export type TvKey =
    | "up" | "down" | "left" | "right" | "enter" | "back"
    | "play" | "pause" | "playpause" | "stop" | "rewind" | "fastforward"
    | "red" | "green" | "yellow" | "blue" | "exit"
    | "chup" | "chdown" | "info" | "other";

const CODES: Record<number, TvKey> = {
    37: "left", 38: "up", 39: "right", 40: "down", 13: "enter",
    10009: "back", 461: "back", 27: "back", 8: "back",
    415: "play", 19: "pause", 10252: "playpause", 413: "stop",
    412: "rewind", 417: "fastforward",
    403: "red", 404: "green", 405: "yellow", 406: "blue",
    10182: "exit", 427: "chup", 428: "chdown", 457: "info",
};

// Desktop fallbacks so the app is testable in a normal browser. Digits are NOT mapped here: read them with
// `digitFromEvent` (ui/PinPad) — the remote sends keyCode 48–57 once "0".."9" are registered below.
const DESKTOP: Record<string, TvKey> = {
    " ": "playpause", k: "playpause", j: "rewind", l: "fastforward", Escape: "back", Backspace: "back",
    PageUp: "chup", PageDown: "chdown", i: "info",
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
    "ChannelUp", "ChannelDown", "Info",
    "0", "1", "2", "3", "4", "5", "6", "7", "8", "9",
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
    platformExit();
}

export function isTizen(): boolean {
    return typeof tizen !== "undefined" && !!tizen;
}
