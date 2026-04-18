"use client";

/**
 * useRemoteLiveHost — broadcasts LiveEngine state to remote peers
 * and handles incoming commands.
 *
 * Performance: the broadcast rAF loop only runs while a peer is actually
 * connected. The `live` context value is read through a ref so the effect
 * doesn't re-subscribe (and re-create the rAF loop) on every state change.
 * Realtime meter values are pulled from the meters store, not from `live`.
 */

import { useEffect, useRef } from "react";
import { useLive } from "@/components/live/live-context";
import { liveMetersStore } from "@/components/live/live-meters-store";
import { useRemoteOptional, type CommandHandler } from "@/components/remote/remote-context";
import type { LiveSnapshot, LiveLooperSnapshot, LivePadSnapshot, VPSnapshot } from "@/lib/remote-sync";
import type { FxType } from "@/lib/audio-fx-engine";

export function useRemoteLiveHost() {
    const live = useLive();
    const remote = useRemoteOptional();
    const liveRef = useRef(live);
    liveRef.current = live;

    const connectedPeerId = remote?.connectedPeerId ?? null;
    const broadcastState = remote?.broadcastState;
    const onCommand = remote?.onCommand;

    // Broadcast state at ~10fps — only while a peer is connected. Pauses when
    // the tab is hidden. Reads `live` through a ref so we don't tear down and
    // rebuild the loop on every Provider re-render.
    useEffect(() => {
        if (!connectedPeerId || !broadcastState) return;

        let raf = 0;
        let lastBroadcast = 0;
        const BROADCAST_INTERVAL_MS = 100;

        const tick = () => {
            const now = performance.now();
            if (now - lastBroadcast >= BROADCAST_INTERVAL_MS) {
                lastBroadcast = now;
                const live = liveRef.current;
                const m = liveMetersStore.getSnapshot();

                const loopers: LiveLooperSnapshot[] = live.loopers.map(l => ({
                    id: l.id,
                    state: l.state,
                    durationBeats: l.durationBeats,
                    positionBeats: 0,
                    volume: l.volume,
                    muted: l.muted,
                }));

                const pads: LivePadSnapshot[] = live.pads.map(p => ({
                    id: p.id,
                    name: p.name,
                    color: p.color,
                    hasAudio: !!p.buffer,
                    isPlaying: p.isPlaying,
                    volume: p.volume,
                    loop: p.loop,
                }));

                const voice: VPSnapshot | null = live.voiceActive ? {
                    isActive: live.voiceActive,
                    inputGain: live.voiceInputGain,
                    outputGain: live.voiceOutputGain,
                    selectedKey: live.keyIndex,
                    selectedScale: live.scaleIndex,
                    chain: live.voiceChain.map(c => ({
                        id: c.id,
                        type: c.type,
                        enabled: c.enabled,
                        params: { ...c.params },
                    })),
                    peakL: m.voicePeakL,
                    peakR: m.voicePeakR,
                    rms: 0,
                    pitchNote: m.tunerNote,
                    pitchCents: m.tunerCents,
                    pitchConfidence: m.tunerConfidence,
                } : null;

                const snap: LiveSnapshot = {
                    page: "live",
                    masterVolume: live.masterVolume,
                    monitorVolume: live.monitorVolume,
                    masterPeakL: m.masterPeakL,
                    masterPeakR: m.masterPeakR,
                    isLimiting: m.isLimiting,
                    tempo: live.tempo,
                    isMetronomeOn: live.isMetronomeOn,
                    metronomeMonitorOnly: live.metronomeMonitorOnly,
                    keyIndex: live.keyIndex,
                    scaleIndex: live.scaleIndex,
                    isRecording: live.isRecording,
                    recordingDuration: m.recordingDuration,
                    backingLoaded: live.backingLoaded,
                    backingName: live.backingName,
                    backingIsPlaying: live.backingIsPlaying,
                    backingPosition: m.backingPosition,
                    backingDuration: live.backingDuration,
                    backingVolume: live.backingVolume,
                    backingTempoRatio: live.backingTempoRatio,
                    backingPitchSemis: live.backingPitchSemis,
                    backingLoopActive: live.backingLoopActive,
                    voice,
                    loopers,
                    activeLooperId: live.activeLooperId,
                    looperBeatLength: live.looperBeatLength,
                    pads,
                    tunerNote: m.tunerNote,
                    tunerCents: m.tunerCents,
                    tunerFrequency: m.tunerFrequency,
                    tunerConfidence: m.tunerConfidence,
                    tapCount: 0,
                    songs: [],
                    activeSongId: null,
                    // Compact spectrum/waveform for the remote visualizer widget.
                    // Generated on demand from the engine's hi-res analyser; cheap
                    // (~64 bytes/frame) and downsampled to be visualization-ready.
                    spectrum: live.engine?.getCompactSpectrum(32),
                    waveform: live.engine?.getCompactWaveform(32),
                };

                broadcastState(snap);
            }
            raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);

        const onVisibility = () => {
            if (document.hidden) {
                if (raf) { cancelAnimationFrame(raf); raf = 0; }
            } else if (raf === 0) {
                raf = requestAnimationFrame(tick);
            }
        };
        document.addEventListener("visibilitychange", onVisibility);

        return () => {
            document.removeEventListener("visibilitychange", onVisibility);
            if (raf) cancelAnimationFrame(raf);
        };
    }, [connectedPeerId, broadcastState]);

    // Handle commands
    useEffect(() => {
        if (!onCommand) return;
        const handler: CommandHandler = (action, args, ack) => {
            const live = liveRef.current;
            try {
                const [ns, method] = action.split(".");
                if (ns !== "live") return;

                switch (method) {
                    // Master / global
                    case "setMasterVolume": live.setMasterVolume(args[0] as number); break;
                    case "setMonitorVolume": live.setMonitorVolume(args[0] as number); break;
                    case "setTempo": live.setTempo(args[0] as number); break;
                    case "setKey": live.setKey(args[0] as number); break;
                    case "setScale": live.setScale(args[0] as number); break;
                    case "tap": live.tapBpm(); break;
                    case "toggleMetronome": live.toggleMetronome(); break;
                    case "setMetronomeMonitorOnly": live.setMetronomeMonitorOnly(args[0] as boolean); break;
                    case "setMetronomeVolume": live.setMetronomeVolume(args[0] as number); break;
                    case "toggleRecording": live.toggleRecording(); break;

                    // Backing track
                    case "backingToggle": live.backingToggle(); break;
                    case "backingStop": live.backingStop(); break;
                    case "backingSeek": live.backingSeek(args[0] as number); break;
                    case "setBackingVolume": live.setBackingVolume(args[0] as number); break;
                    case "setBackingTempoRatio": live.setBackingTempoRatio(args[0] as number); break;
                    case "setBackingPitchSemis": live.setBackingPitchSemis(args[0] as number); break;
                    case "setBackingLoop": live.setBackingLoop(args[0] as boolean); break;

                    // Voice
                    case "voiceStart": void live.voiceStart(args[0] as string | undefined); break;
                    case "voiceStop": void live.voiceStop(); break;
                    case "voiceSetInputGain": live.voiceSetInputGain(args[0] as number); break;
                    case "voiceSetOutputGain": live.voiceSetOutputGain(args[0] as number); break;
                    case "voiceAddEffect": live.voiceAddEffect(args[0] as FxType); break;
                    case "voiceRemoveEffect": live.voiceRemoveEffect(args[0] as string); break;
                    case "voiceToggleEffect": live.voiceToggleEffect(args[0] as string); break;
                    case "voiceUpdateParam": live.voiceUpdateParam(args[0] as string, args[1] as string, args[2] as number); break;
                    case "voiceClearChain": live.voiceClearChain(); break;

                    // Looper
                    case "toggleLooper": live.toggleLooper(args[0] as number); break;
                    case "clearLooper": live.clearLooper(args[0] as number); break;
                    case "setLooperVolume": live.setLooperVolume(args[0] as number, args[1] as number); break;
                    case "toggleLooperMute": live.toggleLooperMute(args[0] as number); break;
                    case "setLooperBeatLength": live.setLooperBeatLength(args[0] as number); break;
                    case "stopAllLoopers": live.stopAllLoopers(); break;

                    // Pads
                    case "triggerPad": live.triggerPad(args[0] as number); break;
                    case "stopPad": live.stopPad(args[0] as number); break;
                    case "setPadVolume": live.setPadVolume(args[0] as number, args[1] as number); break;
                    case "setPadLoop": live.setPadLoop(args[0] as number, args[1] as boolean); break;
                    case "clearPad": live.clearPad(args[0] as number); break;

                    default: ack(false, `Unknown live command: ${method}`); return;
                }
                ack(true);
            } catch (e) {
                ack(false, String(e));
            }
        };
        return onCommand(handler);
    }, [onCommand]);
}
