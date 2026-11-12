/**
 * Typed wrappers around the LAN tempo sync commands (`link_*` in `src-tauri/src/link.rs`) and
 * the `link://state` event. Outside Tauri every call resolves to `null`; a command the running
 * shell refuses rejects with its message (the store in `link/link-store.ts` sorts those out).
 */

/** Mirror of `LinkStatus` in `src-tauri/src/link.rs` (serde camelCase). */
export interface LinkStatus {
    running: boolean;
    /** Another instance's clock offset is known: the beat is the shared one. */
    locked: boolean;
    /** This instance drives the session timeline. */
    leader: boolean;
    /** Other instances in the session. */
    peers: number;
    bpm: number;
    /** Session beat (with our nudge) at `hostUs`. */
    beat: number;
    /** `beat` modulo 4: position in the bar. */
    phase: number;
    /** Leader clock minus ours, in microseconds (0 while we lead). */
    offsetUs: number;
    pinSet: boolean;
    /** Our phase shift against the session, in beats. */
    nudgeBeats: number;
    /** Engine host time (µs) at which `beat` holds. */
    hostUs: number;
    /** The node joined the multicast group on a LAN address (false = this machine only, or no network yet). */
    multicast: boolean;
    /** UDP port the node listens on. */
    port: number;
    /** Instances heard with our PIN that are not in our session yet. */
    pending: number;
    /** The session tempo follows a playing deck of the leader (ours while we lead): a tempo cannot be proposed. */
    tempoLocked: boolean;
}

export interface LinkStartOptions {
    /** Four digits, or empty / absent for an open session. */
    pin?: string;
    /** Local IPv4 address to listen on (default: every interface; `127.0.0.1` = this machine only). */
    bind?: string;
    /** UDP port (default: the protocol port). */
    port?: number;
}

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
type UnlistenFn = () => void;

let invokeImpl: InvokeFn | null = null;

function inTauri(): boolean {
    return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function getInvoke(): Promise<InvokeFn | null> {
    if (invokeImpl) return invokeImpl;
    if (!inTauri()) return null;
    const mod = await import("@tauri-apps/api/core");
    invokeImpl = mod.invoke as InvokeFn;
    return invokeImpl;
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
    const invoke = await getInvoke();
    if (!invoke) return null;
    return invoke<T>(cmd, args);
}

export const link = {
    status: () => call<LinkStatus>("link_status"),
    start: (o: LinkStartOptions = {}) => call<LinkStatus>("link_start", { pin: o.pin ? o.pin : null, bind: o.bind ?? null, port: o.port ?? null }),
    stop: () => call<LinkStatus>("link_stop"),
    /**
     * Propose a session tempo and / or shift our own phase by `nudgeBeats`. Rejects with
     * "tempo follows the playing deck" while `tempoLocked`, and with "nudge is not available
     * while this instance leads" on the leader (nudge is a follower's control).
     */
    set: (o: { bpm?: number; nudgeBeats?: number }) => call<LinkStatus>("link_set", { bpm: o.bpm ?? null, nudgeBeats: o.nudgeBeats ?? null }),
};

/** `link://state`: 4 Hz while sync runs, once more when it stops. No-op outside Tauri. */
export async function subscribeLinkState(onState: (payload: unknown) => void): Promise<UnlistenFn> {
    if (!inTauri()) return () => {};
    const { listen } = await import("@tauri-apps/api/event");
    return listen<unknown>("link://state", (e) => onState(e.payload));
}
