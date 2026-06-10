"use client";

/**
 * useWebRTCAudioStream — React integration of WebRTCAudioBridge.
 *
 * Wraps a single bridge instance keyed by (selfPeerId, targetPeerId).
 * Auto-rebuilds when the target changes, auto-cleans up on unmount.
 *
 * Designed to be reusable from any host context (Live, DAW, Mixer, Editor).
 *
 * Usage:
 *   const stream = useWebRTCAudioStream({
 *     getOutputStream: () => engine.getOutputStream(),
 *     onRemoteStream: (s) => engine.attachRemoteInput(s),
 *   });
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useRemoteOptional } from "./remote-context";
import {
    WebRTCAudioBridge,
    type ConnectionState,
    type StreamQuality,
    type BridgeStats,
    type WebRTCSignal,
} from "@/lib/webrtc-audio-bridge";
import { fetchIceServers } from "@/lib/ice-servers";

const STORAGE_KEY = "webrtc-quality";

export interface UseWebRTCAudioStreamOptions {
    /** Called lazily to obtain the local engine output (master tap). Optional — without it, only mic can be sent. */
    getOutputStream?: () => MediaStream;
    /** Called when remote audio arrives or ends. */
    onRemoteStream?: (stream: MediaStream | null) => void;
    /** If false, the hook is dormant — no peer connection attempted. */
    enabled?: boolean;
}

export interface WebRTCAudioStreamApi {
    connectionState: ConnectionState;
    quality: StreamQuality;
    isSendingOutput: boolean;
    isSendingMic: boolean;
    isReceivingRemote: boolean;
    stats: BridgeStats;
    /** Whether a remote peer is currently connected via the relay (precondition). */
    hasPeer: boolean;
    /** Open or close the WebRTC connection itself. */
    start: () => Promise<void>;
    stop: () => void;
    /** Toggle sending the local engine output to the remote peer. */
    setSendOutput: (on: boolean) => Promise<void>;
    /** Toggle sending this peer's mic to the remote. */
    setSendMic: (on: boolean) => Promise<void>;
    /** Change Opus quality profile (renegotiates if needed). */
    setQuality: (q: StreamQuality) => Promise<void>;
}

