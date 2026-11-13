/**
 * Connected mode in the UI (WP19-42): state of the LAN server in the Rust shell (bridge/remote),
 * kept current by the `remote://state` event, plus the two things the shell needs from the UI:
 * the library title / artist of each loaded deck and the deck's cue point (the phone's CUE
 * button uses it; a cue point a phone moves comes back through `remote://cue`).
 *
 * Stream overlay (WP19-59): with a shell that knows it, a start always asks for the fixed port
 * (a fallback port is for that run only, it is never kept) and hands back the overlay code kept
 * in localStorage (its own key, not part of the settings export or the cloud profile), so the
 * address pasted into OBS survives a restart. With an older shell nothing of this is sent or
 * shown.
 *
 * Nothing here polls. While the server is off the only cost is one identity check per engine
 * snapshot.
 */
import { create } from "zustand";
import { devExpose } from "@/dev/expose";
import { remote, subscribeRemote, type RemoteClient, type RemoteCueEvent, type RemoteEvent, type RemoteLabel, type RemoteOnAir, type RemotePairing, type RemoteRole, type RemoteStatus, type RequestDecision, type SongRequest } from "@/bridge/remote";
import type { DeckState } from "@/bridge/types";
import { cuePointFor, useDeckUi } from "@/components/deck-ui-store";
import { useMixerStore } from "@/state/mixer-store";
import { copyText, loadOverlaySaved, overlaySupported, rememberOverlay, startArgs, type ClipboardLike, type CopyResult, type StorageLike } from "./overlay-core";
import { LOCK_UNSUPPORTED, buildLabels, errorText, isMissingFeature, labelsKey, newPending } from "./remote-core";

/** `preview` = not inside the desktop shell; `old` = a shell built before connected mode. */
export type Availability = "unknown" | "ready" | "preview" | "old";

export interface RemoteState {
    availability: Availability;
    running: boolean;
    /** A start / stop is on its way. */
    busy: boolean;
    /** Message of the last refused action (cleared by the next one). */
    error: string | null;
    host: string | null;
    port: number | null;
    /** Controller, viewer, guest; empty while off. */
    pairings: RemotePairing[];
    clients: RemoteClient[];
    requests: SongRequest[];
    partyOpen: boolean;
    /** What the DJ last chose for song requests; used by the next start. */
    partyPref: boolean;
    /** The phone controls are locked (transport / mixer commands refused; requests work). */
    controlsLocked: boolean;
    /** The shell knows the stream overlay (false with a shell built before it: nothing of it is shown). */
    overlaySupported: boolean;
    /** Stream overlay address for OBS on this computer; null while off or when only a LAN address answers. */
    urlOverlay: string | null;
    /** Stream overlay address for a second computer; null while off or when the server is on loopback only. */
    urlOverlayLan: string | null;
    /** The port asked for was taken: the server runs on another one (the addresses changed). */
    portFallback: boolean;
    /** The track the stream overlay shows right now. */
    onAir: RemoteOnAir | null;
    /**
     * The latest request that arrived while the server runs, for ONE polite announcement
     * (`seq` grows with every arrival so the same song asked again is announced again).
     */
    arrived: { seq: number; title: string; artist: string } | null;
    refresh: () => Promise<void>;
    /** `bind`: address to listen on (default: every interface; `127.0.0.1` stays off the network). */
    start: (opts?: { bind?: string; port?: number }) => Promise<void>;
    stop: () => Promise<void>;
    rotate: (role: RemoteRole) => Promise<void>;
    /** New code for the stream overlay. True when the address changed (OBS needs the new one). */
    rotateOverlay: () => Promise<boolean>;
    /** Put a stream overlay address on the clipboard. Never throws. */
    copyOverlay: (url: string) => Promise<CopyResult>;
    setPartyOpen: (open: boolean) => Promise<void>;
    setControlsLocked: (locked: boolean) => Promise<void>;
    decide: (id: number, decision: RequestDecision) => Promise<void>;
    clearDone: () => Promise<void>;
}

const OFF = {
    running: false,
    host: null,
    port: null,
    pairings: [] as RemotePairing[],
    clients: [] as RemoteClient[],
    requests: [] as SongRequest[],
    partyOpen: false,
    arrived: null,
    urlOverlay: null,
    urlOverlayLan: null,
    portFallback: false,
    onAir: null,
};

/** Development only: a stand-in clipboard for live tests (undefined = the system clipboard). */
let clipboardOverride: ClipboardLike | null | undefined;

function storage(): StorageLike | null {
    try {
        return typeof localStorage === "undefined" ? null : localStorage;
    } catch {
        return null;
    }
}

/** Keep the overlay code of a running server for the next start (written only on a change; never a port). */
function remember(s: RemoteStatus): void {
    rememberOverlay(storage(), s);
}

