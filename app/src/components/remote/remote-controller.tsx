"use client";

import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { useRemote, isMixerSnapshot, isDAWSnapshot, isEditorSnapshot } from "./remote-context";
import { useFocusMode } from "@/components/focus-mode-context";
import { cn } from "@/lib/utils";
import {
    Wifi,
    WifiOff,
    Smartphone,
    Monitor,
    Disc3,
    Piano,
    Waves,
    Radio,
    Maximize2,
    Minimize2,
    Settings2,
    LayoutGrid,
    Loader2,
    Zap,
    Signal,
    RefreshCw,
    ZoomIn,
    ZoomOut,
    RotateCcw,
} from "lucide-react";
import { MixerRemoteWidget } from "./widgets/mixer-remote-widget";
import { DAWRemoteWidget } from "./widgets/daw-remote-widget";
import { EditorRemoteWidget } from "./widgets/editor-remote-widget";
import type { PeerInfo, RemotePage } from "@/lib/remote-sync";

// ─── Connection Status Bar ───────────────────────────────────────────────────

function ConnectionBar({ peer, latency, onDisconnect }: { peer: PeerInfo | null; latency: number; onDisconnect: () => void }) {
    const latencyColor = latency < 20 ? "text-emerald-400" : latency < 50 ? "text-amber-400" : "text-red-400";
    const signalBars = latency < 20 ? 4 : latency < 50 ? 3 : latency < 100 ? 2 : 1;

    return (
        <div className={cn(
            "flex items-center gap-3 px-4 py-2 rounded-xl border transition-all",
            peer ? "bg-emerald-500/5 border-emerald-500/20" : "bg-white/[0.02] border-white/[0.06]",
        )}>
            <div className={cn(
                "w-2 h-2 rounded-full animate-pulse",
                peer ? "bg-emerald-400" : "bg-white/20",
            )} />

            <div className="flex-1 min-w-0">
                {peer ? (
                    <div className="flex items-center gap-2">
                        <PageIcon page={peer.page} className="w-3.5 h-3.5 text-white/50" />
                        <span className="text-xs font-medium text-white/70 truncate">{peer.label}</span>
                    </div>
                ) : (
                    <span className="text-xs text-white/30">Not connected</span>
                )}
            </div>

            {peer && (
                <>
                    {/* Signal strength */}
                    <div className="flex items-end gap-px h-3.5" title={`Latency: ${latency}ms`}>
                        {[1, 2, 3, 4].map(n => (
                            <div key={n} className={cn(
                                "w-1 rounded-full transition-all",
                                n <= signalBars ? latencyColor : "bg-white/10",
                            )} style={{ height: `${n * 25}%` }} />
                        ))}
                    </div>
                    <span className={cn("text-[10px] tabular-nums font-mono", latencyColor)}>
                        {latency}ms
                    </span>
                    <button
                        onClick={onDisconnect}
                        className="text-[10px] px-2 py-0.5 rounded bg-white/5 text-white/30 hover:text-red-400 hover:bg-red-500/10 transition-colors cursor-pointer"
                    >
                        Disconnect
                    </button>
                </>
            )}
        </div>
    );
}

// ─── Page Icon ───────────────────────────────────────────────────────────────

function PageIcon({ page, className }: { page: RemotePage; className?: string }) {
    switch (page) {
        case "mixer": return <Disc3 className={className} />;
        case "daw": return <Piano className={className} />;
        case "editor": return <Waves className={className} />;
        default: return <Radio className={className} />;
    }
}

// ─── Peer Card ───────────────────────────────────────────────────────────────