export function useWebRTCAudioStream(opts: UseWebRTCAudioStreamOptions): WebRTCAudioStreamApi {
    const remote = useRemoteOptional();
    const bridgeRef = useRef<WebRTCAudioBridge | null>(null);
    // Mirror of the bridge's reactive state so `useWebRTCAudioStream`
    // returns plain values instead of reading `bridgeRef.current` during
    // render (which the React compiler / react-hooks lint flags as
    // "ref read during render" — it can desync the UI from the bridge).
    // The bridge fires `onStateChange` on every meaningful transition;
    // we snapshot the values we expose into this state on every tick.
    const [snapshot, setSnapshot] = useState<{
        connectionState: ConnectionState;
        quality: StreamQuality;
        isSendingOutput: boolean;
        isSendingMic: boolean;
        isReceivingRemote: boolean;
        stats: BridgeStats;
    }>(() => ({
        connectionState: "idle",
        quality: "balanced",
        isSendingOutput: false,
        isSendingMic: false,
        isReceivingRemote: false,
        stats: {
            rttMs: 0, bytesSentPerSec: 0, bytesReceivedPerSec: 0,
            packetsLost: 0, jitterMs: 0, audioLevelOut: 0, audioLevelIn: 0,
            iceState: "n/a", signalingState: "n/a", role: "responder",
        },
    }));
    const refreshSnapshot = useCallback(() => {
        const b = bridgeRef.current;
        setSnapshot(b
            ? {
                connectionState: b.connectionState,
                quality: b.quality,
                isSendingOutput: b.isSendingOutput,
                isSendingMic: b.isSendingMic,
                isReceivingRemote: b.isReceivingRemote,
                stats: b.stats,
            }
            : {
                connectionState: "idle",
                quality: "balanced",
                isSendingOutput: false,
                isSendingMic: false,
                isReceivingRemote: false,
                stats: {
                    rttMs: 0, bytesSentPerSec: 0, bytesReceivedPerSec: 0,
                    packetsLost: 0, jitterMs: 0, audioLevelOut: 0, audioLevelIn: 0,
                    iceState: "n/a", signalingState: "n/a", role: "responder",
                },
            });
    }, []);

    // ICE servers (incl. TURN credentials) — fetched once on mount, cached for ~23h.
    // The bridge MUST be constructed with these in place, otherwise an incoming
    // offer (responder side) will create the PeerConnection with default STUN-only
    // ICE servers and never relay through TURN behind symmetric NATs.
    const [iceServers, setIceServers] = useState<RTCIceServer[] | null>(null);
    useEffect(() => {
        let cancelled = false;
        console.info("[useWebRTCAudioStream] fetching ICE servers…");
        void fetchIceServers().then((s) => {
            if (cancelled) return;
            console.info("[useWebRTCAudioStream] ICE servers ready:", s.length, "entries", s);
            setIceServers(s);
        });
        return () => { cancelled = true; };
    }, []);

    // The "peer" we connect to: for HOST pages it's the controller talking to us;
    // for the REMOTE page it's the host we're connected to (connectedPeerId).
    // We pick whichever non-self peer is in `idle` (controller) or matches connectedPeerId.
    const targetPeerId = useRef<string | null>(null);
    const newTarget = (() => {
        if (!remote) return null;
        // Remote (controller) side: use connectedPeerId
        if (remote.connectedPeerId) return remote.connectedPeerId;
        // Host side: pick the most-recent idle peer (controller) — the one who can receive
        const idlePeer = remote.peers.find((p) => p.id !== remote.peerId && p.page === "idle");
        return idlePeer?.id ?? null;
    })();
    // Sync the derived target into a ref AFTER render so the signal
    // dispatcher (which fires from network events outside React's render
    // cycle) can compare incoming peerIds against the latest target
    // without us writing to a ref during render.
    useEffect(() => {
        targetPeerId.current = newTarget;
    }, [newTarget]);

    // ── Signal buffering ─────────────────────────────────────────────────────
    // Subscribe to incoming signals IMMEDIATELY on mount so we don't miss the
    // initial offer that the initiator sends as soon as its bridge is built.
    // Buffer per-peer until our bridge exists, then drain.
    const signalBufferRef = useRef<Map<string, WebRTCSignal[]>>(new Map());

    useEffect(() => {
        if (!remote) return;
        const unsub = remote.onSignal((fromPeerId, payload) => {
            const signal = payload as WebRTCSignal;
            const bridge = bridgeRef.current;
            // Only feed to bridge if it matches the current target
            if (bridge && targetPeerId.current === fromPeerId) {
                console.info("[useWebRTCAudioStream] signal in →", signal.type, "from", fromPeerId.slice(0, 6));
                void bridge.handleSignal(signal);
            } else {
                // Buffer for later — bridge not ready yet (ICE servers loading or
                // target hasn't been resolved). Capped at 64 entries per peer to
                // avoid memory leaks from rogue peers.
                console.info("[useWebRTCAudioStream] signal buffered →", signal.type, "from", fromPeerId.slice(0, 6),
                    "(bridge=", !!bridge, "target=", targetPeerId.current?.slice(0, 6) ?? "null", ")");
                const buf = signalBufferRef.current.get(fromPeerId) ?? [];
                buf.push(signal);
                if (buf.length > 64) buf.shift();
                signalBufferRef.current.set(fromPeerId, buf);
            }
        });
        return unsub;
    }, [remote]);

    // Rebuild bridge when target changes
    useEffect(() => {
        if (!remote || !newTarget || !opts.enabled || !iceServers) {
            // Tear down any existing
            if (bridgeRef.current) {
                console.info("[useWebRTCAudioStream] tearing down bridge — hasRemote=", !!remote, "target=", newTarget?.slice(0, 6) ?? "null", "enabled=", opts.enabled, "iceReady=", !!iceServers);
                bridgeRef.current.destroy();
                bridgeRef.current = null;
            }
            refreshSnapshot();
            return;
        }

        console.info("[useWebRTCAudioStream] constructing bridge", remote.peerId.slice(0, 6), "→", newTarget.slice(0, 6),
            "iceServers=", iceServers.length);

        const bridge = new WebRTCAudioBridge({
            selfPeerId: remote.peerId,
            targetPeerId: newTarget,
            iceServers,
            sendSignal: (signal) => {
                console.info("[useWebRTCAudioStream] signal out ←", signal.type, "to", newTarget.slice(0, 6));
                remote.sendSignal(newTarget, signal);
            },
            onStateChange: () => { refreshSnapshot(); },
            onRemoteStream: (s) => opts.onRemoteStream?.(s),
        });

        // Restore quality from storage
        try {
            const saved = localStorage.getItem(STORAGE_KEY) as StreamQuality | null;
            if (saved && ["ultra", "high", "balanced", "low"].includes(saved)) {
                bridge.quality = saved;
            }
        } catch { /* noop */ }

        bridgeRef.current = bridge;
        // Bridge state may already be non-default (quality restored) —
        // pull a fresh snapshot now so consumers see the right values
        // before the first state-change tick.
        refreshSnapshot();

        // Drain any signals that arrived before the bridge existed (race during ICE-fetch)
        const buffered = signalBufferRef.current.get(newTarget);
        if (buffered && buffered.length > 0) {
            console.info("[useWebRTCAudioStream] draining", buffered.length, "buffered signal(s) for", newTarget.slice(0, 6));
            signalBufferRef.current.delete(newTarget);
            (async () => {
                for (const s of buffered) {
                    await bridge.handleSignal(s);
                }
            })().catch((e) => console.warn("[useWebRTCAudioStream] drain error", e));
        }

        return () => {
            bridge.destroy();
            if (bridgeRef.current === bridge) bridgeRef.current = null;
            refreshSnapshot();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [remote?.peerId, newTarget, opts.enabled, iceServers]);

    // ── Actions ──
    const start = useCallback(async () => {
        const b = bridgeRef.current;
        if (!b) {
            console.info("[useWebRTCAudioStream] start() called but bridge not ready (waiting on iceServers/target)");
            return;
        }
        console.info("[useWebRTCAudioStream] start() →", b.isInitiator ? "INITIATOR" : "RESPONDER");
        await b.open();
    }, []);

    const stop = useCallback(() => {
        bridgeRef.current?.close();
    }, []);

    const setSendOutput = useCallback(async (on: boolean) => {
        const b = bridgeRef.current;
        if (!b) return;
        if (on) {
            if (!opts.getOutputStream) return; // No source available — nothing to send
            const stream = opts.getOutputStream();
            await b.setLocalOutput(stream);
        } else {
            await b.setLocalOutput(null);
        }
    }, [opts]);

    const setSendMic = useCallback(async (on: boolean) => {
        const b = bridgeRef.current;
        if (!b) return;
        if (on) {
            await b.startMic();
        } else {
            await b.stopMic();
        }
    }, []);

    const setQuality = useCallback(async (q: StreamQuality) => {
        const b = bridgeRef.current;
        if (!b) return;
        await b.setQuality(q);
        try {
            localStorage.setItem(STORAGE_KEY, q);
            window.dispatchEvent(new Event("mmo-preference-changed"));
        } catch { /* noop */ }
    }, []);

    return {
        ...snapshot,
        hasPeer: !!newTarget,
        start, stop, setSendOutput, setSendMic, setQuality,
    };
}
