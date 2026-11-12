/**
 * Pure helpers of LAN tempo sync (no React, no bridge): state of the chip, input parsing,
 * readout texts, and a guard for whatever the shell sends as a status.
 */
// Relative + explicit extension so `node --test` can load this module without the Vite alias.
import type { LinkStatus } from "../bridge/link.ts";

/** Status of a stopped (or absent) session. */
export const LINK_OFF: LinkStatus = {
    running: false,
    locked: false,
    leader: false,
    peers: 0,
    bpm: 0,
    beat: 0,
    phase: 0,
    offsetUs: 0,
    pinSet: false,
    nudgeBeats: 0,
    hostUs: 0,
    multicast: false,
    port: 0,
    pending: 0,
    tempoLocked: false,
};

export type LinkPhase = "off" | "searching" | "locked";

/** What the chip shows: off, on but alone (or still measuring), or locked to another instance. */
export function linkPhase(s: Pick<LinkStatus, "running" | "locked">): LinkPhase {
    if (!s.running) return "off";
    return s.locked ? "locked" : "searching";
}

const num = (v: unknown, fallback = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const count = (v: unknown): number => Math.max(0, Math.round(num(v)));

/** Any payload → a well-formed status (a shell that answers something else reads as off). */
export function normalizeStatus(raw: unknown): LinkStatus {
    if (typeof raw !== "object" || raw === null) return LINK_OFF;
    const r = raw as Record<string, unknown>;
    if (r.running !== true) return LINK_OFF;
    return {
        running: true,
        locked: r.locked === true,
        leader: r.leader === true,
        peers: count(r.peers),
        bpm: num(r.bpm),
        beat: num(r.beat),
        phase: num(r.phase),
        offsetUs: num(r.offsetUs),
        pinSet: r.pinSet === true,
        nudgeBeats: num(r.nudgeBeats),
        hostUs: num(r.hostUs),
        multicast: r.multicast === true,
        port: count(r.port),
        pending: count(r.pending),
        tempoLocked: r.tempoLocked === true,
    };
}

/** Keep what a PIN field may hold: ASCII digits, four at most. */
export function cleanPin(text: string): string {
    return text.replace(/[^0-9]/g, "").slice(0, 4);
}

/** A PIN the session accepts: empty (open session) or exactly four digits. */
export function pinValid(pin: string): boolean {
    return pin === "" || /^[0-9]{4}$/.test(pin);
}

export const MIN_BPM = 20;
export const MAX_BPM = 300;

/** A typed tempo ("128", "128,5") → BPM within 20..300, else null. */
export function parseBpm(text: string): number | null {
    const t = text.trim().replace(",", ".");
    if (!/^[0-9]+(\.[0-9]*)?$/.test(t)) return null;
    const v = Number(t);
    return Number.isFinite(v) && v >= MIN_BPM && v <= MAX_BPM ? v : null;
}

/** Session tempo readout, two decimals ("128.00"); empty while there is none. */
export function bpmText(bpm: number): string {
    return Number.isFinite(bpm) && bpm > 0 ? bpm.toFixed(2) : "";
}

export type OffsetUnit = "ms" | "s";

/** Below one second the offset reads in milliseconds, from there on in seconds. */
const OFFSET_MS_LIMIT_US = 999_950;

/**
 * Unit of the clock offset readout. The two clocks count from the start of each app, so an
 * offset of minutes or hours is normal: it must stay short enough for its cell.
 */
export function offsetUnit(offsetUs: number): OffsetUnit {
    return Math.abs(offsetUs) >= OFFSET_MS_LIMIT_US ? "s" : "ms";
}

/**
 * Clock offset without its unit, typographic minus: "−3.4" (ms, one decimal), "−1.23" (s, two
 * decimals below 100 s), "7200" (whole seconds above).
 */
export function offsetValueText(offsetUs: number): string {
    if (!Number.isFinite(offsetUs)) return "";
    const abs = Math.abs(offsetUs);
    const minus = offsetUs < 0 ? "−" : "";
    if (abs < OFFSET_MS_LIMIT_US) {
        const ms = Math.round(abs / 100) / 10;
        return (ms > 0 ? minus : "") + ms.toFixed(1);
    }
    const s = abs / 1e6;
    return minus + (s < 99.995 ? s.toFixed(2) : String(Math.round(s)));
}

/** Our phase shift in beats with its sign ("+0.25", "−0.50", "0"). */
export function nudgeText(beats: number): string {
    if (!Number.isFinite(beats) || Math.abs(beats) < 0.005) return "0";
    return (beats < 0 ? "−" : "+") + Math.abs(beats).toFixed(2);
}

/** The shell has no tempo sync (a build from before the feature). */
export function isUnavailable(message: string): boolean {
    return /not available in this build|command .* not found|not allowed/i.test(message);
}

export type LinkErrorKey = "link.err.pin" | "link.err.start" | "link.err.bpm" | "link.err.tempoLocked" | "link.err.nudgeLeader" | "link.err.generic";

/**
 * Message of a rejected command → the catalogue key shown to the DJ. The texts are the ones
 * `src-tauri/src/link.rs` returns (contract.test.ts reads that file and checks each one).
 */
export function errorKey(message: string): LinkErrorKey {
    if (/pin must be/i.test(message)) return "link.err.pin";
    if (/bpm must be/i.test(message)) return "link.err.bpm";
    if (/tempo follows the playing deck/i.test(message)) return "link.err.tempoLocked";
    if (/nudge is not available/i.test(message)) return "link.err.nudgeLeader";
    if (/could not start|bind must be|port must be/i.test(message)) return "link.err.start";
    return "link.err.generic";
}

/**
 * The error to keep showing when a new status arrives: a refusal that names a state of the
 * session ("tempo follows the playing deck", "this instance leads") is dropped once that state
 * is over, and every message goes when sync stops. The other messages stay until the next command.
 */
export function liveError(error: LinkErrorKey | null, status: Pick<LinkStatus, "running" | "leader" | "tempoLocked">): LinkErrorKey | null {
    if (error === null) return null;
    if (error === "link.err.tempoLocked") return status.running && status.tempoLocked ? error : null;
    if (error === "link.err.nudgeLeader") return status.running && status.leader ? error : null;
    return error;
}