function PeerCard({ peer, isConnected, onConnect }: { peer: PeerInfo; isConnected: boolean; onConnect: () => void }) {
    const isMobile = /mobile|android|iphone|ipad/i.test(peer.userAgent);
    const pageLabel = peer.page === "idle" ? "Idle" : peer.page.charAt(0).toUpperCase() + peer.page.slice(1);
    const pageColor = peer.page === "mixer" ? "text-orange-400 bg-orange-500/10 border-orange-500/20"
        : peer.page === "daw" ? "text-blue-400 bg-blue-500/10 border-blue-500/20"
        : peer.page === "editor" ? "text-purple-400 bg-purple-500/10 border-purple-500/20"
        : "text-white/30 bg-white/[0.03] border-white/[0.06]";

    const canConnect = peer.page !== "idle";

    return (
        <button
            onClick={canConnect ? onConnect : undefined}
            disabled={!canConnect}
            className={cn(
                "relative group flex flex-col items-center gap-3 p-5 rounded-2xl border transition-all duration-300 cursor-pointer",
                isConnected
                    ? "bg-emerald-500/10 border-emerald-500/30 shadow-[0_0_20px_rgba(16,185,129,0.1)]"
                    : canConnect
                        ? "bg-white/[0.02] border-white/[0.06] hover:bg-white/[0.04] hover:border-white/[0.12] hover:shadow-lg"
                        : "bg-white/[0.01] border-white/[0.04] opacity-50 cursor-not-allowed",
            )}
        >
            {/* Device icon */}
            <div className={cn(
                "relative flex items-center justify-center w-14 h-14 rounded-2xl border",
                pageColor,
            )}>
                {isMobile ? <Smartphone className="w-6 h-6" /> : <Monitor className="w-6 h-6" />}
                {/* Page badge */}
                <div className="absolute -bottom-1 -right-1 flex items-center justify-center w-6 h-6 rounded-full bg-[oklch(0.14_0.01_260)] border border-white/[0.1]">
                    <PageIcon page={peer.page} className="w-3 h-3 text-white/60" />
                </div>
            </div>

            {/* Label */}
            <div className="text-center">
                <div className="text-xs font-medium text-white/70 truncate max-w-[140px]">{peer.label}</div>
                <div className={cn("text-[10px] mt-0.5", canConnect ? "text-white/40" : "text-white/20")}>
                    {pageLabel}
                </div>
            </div>

            {/* Connected indicator */}
            {isConnected && (
                <div className="absolute top-2 right-2 flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-emerald-500/20 text-[9px] font-medium text-emerald-400">
                    <Zap className="w-2.5 h-2.5" /> Connected
                </div>
            )}
        </button>
    );
}

// ─── Waiting State ───────────────────────────────────────────────────────────

function WaitingState({ message }: { message: string }) {
    return (
        <div className="flex-1 flex flex-col items-center justify-center gap-6 px-4">
            <div className="relative">
                {/* Animated rings */}
                <div className="absolute inset-0 -m-8 rounded-full border border-white/[0.04] animate-[ping_3s_ease-in-out_infinite]" />
                <div className="absolute inset-0 -m-16 rounded-full border border-white/[0.03] animate-[ping_3s_ease-in-out_1s_infinite]" />
                <div className="absolute inset-0 -m-24 rounded-full border border-white/[0.02] animate-[ping_3s_ease-in-out_2s_infinite]" />

                <div className="relative flex items-center justify-center w-20 h-20 rounded-3xl bg-white/[0.03] border border-white/[0.06]">
                    <Radio className="w-8 h-8 text-white/20 animate-pulse" />
                </div>
            </div>

            <div className="text-center mt-8">
                <p className="text-sm text-white/50 font-medium">{message}</p>
                <p className="text-xs text-white/25 mt-2 max-w-sm">
                    Open the Mixer, DAW, or Sound Editor in another tab to enable remote control.
                </p>
            </div>

            <div className="flex items-center gap-2 text-[10px] text-white/20">
                <Loader2 className="w-3 h-3 animate-spin" />
                Scanning for devices...
            </div>
        </div>
    );
}

// ─── Main Remote Controller ──────────────────────────────────────────────────

const SCALE_STEPS = [0.7, 0.8, 0.9, 1.0, 1.15, 1.3, 1.5, 1.75, 2.0] as const;
const SCALE_STORAGE_KEY = "remote-ui-scale";

function readStoredScale(): number {
    if (typeof window === "undefined") return 1.0;
    const v = localStorage.getItem(SCALE_STORAGE_KEY);
    if (!v) return 1.0;
    const n = parseFloat(v);
    return SCALE_STEPS.includes(n as typeof SCALE_STEPS[number]) ? n : 1.0;
}