/** The same object while the texts are the same, so nothing that shows it renders again. */
function sameOnAir(prev: RemoteOnAir | null, next: RemoteOnAir | null | undefined): RemoteOnAir | null {
    if (!next) return null;
    return prev && prev.title === next.title && prev.artist === next.artist ? prev : { title: next.title ?? null, artist: next.artist ?? null };
}

function fromStatus(s: RemoteStatus): Partial<RemoteState> {
    const controlsLocked = s.controlsLocked ?? false;
    const supported = overlaySupported(s);
    if (!s.running) return { ...OFF, controlsLocked, overlaySupported: supported };
    remember(s);
    return {
        running: true,
        host: s.host,
        port: s.port,
        pairings: s.pairings,
        clients: s.clients,
        partyOpen: s.partyOpen,
        controlsLocked,
        overlaySupported: supported,
        urlOverlay: supported ? (s.urlOverlay ?? null) : null,
        urlOverlayLan: supported ? (s.urlOverlayLan ?? null) : null,
        portFallback: s.portFallback === true,
        onAir: supported ? sameOnAir(useRemoteStore.getState().onAir, s.onAir) : null,
    };
}

let arrivals = 0;

/** The request list from the shell; a request that was not waiting before is announced. */
function withRequests(requests: SongRequest[]): Partial<RemoteState> {
    const fresh = newPending(useRemoteStore.getState().requests, requests);
    const last = fresh.at(-1);
    if (!last) return { requests };
    arrivals += 1;
    return { requests, arrived: { seq: arrivals, title: last.title, artist: last.artist } };
}

/** A refused command: an older shell changes the availability, anything else is shown. */
function failure(e: unknown): Partial<RemoteState> {
    return isMissingFeature(e) ? { availability: "old", ...OFF } : { error: errorText(e) };
}

export const useRemoteStore = create<RemoteState>((set, get) => ({
    availability: "unknown",
    busy: false,
    error: null,
    partyPref: true,
    controlsLocked: false,
    overlaySupported: false,
    ...OFF,

    refresh: async () => {
        try {
            const s = await remote.status();
            if (!s) {
                set({ availability: "preview", ...OFF });
                return;
            }
            set({ availability: "ready", ...fromStatus(s) });
            if (s.running) {
                // After a page reload the shell has nothing new to announce: ask once.
                const requests = await remote.requests();
                if (requests && get().running) set({ requests });
                syncLabels(true);
            }
        } catch (e) {
            set(failure(e));
        }
    },

    start: async (opts) => {
        if (get().busy) return;
        set({ busy: true, error: null });
        try {
            // Whether the shell knows the stream overlay is read off a status answer: ask once
            // when a start comes before the first one (the chip asks when it mounts).
            if (get().availability === "unknown") {
                const first = await remote.status();
                if (first) set({ availability: "ready", overlaySupported: overlaySupported(first) });
            }
            const args = startArgs(opts, loadOverlaySaved(storage()), get().overlaySupported);
            const s = await remote.start({ partyOpen: get().partyPref, ...args });
            if (s) {
                set({ availability: "ready", ...fromStatus(s) });
                syncLabels(true);
                const requests = await remote.requests();
                if (requests && get().running) set({ requests });
            } else {
                set({ availability: "preview", ...OFF });
            }
        } catch (e) {
            set(failure(e));
        } finally {
            set({ busy: false });
        }
    },

    stop: async () => {
        if (get().busy) return;
        set({ busy: true, error: null });
        try {
            await remote.stop();
            set({ ...OFF });
        } catch (e) {
            set(failure(e));
        } finally {
            set({ busy: false });
        }
    },

    rotate: async (role) => {
        set({ error: null });
        try {
            const p = await remote.rotate(role);
            if (p) set({ pairings: get().pairings.map((x) => (x.role === p.role ? p : x)) });
        } catch (e) {
            set(failure(e));
            void get().refresh();
        }
    },

    rotateOverlay: async () => {
        set({ error: null });
        try {
            const before = get().urlOverlay ?? get().urlOverlayLan;
            await remote.set({ overlayRotate: true });
            // The new code comes back in the status (and is kept for the next start there).
            const s = await remote.status();
            if (!s) return false;
            set(fromStatus(s));
            const after = get().urlOverlay ?? get().urlOverlayLan;
            return after !== null && after !== before;
        } catch (e) {
            set(failure(e));
            return false;
        }
    },

    copyOverlay: (url) => copyText(url, clipboardOverride),

    setPartyOpen: async (open) => {
        set({ error: null, partyPref: open });
        try {
            await remote.set({ partyOpen: open });
            set({ partyOpen: open });
        } catch (e) {
            set(failure(e));
        }
    },

    setControlsLocked: async (locked) => {
        set({ error: null });
        try {
            await remote.set({ controlsLocked: locked });
            // A shell built before the lock ignores the argument and answers "ok": read the
            // state back rather than show a lock that is not there.
            const s = await remote.status();
            if (s && s.controlsLocked === undefined) set({ controlsLocked: false, error: LOCK_UNSUPPORTED });
            else set({ controlsLocked: s?.controlsLocked ?? locked });
        } catch (e) {
            set(failure(e));
        }
    },

    decide: async (id, decision) => {
        set({ error: null });
        try {
            await remote.requestSet(id, decision);
            // Show it at once; the event with the server's order follows within half a second.
            set({ requests: get().requests.map((r) => (r.id === id ? { ...r, status: decision } : r)) });
        } catch (e) {
            set(failure(e));
            const requests = await remote.requests().catch(() => null);
            if (requests) set({ requests });
        }
    },

    clearDone: async () => {
        set({ error: null });
        try {
            await remote.set({ clearDone: true });
            set({ requests: get().requests.filter((r) => r.status === "pending" || r.status === "accepted") });
        } catch (e) {
            set(failure(e));
        }
    },
}));

