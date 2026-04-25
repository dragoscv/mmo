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

    // Latest mixer via ref so the broadcast loop never has to be re-subscribed
    // when state changes (otherwise we'd tear down + rebuild the rAF/interval
    // every time currentTime ticks — a major source of long tasks during play).
    const mixerRef = useRef(mixer);
    mixerRef.current = mixer;

    // Broadcast state at 15 Hz, *only* when we actually have a remote
    // controller subscribed. Previously we ran a rAF loop at 60 fps just to
    // gate a 15 fps broadcast; that burned one callback per frame for nothing
    // and kept the tab awake during idle.
    const broadcast = remote?.broadcastState;
    useEffect(() => {
        if (!broadcast) return;
        let timer: ReturnType<typeof setInterval> | null = null;
        let lastHash = "";
        const tick = () => {
            const m = mixerRef.current;
            // Cheap change-detection hash — skip broadcast when nothing changed
            // (paused decks with a remote controller attached would otherwise
            // spam identical snapshots 15×/s).
            const h = `${m.deckA.currentTime}|${m.deckB.currentTime}|${m.deckC.currentTime}|${m.deckD.currentTime}|` +
                `${m.deckA.isPlaying}|${m.deckB.isPlaying}|${m.deckC.isPlaying}|${m.deckD.isPlaying}|` +
                `${m.crossfader}|${m.masterVolume}|${m.isRecording}|${m.recordingDuration}|${m.deckMode}|` +
                `${m.deckA.trackId}|${m.deckB.trackId}|${m.deckC.trackId}|${m.deckD.trackId}|${m.automixEnabled}`;
            if (h === lastHash) return;
            lastHash = h;
            const snap: MixerSnapshot = {
                page: "mixer",
                deckA: deckToSnapshot(m.deckA, m.deckATrack ? { title: m.deckATrack.title || "", artist: m.deckATrack.artist || "", artworkUrl: m.deckATrack.artworkUrl || null } : null),
                deckB: deckToSnapshot(m.deckB, m.deckBTrack ? { title: m.deckBTrack.title || "", artist: m.deckBTrack.artist || "", artworkUrl: m.deckBTrack.artworkUrl || null } : null),
                deckC: deckToSnapshot(m.deckC, m.deckCTrack ? { title: m.deckCTrack.title || "", artist: m.deckCTrack.artist || "", artworkUrl: m.deckCTrack.artworkUrl || null } : null),
                deckD: deckToSnapshot(m.deckD, m.deckDTrack ? { title: m.deckDTrack.title || "", artist: m.deckDTrack.artist || "", artworkUrl: m.deckDTrack.artworkUrl || null } : null),
                deckMode: m.deckMode,
                crossfader: m.crossfader,
                crossfaderCurve: m.crossfaderCurve,
                masterVolume: m.masterVolume,
                headphoneVolume: m.headphoneVolume,
                headphoneMix: m.headphoneMix,
                eqMode: m.eqMode,
                tempoRange: m.tempoRange,
                isRecording: m.isRecording,
                recordingDuration: m.recordingDuration,
                automixEnabled: m.automixEnabled,
                samplerSlots: m.samplerSlots.map(s => ({
                    id: s.id,
                    name: s.name,
                    isPlaying: s.isPlaying,
                    volume: s.volume,
                    isLooping: s.isLooping,
                    hasAudio: s.buffer !== null,
                })),
            };
            broadcast(snap);
        };
        timer = setInterval(tick, 66); // ~15 Hz
        return () => { if (timer) clearInterval(timer); };
    }, [broadcast]);

    // Handle commands — subscribe once, dispatch through the ref so we
    // never re-subscribe (previously this tore down + rebuilt the handler
    // on every state change, which is many times per second during play).
    const onCommand = remote?.onCommand;
    useEffect(() => {
        if (!onCommand) return;
        const handler: CommandHandler = (action, args, ack) => {
            const mixer = mixerRef.current;
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
        return onCommand(handler);
    }, [onCommand]);
}