export function RemoteController() {
    const remote = useRemote();
    const { isFocusMode, toggleFocusMode } = useFocusMode();
    const [showDevices, setShowDevices] = useState(true);
    const [uiScale, setUiScale] = useState(readStoredScale);

    const changeScale = useCallback((dir: 1 | -1) => {
        setUiScale(prev => {
            const idx = SCALE_STEPS.indexOf(prev as typeof SCALE_STEPS[number]);
            const next = SCALE_STEPS[Math.max(0, Math.min(SCALE_STEPS.length - 1, (idx === -1 ? 3 : idx) + dir))];
            localStorage.setItem(SCALE_STORAGE_KEY, String(next));
            return next;
        });
    }, []);

    const resetScale = useCallback(() => {
        setUiScale(1.0);
        localStorage.setItem(SCALE_STORAGE_KEY, "1");
    }, []);

    // Filter out self and "idle" peers that aren't remote controllers
    const availablePeers = useMemo(() =>
        remote.peers.filter(p => p.id !== remote.peerId),
    [remote.peers, remote.peerId]);

    const connectedPeer = useMemo(() =>
        availablePeers.find(p => p.id === remote.connectedPeerId) ?? null,
    [availablePeers, remote.connectedPeerId]);

    // Auto-connect to first available peer if none connected
    useEffect(() => {
        if (remote.connectedPeerId) return;
        const hostPeer = availablePeers.find(p => p.page !== "idle");
        if (hostPeer) {
            remote.connectToPeer(hostPeer.id);
            setShowDevices(false);
        }
    }, [availablePeers, remote.connectedPeerId, remote]);

    // Auto-disconnect if peer goes away
    useEffect(() => {
        if (remote.connectedPeerId && !connectedPeer) {
            remote.disconnect();
            setShowDevices(true);
        }
    }, [remote.connectedPeerId, connectedPeer, remote]);

    const handleConnect = useCallback((peerId: string) => {
        remote.connectToPeer(peerId);
        setShowDevices(false);
    }, [remote]);

    const handleDisconnect = useCallback(() => {
        remote.disconnect();
        setShowDevices(true);
    }, [remote]);

    // Determine what controls to show
    const snapshot = remote.snapshot;
    const hasControls = snapshot && (isMixerSnapshot(snapshot) || isDAWSnapshot(snapshot) || isEditorSnapshot(snapshot));
    const noHostsAvailable = availablePeers.filter(p => p.page !== "idle").length === 0;

    return (
        <div className="flex flex-col h-full bg-[oklch(0.10_0.01_260)] text-white overflow-hidden">
            {/* Header */}
            <div className="flex items-center gap-3 px-4 py-3 border-b border-white/[0.06] shrink-0">
                <div className="flex items-center gap-2 flex-1 min-w-0">
                    <Smartphone className="w-4 h-4 text-white/40 shrink-0" />
                    <h1 className="text-sm font-semibold text-white/70 truncate">Remote Control</h1>
                    {availablePeers.length > 0 && (
                        <span className="px-1.5 py-0.5 rounded-full bg-white/[0.06] text-[9px] tabular-nums text-white/40">
                            {availablePeers.length} device{availablePeers.length !== 1 ? "s" : ""}
                        </span>
                    )}
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                    {/* Size controls */}
                    <div className="flex items-center gap-0.5 rounded-lg border border-white/[0.06] bg-white/[0.02] px-0.5 py-0.5">
                        <button
                            onClick={() => changeScale(-1)}
                            disabled={uiScale <= SCALE_STEPS[0]}
                            className={cn(
                                "flex items-center justify-center w-6 h-6 rounded transition-colors cursor-pointer",
                                uiScale <= SCALE_STEPS[0] ? "text-white/10" : "text-white/40 hover:text-white/60 hover:bg-white/5",
                            )}
                            title="Decrease size"
                        >
                            <ZoomOut className="w-3.5 h-3.5" />
                        </button>
                        <button
                            onClick={resetScale}
                            className="px-1 text-[9px] tabular-nums text-white/35 hover:text-white/60 transition-colors cursor-pointer min-w-[32px] text-center"
                            title="Reset to 100%"
                        >
                            {Math.round(uiScale * 100)}%
                        </button>
                        <button
                            onClick={() => changeScale(1)}
                            disabled={uiScale >= SCALE_STEPS[SCALE_STEPS.length - 1]}
                            className={cn(
                                "flex items-center justify-center w-6 h-6 rounded transition-colors cursor-pointer",
                                uiScale >= SCALE_STEPS[SCALE_STEPS.length - 1] ? "text-white/10" : "text-white/40 hover:text-white/60 hover:bg-white/5",
                            )}
                            title="Increase size"
                        >
                            <ZoomIn className="w-3.5 h-3.5" />
                        </button>
                    </div>

                    {/* Device list toggle */}
                    <button
                        onClick={() => setShowDevices(!showDevices)}
                        className={cn(
                            "flex items-center justify-center w-8 h-8 rounded-lg transition-colors cursor-pointer",
                            showDevices ? "bg-white/10 text-white/60" : "text-white/30 hover:text-white/50 hover:bg-white/5",
                        )}
                        title="Show devices"
                    >
                        <LayoutGrid className="w-4 h-4" />
                    </button>

                    {/* Focus mode */}
                    <button
                        onClick={toggleFocusMode}
                        className={cn(
                            "flex items-center justify-center w-8 h-8 rounded-lg transition-colors cursor-pointer",
                            isFocusMode ? "bg-purple-500/20 text-purple-400" : "text-white/30 hover:text-white/50 hover:bg-white/5",
                        )}
                        title={isFocusMode ? "Exit focus mode" : "Focus mode"}
                    >
                        {isFocusMode ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
                    </button>
                </div>
            </div>

            {/* Connection status bar */}
            <div className="px-4 py-2 shrink-0">
                <ConnectionBar peer={connectedPeer} latency={remote.latency} onDisconnect={handleDisconnect} />
            </div>

            {/* Content */}
            <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden" style={{ zoom: uiScale }}>
                {/* Device picker panel */}
                {showDevices && (
                    <div className="px-4 py-3 border-b border-white/[0.04]">
                        <div className="flex items-center gap-2 mb-3">
                            <Signal className="w-3.5 h-3.5 text-white/30" />
                            <span className="text-xs font-medium text-white/40 uppercase tracking-wider">Available Devices</span>
                        </div>

                        {availablePeers.length === 0 ? (
                            <div className="flex items-center gap-3 px-4 py-6 rounded-xl border border-dashed border-white/[0.06] bg-white/[0.01]">
                                <WifiOff className="w-5 h-5 text-white/15 shrink-0" />
                                <div>
                                    <p className="text-xs text-white/30">No devices found</p>
                                    <p className="text-[10px] text-white/15 mt-0.5">Open Mixer, DAW or Sound Editor in another tab</p>
                                </div>
                            </div>
                        ) : (
                            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                                {availablePeers.map(peer => (
                                    <PeerCard
                                        key={peer.id}
                                        peer={peer}
                                        isConnected={peer.id === remote.connectedPeerId}
                                        onConnect={() => handleConnect(peer.id)}
                                    />
                                ))}
                            </div>
                        )}
                    </div>
                )}

                {/* Controls area */}
                {!hasControls && (
                    <WaitingState
                        message={
                            noHostsAvailable
                                ? "Waiting for a device..."
                                : connectedPeer
                                    ? `Connected to ${connectedPeer.label} — waiting for state...`
                                    : "Select a device to connect"
                        }
                    />
                )}

                {hasControls && isMixerSnapshot(snapshot) && (
                    <MixerRemoteWidget snapshot={snapshot} sendCommand={remote.sendCommand} />
                )}

                {hasControls && isDAWSnapshot(snapshot) && (
                    <DAWRemoteWidget snapshot={snapshot} sendCommand={remote.sendCommand} />
                )}

                {hasControls && isEditorSnapshot(snapshot) && (
                    <EditorRemoteWidget snapshot={snapshot} sendCommand={remote.sendCommand} />
                )}
            </div>
        </div>
    );
}
