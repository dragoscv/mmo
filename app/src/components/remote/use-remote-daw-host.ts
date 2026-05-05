"use client";

/**
 * useRemoteDAWHost — broadcasts DAW state to remote peers
 * and handles incoming commands.
 */

import { useEffect, useRef } from "react";
import { useDAW } from "@/components/daw/daw-context";
import { useRemoteOptional, type CommandHandler } from "@/components/remote/remote-context";
import type {
    DAWSnapshot,
    DAWTrackSnapshot,
    DAWSynthSnapshot,
    DAWStepSeqSnapshot,
    VPSnapshot,
} from "@/lib/remote-sync";

export function useRemoteDAWHost() {
    const daw = useDAW();
    const remote = useRemoteOptional();
    const rafRef = useRef(0);

    // Broadcast state at ~10fps
    useEffect(() => {
        if (!remote) return;
        let lastBroadcast = 0;

        const tick = () => {
            const now = Date.now();
            if (now - lastBroadcast >= 100) {
                lastBroadcast = now;

                const tracks: DAWTrackSnapshot[] = daw.project.tracks.map(t => ({
                    id: t.id,
                    name: t.name,
                    type: t.type,
                    color: t.color,
                    volume: t.volume,
                    pan: t.pan,
                    muted: t.muted,
                    soloed: t.soloed,
                    armed: t.armed,
                    peakL: t.peakL,
                    peakR: t.peakR,
                    inserts: t.inserts.map(ins => ({
                        id: ins.id,
                        type: ins.type,
                        enabled: ins.enabled,
                        params: { ...ins.params },
                    })),
                }));

                const sc = daw.synthConfig;
                const synth: DAWSynthSnapshot = {
                    oscillators: sc.oscillators.map(o => ({
                        type: o.type,
                        detune: o.detune,
                        octave: o.octave,
                        gain: o.gain,
                        enabled: o.enabled,
                    })),
                    filterType: sc.filterType,
                    filterCutoff: sc.filterCutoff,
                    filterResonance: sc.filterResonance,
                    filterEnvAmount: sc.filterEnvAmount,
                    ampAttack: sc.ampAttack,
                    ampDecay: sc.ampDecay,
                    ampSustain: sc.ampSustain,
                    ampRelease: sc.ampRelease,
                    filterAttack: sc.filterAttack,
                    filterDecay: sc.filterDecay,
                    filterSustain: sc.filterSustain,
                    filterRelease: sc.filterRelease,
                    lfoRate: sc.lfoRate,
                    lfoDepth: sc.lfoDepth,
                    lfoTarget: sc.lfoTarget,
                    lfoShape: sc.lfoShape,
                    reverbMix: sc.reverbMix,
                    delayMix: sc.delayMix,
                    delayTime: sc.delayTime,
                    masterGain: sc.masterGain,
                };

                const sp = daw.stepPattern;
                const stepSeq: DAWStepSeqSnapshot = {
                    steps: sp.steps,
                    swing: sp.swing,
                    tracks: sp.tracks.map(st => ({
                        id: st.id,
                        name: st.name,
                        steps: st.steps.map(s => ({ active: s.active, velocity: s.velocity })),
                        volume: st.volume,
                        pan: st.pan,
                        muted: st.muted,
                        soloed: st.soloed,
                        pitch: st.pitch,
                    })),
                };

                const snap: DAWSnapshot = {
                    page: "daw",
                    projectName: daw.project.name,
                    tempo: daw.project.tempo,
                    isPlaying: daw.isPlaying,
                    isRecording: daw.isRecording,
                    currentBeat: daw.currentBeat,
                    currentStepIndex: daw.currentStepIndex,
                    playbackMode: daw.playbackMode,
                    metronomeOn: daw.metronomeOn,
                    metronomeVolume: daw.metronomeVolume,
                    tracks,
                    masterPeakL: daw.masterPeakL,
                    masterPeakR: daw.masterPeakR,
                    masterVolume: daw.project.masterTrack?.volume ?? 1,
                    showVoiceProcessor: daw.showVoiceProcessor,
                    showEffectsRack: daw.showEffectsRack,
                    showSynth: daw.showSynth,
                    showStepSequencer: daw.showStepSequencer,
                    showMixer: daw.showMixer,
                    showPianoRoll: daw.showPianoRoll,
                    showAutomation: daw.showAutomation,
                    synth,
                    stepSeq,
                    selectedTrackId: daw.selectedTrackId,
                    tool: daw.tool,
                    snap: daw.snap,
                    vp: (() => {
                        const bridge = daw.getVPBridge();
                        if (!bridge) return null;
                        return bridge.getState();
                    })(),
                };
                remote.broadcastState(snap);
            }
            rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(rafRef.current);
    }, [remote, daw]);

    // Handle commands
    useEffect(() => {
        if (!remote) return;
        const handler: CommandHandler = (action, args, ack) => {
            try {
                const [ns, method] = action.split(".");
                if (ns !== "daw") return;

                switch (method) {
                    // Transport
                    case "play": daw.play(); break;
                    case "stop": daw.stop(); break;
                    case "pause": daw.pause(); break;
                    case "togglePlay": daw.togglePlay(); break;
                    case "record": daw.record(); break;
                    case "seek": daw.seek(args[0] as number); break;
                    case "setTempo": daw.setTempo(args[0] as number); break;
                    case "toggleMetronome": daw.toggleMetronome(); break;
                    case "setMetronomeVolume": daw.setMetronomeVolume(args[0] as number); break;
                    case "setPlaybackMode": daw.setPlaybackMode(args[0] as "pattern" | "song"); break;
                    case "togglePlaybackMode": daw.togglePlaybackMode(); break;
                    case "toggleLoop": daw.toggleLoop(); break;
                    case "setLoopRegion": daw.setLoopRegion(args[0] as number, args[1] as number); break;

                    // Tools
                    case "setTool": daw.setTool(args[0] as "select" | "draw" | "erase" | "slice" | "mute" | "automation"); break;
                    case "setSnap": daw.setSnap(args[0] as "1/1" | "1/2" | "1/4" | "1/8" | "1/16" | "1/32" | "none"); break;

                    // Track controls
                    case "setTrackVolume": daw.setTrackVolume(args[0] as string, args[1] as number); break;
                    case "setTrackPan": daw.setTrackPan(args[0] as string, args[1] as number); break;
                    case "toggleTrackMute": daw.toggleTrackMute(args[0] as string); break;
                    case "toggleTrackSolo": daw.toggleTrackSolo(args[0] as string); break;
                    case "toggleTrackArm": daw.toggleTrackArm(args[0] as string); break;

                    // Effects rack (per-track inserts)
                    case "toggleInsert": daw.toggleInsert(args[0] as string, args[1] as string); break;
                    case "setInsertParam": daw.setInsertParam(args[0] as string, args[1] as string, args[2] as string, args[3] as number); break;

                    // Master
                    case "setMasterVolume": daw.setMasterVolume(args[0] as number); break;

                    // Panels
                    case "togglePanel": daw.togglePanel(args[0] as "pianoRoll" | "mixer" | "stepSequencer" | "browser" | "effectsRack" | "synth" | "automation" | "history" | "clipboard" | "voiceProcessor"); break;

                    // Synth config
                    case "setSynthConfig": daw.setSynthConfig(args[0] as Record<string, unknown>); break;

                    // Step sequencer
                    case "toggleStep": daw.toggleStep(args[0] as number, args[1] as number); break;
                    case "setStepVelocity": daw.setStepVelocity(args[0] as number, args[1] as number, args[2] as number); break;
                    case "setPatternSteps": daw.setPatternSteps(args[0] as number); break;
                    case "setPatternSwing": daw.setPatternSwing(args[0] as number); break;
                    case "clearPattern": daw.clearPattern(); break;

                    // Undo/Redo
                    case "undo": daw.undo(); break;
                    case "redo": daw.redo(); break;

                    // Voice Processor
                    case "vpToggle": { const b = daw.getVPBridge(); if (b) b.handlers.toggleActive(); break; }
                    case "vpSetInputGain": { const b = daw.getVPBridge(); if (b) b.handlers.setInputGain(args[0] as number); break; }
                    case "vpSetOutputGain": { const b = daw.getVPBridge(); if (b) b.handlers.setOutputGain(args[0] as number); break; }
                    case "vpSetKey": { const b = daw.getVPBridge(); if (b) b.handlers.setKey(args[0] as number); break; }
                    case "vpSetScale": { const b = daw.getVPBridge(); if (b) b.handlers.setScale(args[0] as number); break; }
                    case "vpAddEffect": { const b = daw.getVPBridge(); if (b) b.handlers.addEffect(args[0] as Parameters<typeof b.handlers.addEffect>[0]); break; }
                    case "vpRemoveEffect": { const b = daw.getVPBridge(); if (b) b.handlers.removeEffect(args[0] as string); break; }
                    case "vpToggleEffect": { const b = daw.getVPBridge(); if (b) b.handlers.toggleEffect(args[0] as string); break; }
                    case "vpUpdateParam": { const b = daw.getVPBridge(); if (b) b.handlers.updateParam(args[0] as string, args[1] as string, args[2] as number); break; }
                    case "vpAutoDetect": { const b = daw.getVPBridge(); if (b) b.handlers.autoDetect(); break; }

                    default: ack(false, `Unknown daw command: ${method}`); return;
                }
                ack(true);
            } catch (e) {
                ack(false, String(e));
            }
        };
        return remote.onCommand(handler);
    }, [remote, daw]);
}
