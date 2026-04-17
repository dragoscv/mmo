"use client";

/**
 * useRemoteMixerHost — broadcasts mixer state to remote peers
 * and handles incoming commands. Drop into the Mixer page.
 */

import { useEffect, useRef, useCallback } from "react";
import { useMixer } from "@/components/mixer-context";
import { useRemoteOptional, type CommandHandler } from "@/components/remote/remote-context";
import type { MixerSnapshot, MixerDeckSnapshot } from "@/lib/remote-sync";
import type { DeckState, DeckSide } from "@/lib/mixer-engine";

function deckToSnapshot(d: DeckState, track: { title: string; artist: string; artworkUrl: string | null } | null): MixerDeckSnapshot {
    return {
        trackId: d.trackId,
        trackTitle: track?.title || d.trackTitle || "",
        trackArtist: track?.artist || d.trackArtist || "",
        artworkUrl: track?.artworkUrl || d.trackArtworkUrl || null,
        isPlaying: d.isPlaying,
        isLoaded: d.isLoaded,
        currentTime: d.currentTime,
        duration: d.duration,
        bpm: d.bpm,
        originalBpm: d.originalBpm,
        key: d.key,
        volume: d.volume,
        eqLow: d.eqLow,
        eqMid: d.eqMid,
        eqHi: d.eqHi,
        eqLowKill: d.eqLowKill,
        eqMidKill: d.eqMidKill,
        eqHiKill: d.eqHiKill,
        filter: d.filter,
        filterType: d.filterType,
        colorFx: d.colorFx,
        colorFxType: d.colorFxType,
        beatFxOn: d.beatFxOn,
        beatFxType: d.beatFxType,
        beatFxAmount: d.beatFxAmount,
        beatFxBeatDiv: d.beatFxBeatDiv,
        loopEnabled: d.loopEnabled,
        loopBeats: d.loopBeats,
        hotCues: d.hotCues,
        headphoneCue: d.headphoneCue,
        padMode: d.padMode,
        slipMode: d.slipMode,
        quantize: d.quantize,
        keyLock: d.keyLock,
        keyShift: d.keyShift,
        crossfaderAssign: d.crossfaderAssign,
    };
}

