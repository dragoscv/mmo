"use client";

import { useRef, useCallback } from "react";
import type { AudioData } from "./visualizations/types";

const BEAT_THRESHOLD = 1.4;
const BEAT_COOLDOWN = 200; // ms

export function useAudioAnalyzer() {
    const freqDataRef = useRef<Uint8Array | null>(null);
    const timeDataRef = useRef<Uint8Array | null>(null);
    const prevBassRef = useRef(0);
    const lastBeatRef = useRef(0);

    const getAudioData = useCallback((analyser: AnalyserNode | null): AudioData => {
        const empty: AudioData = {
            frequency: new Uint8Array(0),
            timeDomain: new Uint8Array(0),
            bass: 0, mid: 0, treble: 0, volume: 0,
            beat: false, beatIntensity: 0,
        };
        if (!analyser) return empty;

        const bufLen = analyser.frequencyBinCount;

        // Reuse typed arrays for performance
        if (!freqDataRef.current || freqDataRef.current.length !== bufLen) {
            freqDataRef.current = new Uint8Array(bufLen);
        }
        if (!timeDataRef.current || timeDataRef.current.length !== bufLen) {
            timeDataRef.current = new Uint8Array(bufLen);
        }

        analyser.getByteFrequencyData(freqDataRef.current as Uint8Array);
        analyser.getByteTimeDomainData(timeDataRef.current as Uint8Array);

        const freq = freqDataRef.current;
        const time = timeDataRef.current;

        // Calculate band energies
        // Bass: bins 0-10 (~0-430Hz at 44100/2048)
        // Mid: bins 10-100 (~430-4300Hz)
        // Treble: bins 100-512 (~4300-22050Hz)
        const bassEnd = Math.min(10, bufLen);
        const midEnd = Math.min(100, bufLen);

        let bassSum = 0, midSum = 0, trebleSum = 0, totalSum = 0;
        for (let i = 0; i < bufLen; i++) {
            const v = freq[i];
            totalSum += v;
            if (i < bassEnd) bassSum += v;
            else if (i < midEnd) midSum += v;
            else trebleSum += v;
        }

        const bass = bassSum / (bassEnd * 255);
        const mid = midSum / ((midEnd - bassEnd) * 255);
        const treble = trebleSum / ((bufLen - midEnd) * 255);
        const volume = totalSum / (bufLen * 255);

        // Beat detection
        const now = performance.now();
        const beatEnergy = bass;
        const prevBass = prevBassRef.current;
        const beat = beatEnergy > prevBass * BEAT_THRESHOLD
            && beatEnergy > 0.15
            && (now - lastBeatRef.current) > BEAT_COOLDOWN;

        if (beat) lastBeatRef.current = now;
        prevBassRef.current = bass * 0.7 + prevBass * 0.3; // Smooth

        return {
            frequency: freq,
            timeDomain: time,
            bass, mid, treble, volume,
            beat,
            beatIntensity: Math.min(1, beatEnergy * 2),
        };
    }, []);

    return { getAudioData };
}
