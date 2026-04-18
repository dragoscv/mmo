"use client";

/**
 * Remote Context — React integration for the RemoteSyncEngine.
 *
 * HOST mode: used by /mixer, /daw, /editor pages to broadcast state
 *   and receive commands from remote controllers.
 *
 * REMOTE mode: used by /remote page to discover peers, receive state
 *   snapshots, and send commands.
 */

import {
    createContext,
    useContext,
    useEffect,
    useRef,
    useState,
    useCallback,
    useMemo,
    type ReactNode,
} from "react";
import {
    RemoteSyncEngine,
    type RemotePage,
    type PeerInfo,
    type StateSnapshot,
    type SyncMessage,
    type RemoteCommand,
    type MixerSnapshot,
    type DAWSnapshot,
    type EditorSnapshot,
    type LiveSnapshot,
} from "@/lib/remote-sync";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RemoteContextValue {
    /** This peer's ID */
    peerId: string;
    /** All discovered peers */
    peers: PeerInfo[];
    /** Currently connected peer ID (remote mode) */
    connectedPeerId: string | null;
    /** Latest state snapshot from connected peer */
    snapshot: StateSnapshot | null;
    /** Connection latency estimate (ms) */
    latency: number;
    /** Whether the engine is running */
    isActive: boolean;

    // ── Actions ──────────────────────────────────────────────────────────────
    /** Connect to a specific peer (remote mode) */
    connectToPeer: (peerId: string) => void;
    /** Disconnect from current peer */
    disconnect: () => void;
    /** Send a command to the connected peer */
    sendCommand: (action: string, ...args: unknown[]) => void;
    /** Broadcast state (host mode) */
    broadcastState: (snapshot: StateSnapshot) => void;
    /** Register a command handler (host mode) */
    onCommand: (handler: CommandHandler) => () => void;
    /** Send a WebRTC signaling payload to a specific peer */
    sendSignal: (targetPeerId: string, payload: unknown) => void;
    /** Subscribe to incoming WebRTC signals addressed to this peer */
    onSignal: (handler: SignalHandler) => () => void;
}

export type CommandHandler = (action: string, args: unknown[], ack: (success: boolean, error?: string) => void) => void;
export type SignalHandler = (fromPeerId: string, payload: unknown) => void;

const RemoteContext = createContext<RemoteContextValue | null>(null);

export function useRemote() {
    const ctx = useContext(RemoteContext);
    if (!ctx) throw new Error("useRemote must be used within <RemoteProvider>");
    return ctx;
}

/** Optional — returns null if not inside a provider (safe for conditional use) */
export function useRemoteOptional(): RemoteContextValue | null {
    return useContext(RemoteContext);
}

// ─── Provider ────────────────────────────────────────────────────────────────

interface RemoteProviderProps {
    page: RemotePage;
    children: ReactNode;
}