export function useRemoteMixerHost() {
    const mixer = useMixer();
    const remote = useRemoteOptional();
    const rafRef = useRef(0);

    // Broadcast state at ~15fps
    useEffect(() => {
        if (!remote) return;
        let lastBroadcast = 0;

        const tick = () => {
            const now = Date.now();
            if (now - lastBroadcast >= 66) { // ~15fps
                lastBroadcast = now;
                const snap: MixerSnapshot = {
                    page: "mixer",
                    deckA: deckToSnapshot(mixer.deckA, mixer.deckATrack ? { title: mixer.deckATrack.title || "", artist: mixer.deckATrack.artist || "", artworkUrl: mixer.deckATrack.artworkUrl || null } : null),
                    deckB: deckToSnapshot(mixer.deckB, mixer.deckBTrack ? { title: mixer.deckBTrack.title || "", artist: mixer.deckBTrack.artist || "", artworkUrl: mixer.deckBTrack.artworkUrl || null } : null),
                    deckC: deckToSnapshot(mixer.deckC, mixer.deckCTrack ? { title: mixer.deckCTrack.title || "", artist: mixer.deckCTrack.artist || "", artworkUrl: mixer.deckCTrack.artworkUrl || null } : null),
                    deckD: deckToSnapshot(mixer.deckD, mixer.deckDTrack ? { title: mixer.deckDTrack.title || "", artist: mixer.deckDTrack.artist || "", artworkUrl: mixer.deckDTrack.artworkUrl || null } : null),
                    deckMode: mixer.deckMode,
                    crossfader: mixer.crossfader,
                    crossfaderCurve: mixer.crossfaderCurve,
                    masterVolume: mixer.masterVolume,
                    headphoneVolume: mixer.headphoneVolume,
                    headphoneMix: mixer.headphoneMix,
                    eqMode: mixer.eqMode,
                    tempoRange: mixer.tempoRange,
                    isRecording: mixer.isRecording,
                    recordingDuration: mixer.recordingDuration,
                    automixEnabled: mixer.automixEnabled,
                    samplerSlots: mixer.samplerSlots.map(s => ({
                        id: s.id,
                        name: s.name,
                        isPlaying: s.isPlaying,
                        volume: s.volume,
                        isLooping: s.isLooping,
                        hasAudio: s.buffer !== null,
                    })),
                };
                remote.broadcastState(snap);
            }
            rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(rafRef.current);
    }, [remote, mixer]);

    // Handle commands
    useEffect(() => {
        if (!remote) return;
        const handler: CommandHandler = (action, args, ack) => {
            try {
                const [ns, method] = action.split(".");
                if (ns !== "mixer") return;
                const deck = args[0] as DeckSide;

                switch (method) {
                    case "play": mixer.play(deck); break;
                    case "pause": mixer.pause(deck); break;
                    case "togglePlay": mixer.togglePlay(deck); break;
                    case "setVolume": mixer.setVolume(deck, args[1] as number); break;
                    case "setEQ": mixer.setEQ(deck, args[1] as "low" | "mid" | "hi", args[2] as number); break;
                    case "toggleEQKill": mixer.toggleEQKill(deck, args[1] as "low" | "mid" | "hi"); break;
                    case "setFilter": mixer.setFilter(deck, args[1] as number); break;
                    case "setCrossfader": mixer.setCrossfader(args[0] as number); break;
                    case "setMasterVolume": mixer.setMasterVolume(args[0] as number); break;
                    case "setHeadphoneVolume": mixer.setHeadphoneVolume(args[0] as number); break;
                    case "setHeadphoneMix": mixer.setHeadphoneMix(args[0] as number); break;
                    case "toggleHeadphoneCue": mixer.toggleHeadphoneCue(deck); break;
                    case "setColorFx": mixer.setColorFx(deck, args[1] as number); break;
                    case "setColorFxType": mixer.setColorFxType(deck, args[1] as string); break;
                    case "setBeatFxAmount": mixer.setBeatFxAmount(deck, args[1] as number); break;
                    case "setBeatFx": mixer.setBeatFx(deck, args[1] as string); break;
                    case "toggleBeatFx": mixer.toggleBeatFx(deck); break;
                    case "setBeatFxBeatDiv": mixer.setBeatFxBeatDiv(deck, args[1] as number); break;
                    case "setFilterType": mixer.setFilterType(deck, args[1] as string); break;
                    case "jumpHotCue": mixer.jumpHotCue(deck, args[1] as number); break;
                    case "setHotCue": mixer.setHotCue(deck, args[1] as number); break;
                    case "clearHotCue": mixer.clearHotCue(deck, args[1] as number); break;
                    case "setLoop": mixer.setLoop(deck, args[1] as number); break;
                    case "toggleLoop": mixer.toggleLoop(deck); break;
                    case "moveLoop": mixer.moveLoop(deck, args[1] as "left" | "right"); break;
                    case "nudge": mixer.nudge(deck, args[1] as number); break;
                    case "nudgeRelease": mixer.nudgeRelease(deck); break;
                    case "beatJump": mixer.beatJump(deck, args[1] as number); break;
                    case "syncBpm": mixer.syncBpm(deck); break;
                    case "setKeyShift": mixer.setKeyShift(deck, args[1] as number); break;
                    case "setKeyLock": mixer.setKeyLock(deck, args[1] as boolean); break;
                    case "toggleSlipMode": mixer.toggleSlipMode(deck); break;
                    case "toggleQuantize": mixer.toggleQuantize(deck); break;
                    case "setPadMode": mixer.setPadMode(deck, args[1] as string); break;
                    case "setCrossfaderAssign": mixer.setCrossfaderAssign(deck, args[1] as string); break;
                    case "ejectTrack": mixer.ejectTrack(deck); break;
                    // Global
                    case "setCrossfaderCurve": mixer.setCrossfaderCurve(args[0] as string); break;
                    case "setEQMode": mixer.setEQMode(args[0] as string); break;
                    case "setTempoRange": mixer.setTempoRange(args[0] as number); break;
                    case "setDeckMode": mixer.setDeckMode(args[0] as string); break;
                    case "toggleRecording": mixer.toggleRecording(); break;
                    case "toggleAutomix": mixer.toggleAutomix(); break;
                    // Sampler
                    case "triggerSampler": mixer.triggerSampler(args[0] as number); break;
                    case "stopSampler": mixer.stopSampler(args[0] as number); break;
                    case "toggleSamplerLoop": mixer.toggleSamplerLoop(args[0] as number); break;
                    default: ack(false, `Unknown mixer command: ${method}`); return;
                }
                ack(true);
            } catch (e) {
                ack(false, String(e));
            }
        };
        return remote.onCommand(handler);
    }, [remote, mixer]);
}
