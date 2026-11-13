/**
 * Typed wrappers around the connected-mode commands of the Rust shell (`src-tauri/src/remote.rs`,
 * WP19-42) and its two events. Same conventions as ./engine.ts and ./events.ts: outside Tauri
 * every call resolves to `null` and the listeners are no-ops; a command the shell refuses
 * rejects with its message (a string).
 */
import type { DeckId } from "./types";

export type RemoteRole = "controller" | "viewer" | "guest";
export const REMOTE_ROLES: readonly RemoteRole[] = ["controller", "viewer", "guest"];

/** Pairing data of one role. `qrSvg` is the QR code of `url` (see remote/remote-core `parseQrSvg`). */
export interface RemotePairing {
    role: RemoteRole;
    url: string;
    qrSvg: string;
}

/** A connected device. */
export interface RemoteClient {
    id: string;
    role: RemoteRole;
    /** `ip:port` of the device. */
    addr: string;
    /** A stream overlay (`/now` in OBS), not a phone; `role` is `viewer` then. Absent in shells before the overlay. */
    overlay?: boolean;
}

/** The track the stream overlay shows. */
export interface RemoteOnAir {
    title: string | null;
    artist: string | null;
}

export interface RemoteStatus {
    running: boolean;
    port: number | null;
    /** Address in the pairing URLs (this computer on the LAN). */
    host: string | null;
    urlController: string | null;
    urlViewer: string | null;
    urlGuest: string | null;
    /** Controller, viewer, guest; empty while off. */
    pairings: RemotePairing[];
    clients: RemoteClient[];
    partyOpen: boolean;
    requestsPending: number;
    /** The DJ locked the phone controls (kept while off). Absent in shells before this field. */
    controlsLocked?: boolean;
    /** Stream overlay address for OBS on this computer (loopback). Absent in shells before the overlay. */
    urlOverlay?: string | null;
    /** Stream overlay address for a second computer on the LAN; null when the server listens on loopback only. */
    urlOverlayLan?: string | null;
    /** Code of the stream overlay: kept by the UI and sent at the next start. */
    overlayToken?: string | null;
    /** The port asked for was taken: the server runs on another one. Absent = a shell before the overlay. */
    portFallback?: boolean;
    /** The track the stream overlay shows right now. */
    onAir?: RemoteOnAir | null;
}

export type RequestStatus = "pending" | "accepted" | "rejected" | "played";
/** What the DJ can decide (`pending` is where a request starts). */
export type RequestDecision = Exclude<RequestStatus, "pending">;

/** A song request as the DJ sees it. */
export interface SongRequest {
    id: number;
    title: string;
    artist: string;
    note: string;
    votes: number;
    status: RequestStatus;
    /** Client ids that asked for it (first = author). */
    clients: string[];
    /** Order of arrival. */
    seq: number;
}

/** Payload of `remote://state` (at most twice a second, only when something changed). */
export interface RemoteEvent {
    running: boolean;
    partyOpen: boolean;
    controlsLocked?: boolean;
    clients: RemoteClient[];
    requests: SongRequest[];
    onAir?: RemoteOnAir | null;
}

/** Payload of `remote://cue`: a phone moved the cue point of a deck. */
export interface RemoteCueEvent {
    deck: DeckId;
    sec: number;
}

/** Title, artist and cue point of the track on a deck (`remote.set`). */
export interface RemoteLabel {
    deck: DeckId;
    trackId: string | null;
    title: string | null;
    artist: string | null;
    cueSec: number;
}

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

let invokeImpl: InvokeFn | null = null;

function inTauri(): boolean {
    return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function getInvoke(): Promise<InvokeFn | null> {
    if (invokeImpl) return invokeImpl;
    if (inTauri()) {
        const mod = await import("@tauri-apps/api/core");
        invokeImpl = mod.invoke as InvokeFn;
        return invokeImpl;
    }
    return null;
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
    const invoke = await getInvoke();
    if (!invoke) return null;
    return invoke<T>(cmd, args);
}

export const remote = {
    /** Server state, pairing URLs + QR codes, devices. */
    status(): Promise<RemoteStatus | null> {
        return call<RemoteStatus>("remote_status");
    },
    /**
     * Turn connected mode on (already on = the current status). `port` 0 / absent = any free
     * port; a fixed port that is taken starts on a free one (`portFallback` in the answer).
     * `overlayToken` = the stream overlay code of an earlier run.
     */
    start(opts: { partyOpen?: boolean; port?: number; bind?: string; overlayToken?: string } = {}): Promise<RemoteStatus | null> {
        return call<RemoteStatus>("remote_start", { partyOpen: opts.partyOpen ?? null, port: opts.port ?? null, bind: opts.bind ?? null, overlayToken: opts.overlayToken ?? null });
    },
    /** Turn it off: devices are disconnected and the request queue is dropped. */
    stop(): Promise<RemoteStatus | null> {
        return call<RemoteStatus>("remote_stop");
    },
    /** New code for a role; devices paired with the old one are disconnected. */
    rotate(role: RemoteRole): Promise<RemotePairing | null> {
        return call<RemotePairing>("remote_rotate", { role });
    },
    requests(): Promise<SongRequest[] | null> {
        return call<SongRequest[]>("remote_requests");
    },
    requestSet(id: number, status: RequestDecision): Promise<null> {
        return call<null>("remote_request_set", { id, status });
    },
    /**
     * Deck labels (stored while off too), the party switch, dropping finished requests, and the
     * controls lock (while locked no phone command reaches the decks; requests keep working).
     * `overlayRotate`: a new code for the stream overlay (read the new address with `status`).
     */
    set(opts: { partyOpen?: boolean; labels?: RemoteLabel[]; clearDone?: boolean; controlsLocked?: boolean; overlayRotate?: boolean }): Promise<null> {
        return call<null>("remote_set", { partyOpen: opts.partyOpen ?? null, labels: opts.labels ?? null, clearDone: opts.clearDone ?? null, controlsLocked: opts.controlsLocked ?? null, overlayRotate: opts.overlayRotate ?? null });
    },
};

type UnlistenFn = () => void;

/** Listen to `remote://state` and `remote://cue`. Resolves to the unlisten function. */
export async function subscribeRemote(onState: (e: RemoteEvent) => void, onCue: (e: RemoteCueEvent) => void): Promise<UnlistenFn> {
    if (!inTauri()) return () => {};
    const { listen } = await import("@tauri-apps/api/event");
    const a = await listen<RemoteEvent>("remote://state", (e) => onState(e.payload));
    const b = await listen<RemoteCueEvent>("remote://cue", (e) => onCue(e.payload));
    return () => {
        a();
        b();
    };
}