export function RemoteProvider({ page, children }: RemoteProviderProps) {
    const engineRef = useRef<RemoteSyncEngine | null>(null);
    const [peers, setPeers] = useState<PeerInfo[]>([]);
    const [connectedPeerId, setConnectedPeerId] = useState<string | null>(null);
    const [snapshot, setSnapshot] = useState<StateSnapshot | null>(null);
    const [latency, setLatency] = useState(0);
    const [peerId, setPeerId] = useState("");
    const commandHandlersRef = useRef(new Set<CommandHandler>());
    const signalHandlersRef = useRef(new Set<SignalHandler>());

    // Initialize engine
    useEffect(() => {
        const engine = new RemoteSyncEngine(page);
        engineRef.current = engine;
        setPeerId(engine.peerId);

        const unsub = engine.onMessage((msg: SyncMessage) => {
            switch (msg.type) {
                case "peer:announce":
                case "peer:heartbeat":
                case "peer:bye":
                    setPeers([...engine.peers]);
                    break;

                case "state:snapshot":
                    // Only accept state from connected peer
                    if (msg.senderId === connectedPeerIdRef.current) {
                        setSnapshot(msg.snapshot);
                        setLatency(Date.now() - msg.timestamp);
                    }
                    break;

                case "command:exec":
                    // Only accept commands directed at us
                    if (msg.command.targetPeerId === engine.peerId) {
                        for (const handler of commandHandlersRef.current) {
                            handler(msg.command.action, msg.command.args, (success, error) => {
                                engine.ackCommand(msg.command.action, success, error);
                            });
                        }
                    }
                    break;

                case "webrtc:signal":
                    // Only accept signals addressed to us
                    if (msg.targetPeerId === engine.peerId) {
                        for (const handler of signalHandlersRef.current) {
                            try { handler(msg.senderId, msg.payload); } catch { /* noop */ }
                        }
                    }
                    break;
            }
        });

        return () => {
            unsub();
            engine.destroy();
            engineRef.current = null;
        };
    }, [page]);

    // Track connectedPeerId in a ref for the message handler
    const connectedPeerIdRef = useRef(connectedPeerId);
    connectedPeerIdRef.current = connectedPeerId;

    // Update page if it changes
    useEffect(() => {
        engineRef.current?.setPage(page);
    }, [page]);

    // ── Actions ──────────────────────────────────────────────────────────────

    const connectToPeer = useCallback((targetPeerId: string) => {
        setConnectedPeerId(targetPeerId);
        setSnapshot(null);
        setLatency(0);
    }, []);

    const disconnect = useCallback(() => {
        setConnectedPeerId(null);
        setSnapshot(null);
        setLatency(0);
    }, []);

    const sendCommand = useCallback((action: string, ...args: unknown[]) => {
        if (!connectedPeerIdRef.current || !engineRef.current) return;
        engineRef.current.sendCommand({
            targetPeerId: connectedPeerIdRef.current,
            action,
            args,
        });
    }, []);

    const broadcastState = useCallback((snap: StateSnapshot) => {
        engineRef.current?.broadcastState(snap);
    }, []);

    const onCommand = useCallback((handler: CommandHandler) => {
        commandHandlersRef.current.add(handler);
        return () => { commandHandlersRef.current.delete(handler); };
    }, []);

    const sendSignal = useCallback((targetPeerId: string, payload: unknown) => {
        engineRef.current?.sendSignal(targetPeerId, payload);
    }, []);

    const onSignal = useCallback((handler: SignalHandler) => {
        signalHandlersRef.current.add(handler);
        return () => { signalHandlersRef.current.delete(handler); };
    }, []);

    const value = useMemo<RemoteContextValue>(() => ({
        peerId,
        peers,
        connectedPeerId,
        snapshot,
        latency,
        isActive: !!engineRef.current,
        connectToPeer,
        disconnect,
        sendCommand,
        broadcastState,
        onCommand,
        sendSignal,
        onSignal,
    }), [peerId, peers, connectedPeerId, snapshot, latency, connectToPeer, disconnect, sendCommand, broadcastState, onCommand, sendSignal, onSignal]);

    return (
        <RemoteContext.Provider value={value}>
            {children}
        </RemoteContext.Provider>
    );
}

// ─── Host hooks (for mixer/daw/editor pages) ────────────────────────────────

/**
 * Hook for host pages to broadcast state and handle commands.
 * Call broadcastState() in a useEffect or animation frame loop.
 */
export function useRemoteHost() {
    const remote = useRemoteOptional();
    return {
        broadcastState: remote?.broadcastState ?? (() => { }),
        onCommand: remote?.onCommand ?? (() => () => { }),
        peerId: remote?.peerId ?? "",
        peers: remote?.peers ?? [],
    };
}

// ─── Type guards ─────────────────────────────────────────────────────────────

export function isMixerSnapshot(s: StateSnapshot | null): s is MixerSnapshot {
    return s?.page === "mixer";
}

export function isDAWSnapshot(s: StateSnapshot | null): s is DAWSnapshot {
    return s?.page === "daw";
}

export function isEditorSnapshot(s: StateSnapshot | null): s is EditorSnapshot {
    return s?.page === "editor";
}

export function isLiveSnapshot(s: StateSnapshot | null): s is LiveSnapshot {
    return s?.page === "live";
}