// ---- shell -> UI -----------------------------------------------------------------------------

function onEvent(e: RemoteEvent): void {
    const cur = useRemoteStore.getState();
    if (!e.running) {
        if (cur.running) useRemoteStore.setState({ ...OFF });
        return;
    }
    // Only a request that arrives while the list is already known is news: the first list
    // after a start or a page reload is not announced.
    const requests = cur.running ? withRequests(e.requests) : { requests: e.requests };
    const onAir = cur.overlaySupported ? sameOnAir(cur.onAir, e.onAir) : null;
    useRemoteStore.setState({ availability: "ready", running: true, clients: e.clients, partyOpen: e.partyOpen, controlsLocked: e.controlsLocked ?? cur.controlsLocked, onAir, ...requests });
    // Started somewhere else (another window): fetch the pairing codes.
    if (!cur.running || cur.pairings.length === 0) void cur.refresh();
}

/** A phone set the cue point of a deck: the deck's CUE button in the app follows. */
function onCue(e: RemoteCueEvent): void {
    if (!Number.isFinite(e.sec) || e.sec < 0) return;
    const deck = useMixerStore.getState().deck(e.deck);
    if (deck.loaded) useDeckUi.getState().setCuePoint(e.deck, e.sec, deck.trackId);
}

// ---- UI -> shell: deck labels + cue points ----------------------------------------------------

let sentKey: string | null = null;

/** Send the labels when they changed (always with `force`). Only while the server runs. */
function syncLabels(force = false): void {
    const s = useRemoteStore.getState();
    if (s.availability !== "ready" || !s.running) return;
    const ui = useDeckUi.getState();
    const labels = buildLabels(useMixerStore.getState().decks, (d) => cuePointFor(ui, d.id, d.trackId, d.duration));
    const key = labelsKey(labels);
    if (!force && key === sentKey) return;
    sentKey = key;
    remote.set({ labels: labels as RemoteLabel[] }).catch(() => {
        sentKey = null;
    });
}

function sameLabelFields(a: readonly DeckState[], b: readonly DeckState[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        const x = a[i]!;
        const y = b[i]!;
        if (x.loaded !== y.loaded || x.trackId !== y.trackId || x.title !== y.title || x.artist !== y.artist) return false;
    }
    return true;
}

function watchDecks(): () => void {
    let seen: readonly DeckState[] = useMixerStore.getState().decks;
    const offMixer = useMixerStore.subscribe((m) => {
        if (m.decks === seen) return;
        const prev = seen;
        seen = m.decks;
        // A playing deck changes the array ~30 times a second: compare four fields per deck.
        if (useRemoteStore.getState().running && !sameLabelFields(prev, m.decks)) syncLabels();
    });
    let cue = useDeckUi.getState().cuePoint;
    const offUi = useDeckUi.subscribe((u) => {
        if (u.cuePoint === cue) return;
        cue = u.cuePoint;
        syncLabels();
    });
    return () => {
        offMixer();
        offUi();
    };
}

// ---- lifetime ---------------------------------------------------------------------------------

let users = 0;
let stopAll: (() => void) | null = null;

function run(): () => void {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    // The listener may resolve after the cleanup ran (StrictMode, fast unmount): drop it then.
    void subscribeRemote(onEvent, onCue)
        .then((u) => {
            if (cancelled) u();
            else unlisten = u;
        })
        .catch(() => undefined);
    void useRemoteStore.getState().refresh();
    const offDecks = watchDecks();
    return () => {
        cancelled = true;
        unlisten?.();
        offDecks();
    };
}

/** Called by the chip while it is mounted (shared: one set of listeners however many callers). */
export function startRemote(): () => void {
    users += 1;
    if (users === 1) stopAll = run();
    let done = false;
    return () => {
        if (done) return;
        done = true;
        users -= 1;
        if (users === 0) {
            stopAll?.();
            stopAll = null;
        }
    };
}

devExpose("remote", useRemoteStore);
devExpose("remoteDebug", {
    /** Replace the clipboard Copy writes to (`undefined` puts the system clipboard back). */
    clipboard: (c: ClipboardLike | null | undefined) => {
        clipboardOverride = c;
    },
});
