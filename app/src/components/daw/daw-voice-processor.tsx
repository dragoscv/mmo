"use client";

import { useCallback, useEffect, useRef, useState, useMemo } from "react";
import { createPortal } from "react-dom";
import {
    Mic, MicOff, Volume2, VolumeX, Settings2, ChevronDown, Plus, Trash2,
    Power, GripVertical, Save, FolderOpen, RotateCcw, Music, Activity,
    Gauge, Radio, Waves, Zap, Loader2, Sparkles, Wand2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
    AudioFxEngine,
    FX_DEFAULTS,
    FX_CATEGORIES,
    MUSICAL_SCALES,
    NOTE_NAMES,
    type FxInsert,
    type FxPreset,
    type FxType,
    type PitchInfo,
    type LiveMeterData,
    type LatencyInfo,
} from "@/lib/audio-fx-engine";
import { formatNoteIndex, formatNoteMulti, type NoteNotation } from "@/lib/note-notation";
import { useDAWSettings } from "@/hooks/use-daw-settings";
import { useDAW } from "@/components/daw/daw-context";
import type { VPBridge, VPRemoteState, VPCommandHandlers } from "@/components/daw/daw-context";

// ─── Types ───────────────────────────────────────────────────────────────

interface VoiceProcessorProps {
    className?: string;
    /** If provided, connect output to this destination instead of speakers */
    destinationNode?: AudioNode;
    /** Shared AudioContext */
    audioContext?: AudioContext;
    /** Compact mode for DAW panel */
    compact?: boolean;
}

// ─── Pitch Visualization Helpers ─────────────────────────────────────────

function noteToColor(noteIndex: number): string {
    const hue = ((noteIndex % 12) / 12) * 360;
    return `oklch(0.7 0.18 ${hue})`;
}

function centsToAngle(cents: number): number {
    return (cents / 50) * 45; // ±50 cents → ±45°
}

// ─── Key / Scale / Auto Helpers ──────────────────────────────────────────

const SCALE_QUALITY: Record<number, "major" | "minor" | "both"> = {
    0: "both",    // Chromatic
    1: "major",   // Major (Ionian)
    2: "minor",   // Minor (Aeolian)
    3: "major",   // Pentatonic Major
    4: "minor",   // Pentatonic Minor
    5: "minor",   // Blues
    6: "minor",   // Dorian
    7: "major",   // Mixolydian
    8: "minor",   // Harmonic Minor
};

function getScaleNotes(key: number, scaleIdx: number): Set<number> {
    const scale = MUSICAL_SCALES[scaleIdx];
    if (!scale) return new Set(Array.from({ length: 12 }, (_, i) => i));
    return new Set(scale.intervals.map(i => (key + i) % 12));
}

function getNearestInScaleNotes(notePC: number, scaleNotes: Set<number>): number[] {
    if (scaleNotes.has(notePC)) return [notePC];
    const result: number[] = [];
    for (let offset = 1; offset <= 6; offset++) {
        const up = (notePC + offset) % 12;
        const down = ((notePC - offset) + 12) % 12;
        if (scaleNotes.has(up)) result.push(up);
        if (scaleNotes.has(down) && down !== up) result.push(down);
        if (result.length > 0) return result;
    }
    return [];
}

interface Recommendation {
    type: "success" | "warning" | "info" | "tip";
    text: string;
}

function generateRecommendations(
    pitch: PitchInfo,
    rms: number,
    peakL: number,
    peakR: number,
    key: number,
    scale: number,
    notations: NoteNotation[] = ["anglo"],
): Recommendation[] {
    const recs: Recommendation[] = [];
    const rmsDb = rms > 0 ? 20 * Math.log10(rms) : -60;
    const fn = (idx: number) => formatNoteMulti(idx, notations);

    // Level feedback
    if (rmsDb < -40) {
        recs.push({ type: "warning", text: "Input level is very low. Move closer to the mic or increase input gain." });
    } else if (peakL > 0.95 || peakR > 0.95) {
        recs.push({ type: "warning", text: "Input is clipping! Reduce input gain or move back from the mic." });
    }

    // Pitch feedback
    if (pitch.confidence < 0.5 || pitch.frequency === 0) {
        if (rmsDb > -35) {
            recs.push({ type: "info", text: "No clear pitch detected. Try singing a sustained note." });
        }
        return recs;
    }

    const notePC = ((pitch.noteIndex % 12) + 12) % 12;
    const scaleNotes = getScaleNotes(key, scale);
    const scaleName = MUSICAL_SCALES[scale]?.name || "Chromatic";
    const keyName = fn(key);

    if (scaleNotes.has(notePC)) {
        recs.push({ type: "success", text: `${pitch.note} is in ${keyName} ${scaleName} — great note choice!` });
    } else {
        const nearest = getNearestInScaleNotes(notePC, scaleNotes);
        const names = nearest.map(n => fn(n)).join(" or ");
        recs.push({ type: "warning", text: `${pitch.note} is outside ${keyName} ${scaleName}. Try moving to ${names}.` });
    }

    // Intonation
    if (Math.abs(pitch.cents) <= 8) {
        recs.push({ type: "success", text: "Excellent intonation — right on pitch!" });
    } else if (pitch.cents > 8) {
        recs.push({ type: "info", text: `You're ~${pitch.cents} cents sharp. Relax slightly to lower your pitch.` });
    } else {
        recs.push({ type: "info", text: `You're ~${Math.abs(pitch.cents)} cents flat. More breath support will help.` });
    }

    // Scale-specific tips
    const root = fn(key);
    const fifth = fn((key + 7) % 12);
    switch (scale) {
        case 1: {
            const third = fn((key + 4) % 12);
            recs.push({ type: "tip", text: `In ${root} Major, emphasize ${root}, ${third}, and ${fifth} for strong melodic anchors.` });
            break;
        }
        case 2: {
            const third = fn((key + 3) % 12);
            recs.push({ type: "tip", text: `In ${root} Minor, use ${root}, ${third}, and ${fifth} as your melodic foundation.` });
            break;
        }
        case 3:
            recs.push({ type: "tip", text: `${root} Pentatonic Major is great for melodic improvisation — no wrong notes!` });
            break;
        case 4:
            recs.push({ type: "tip", text: `${root} Pentatonic Minor has no avoid notes — every note sounds great!` });
            break;
        case 5: {
            const blueNote = fn((key + 6) % 12);
            recs.push({ type: "tip", text: `The blue note (${blueNote}) in ${root} Blues adds tension — bend into it for expression.` });
            break;
        }
        case 6: {
            const sixth = fn((key + 9) % 12);
            recs.push({ type: "tip", text: `The raised 6th (${sixth}) gives ${root} Dorian its characteristic bright minor color.` });
            break;
        }
        case 7: {
            const seventh = fn((key + 10) % 12);
            recs.push({ type: "tip", text: `The flat 7th (${seventh}) gives ${root} Mixolydian its bluesy major feel.` });
            break;
        }
        case 8: {
            const seventh = fn((key + 11) % 12);
            recs.push({ type: "tip", text: `The raised 7th (${seventh}) creates dramatic tension in ${root} Harmonic Minor.` });
            break;
        }
    }

    return recs;
}

function autoDetectKeyAndScale(pitchHistory: PitchInfo[]): { key: number; scale: number; quality: "major" | "minor" } | null {
    const histogram = new Array(12).fill(0) as number[];
    for (const p of pitchHistory) {
        if (p.confidence > 0.5 && p.noteIndex >= 0) {
            histogram[((p.noteIndex % 12) + 12) % 12]++;
        }
    }
    const total = histogram.reduce((a, b) => a + b, 0);
    if (total < 5) return null;

    let bestKey = 0, bestScale = 1, bestScore = -Infinity;
    for (let k = 0; k < 12; k++) {
        for (const [sIdx, sc] of Object.entries(MUSICAL_SCALES)) {
            const si = Number(sIdx);
            if (si === 0) continue;
            const notes = new Set(sc.intervals.map(i => (k + i) % 12));
            let score = 0;
            for (let n = 0; n < 12; n++) {
                score += notes.has(n) ? histogram[n] * 2 : -histogram[n] * 1.5;
            }
            score += histogram[k] * 1.5; // Root note bonus
            if (score > bestScore) { bestScore = score; bestKey = k; bestScale = si; }
        }
    }
    const quality = [1, 3, 7].includes(bestScale) ? "major" as const : "minor" as const;
    return { key: bestKey, scale: bestScale, quality };
}

function analyzeSpectrumForEQ(spectrum: Float32Array, sampleRate: number): { low: number; mid: number; high: number } {
    if (spectrum.length === 0) return { low: 0, mid: 0, high: 0 };
    const binHz = (sampleRate / 2) / spectrum.length;
    let lS = 0, lN = 0, mS = 0, mN = 0, hS = 0, hN = 0;
    for (let i = 1; i < spectrum.length; i++) {
        const freq = i * binHz, db = spectrum[i];
        if (freq < 300) { lS += db; lN++; }
        else if (freq < 3000) { mS += db; mN++; }
        else if (freq < 10000) { hS += db; hN++; }
    }
    const lA = lN > 0 ? lS / lN : -100;
    const mA = mN > 0 ? mS / mN : -100;
    const hA = hN > 0 ? hS / hN : -100;
    return {
        low: Math.round(Math.max(-8, Math.min(8, (mA - lA) * 0.5))),
        mid: 0,
        high: Math.round(Math.max(-8, Math.min(8, (mA - hA) * 0.5))),
    };
}

function computeAvgCentsDeviation(pitchHistory: PitchInfo[]): number {
    const vals = pitchHistory.filter(p => p.confidence > 0.5).map(p => Math.abs(p.cents));
    return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
}

// ─── Component ───────────────────────────────────────────────────────────

export function VoiceProcessor({ className, destinationNode, audioContext, compact }: VoiceProcessorProps) {
    const engineRef = useRef<AudioFxEngine | null>(null);
    const rafRef = useRef<number>(0);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const spectrumRef = useRef<HTMLCanvasElement>(null);
    const { noteNotations } = useDAWSettings();

    // State
    const [inputDevices, setInputDevices] = useState<MediaDeviceInfo[]>([]);
    const [selectedDevice, setSelectedDevice] = useState("default");
    const [isActive, setIsActive] = useState(false);
    const [isLoading, setIsLoading] = useState(false);
    const [isMuted, setIsMuted] = useState(false);
    const [inputGain, setInputGain] = useState(1.0);
    const [outputGain, setOutputGain] = useState(0.8);
    const [monitorEnabled, setMonitorEnabled] = useState(true);

    // FX Chain
    const [chain, setChain] = useState<FxInsert[]>([]);
    const [presets, setPresets] = useState<FxPreset[]>([]);
    const [selectedPreset, setSelectedPreset] = useState<string>("");
    const [showPresetMenu, setShowPresetMenu] = useState(false);
    const [showAddFx, setShowAddFx] = useState(false);
    const presetBtnRef = useRef<HTMLButtonElement>(null);
    const addFxBtnRef = useRef<HTMLButtonElement>(null);

    // Metering
    const [meter, setMeter] = useState<LiveMeterData>({
        peakL: 0, peakR: 0, rms: 0,
        pitch: { frequency: 0, note: "—", noteIndex: -1, cents: 0, confidence: 0 },
        spectrum: new Float32Array(0),
        waveform: new Float32Array(0),
    });

    // Pitch history for visualization
    const pitchHistoryRef = useRef<PitchInfo[]>([]);
    const [latencyInfo, setLatencyInfo] = useState<LatencyInfo | null>(null);

    // Key / Scale selection
    const [selectedKey, setSelectedKey] = useState(0);                      // 0=C .. 11=B
    const [selectedQuality, setSelectedQuality] = useState<"major" | "minor">("major");
    const [selectedScale, setSelectedScale] = useState(1);                  // index in MUSICAL_SCALES
    // Auto-correct toggle: when on, we ensure an `autotune` insert is part of
    // the FX chain and the metering loop continuously updates its pitch ratio
    // so the detected note is snapped to the nearest in-scale note.
    const [autoCorrectOn, setAutoCorrectOn] = useState<boolean>(() => {
        if (typeof window === "undefined") return false;
        return localStorage.getItem("mmo-voice-autocorrect") === "1";
    });
    const [autoCorrectAmount, setAutoCorrectAmount] = useState<number>(() => {
        if (typeof window === "undefined") return 1;
        const raw = localStorage.getItem("mmo-voice-autocorrect-amount");
        const n = raw ? parseFloat(raw) : NaN;
        return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 1;
    });
    const [autoCorrectSpeed, setAutoCorrectSpeed] = useState<number>(() => {
        if (typeof window === "undefined") return 0.05;
        const raw = localStorage.getItem("mmo-voice-autocorrect-speed");
        const n = raw ? parseFloat(raw) : NaN;
        return Number.isFinite(n) ? Math.max(0.005, Math.min(0.5, n)) : 0.05;
    });
    const [recommendations, setRecommendations] = useState<Recommendation[]>([
        { type: "info", text: "Press the microphone button to start. Select your key and scale for personalized guidance." },
    ]);
    const selectedKeyRef = useRef(0);
    const selectedScaleRef = useRef(1);
    const meterRef = useRef(meter);
    const lastRecTimeRef = useRef(0);
    selectedKeyRef.current = selectedKey;
    selectedScaleRef.current = selectedScale;
    meterRef.current = meter;
    const noteNotationsRef = useRef(noteNotations);
    noteNotationsRef.current = noteNotations;

    // Auto-correct refs (for the rAF loop, which can't depend on render-time
    // state without re-subscribing every frame).
    const autoCorrectOnRef = useRef(false);
    const autoCorrectSpeedRef = useRef(0.05);
    const autotuneInsertIdRef = useRef<string | null>(null);
    autoCorrectOnRef.current = autoCorrectOn;
    autoCorrectSpeedRef.current = autoCorrectSpeed;

    // ─── Init Engine ─────────────────────────────────────────────────

    useEffect(() => {
        const engine = new AudioFxEngine(audioContext);
        engineRef.current = engine;

        if (destinationNode) {
            engine.output.connect(destinationNode);
        } else if (monitorEnabled) {
            engine.output.connect(engine.audioContext.destination);
        }

        // Load presets
        setPresets(AudioFxEngine.loadPresets());

        // Enumerate devices
        engine.enumerateInputDevices().then(setInputDevices).catch(() => { });

        return () => {
            cancelAnimationFrame(rafRef.current);
            engine.destroy();
            engineRef.current = null;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // ─── Monitor toggle ──────────────────────────────────────────────

    useEffect(() => {
        const engine = engineRef.current;
        if (!engine) return;
        engine.output.disconnect();
        if (destinationNode) {
            engine.output.connect(destinationNode);
        }
        if (monitorEnabled && !destinationNode) {
            engine.output.connect(engine.audioContext.destination);
        }
    }, [monitorEnabled, destinationNode]);

    // ─── Auto-correct: ensure an `autotune` insert is in the chain ───
    // Adds / removes / updates a single managed autotune insert based on the
    // toggle. The insert ID is tracked in a ref so the metering loop can push
    // live pitch corrections to it via the worklet node.
    useEffect(() => {
        try {
            localStorage.setItem("mmo-voice-autocorrect", autoCorrectOn ? "1" : "0");
            localStorage.setItem("mmo-voice-autocorrect-amount", String(autoCorrectAmount));
            localStorage.setItem("mmo-voice-autocorrect-speed", String(autoCorrectSpeed));
            window.dispatchEvent(new Event("mmo-preference-changed"));
        } catch { /* */ }

        const engine = engineRef.current;
        if (!engine) return;

        // Make sure the worklet is loaded so the insert actually shifts.
        void engine.ensurePitchWorkletLoaded();

        const existingIdx = chain.findIndex((i) => i.id === autotuneInsertIdRef.current);

        if (autoCorrectOn) {
            const params = {
                speed: autoCorrectSpeed,
                amount: autoCorrectAmount,
                key: selectedKey,
                scale: selectedScale,
            };
            if (existingIdx >= 0) {
                const next = chain.map((ins, i) =>
                    i === existingIdx ? { ...ins, enabled: true, params: { ...ins.params, ...params } } : ins,
                );
                setChain(next);
                engine.setChain(next);
            } else {
                const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
                autotuneInsertIdRef.current = id;
                const insert: FxInsert = {
                    id,
                    type: "autotune",
                    enabled: true,
                    params: { ...FX_DEFAULTS.autotune, ...params },
                };
                const next = [...chain, insert];
                setChain(next);
                engine.setChain(next);
            }
        } else if (existingIdx >= 0) {
            // Toggle the managed insert off (keep it in the chain so the user
            // can still find it under FX, but disabled).
            const next = chain.map((ins, i) =>
                i === existingIdx ? { ...ins, enabled: false } : ins,
            );
            setChain(next);
            engine.setChain(next);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [autoCorrectOn, autoCorrectAmount, autoCorrectSpeed, selectedKey, selectedScale]);

    // ─── Metering Loop ───────────────────────────────────────────────

    useEffect(() => {
        if (!isActive) return;
        const engine = engineRef.current;
        if (!engine) return;

        let running = true;
        const loop = () => {
            if (!running) return;
            const data = engine.getMeterData();
            setMeter(data);

            // ── Auto-correct: snap detected pitch to nearest in-scale note
            // by setting the pitch-shifter worklet's pitchRatio. The shifter
            // smooths the parameter via setTargetAtTime so a fast `speed`
            // value gives hard "T-Pain" snap, slow values give natural drift.
            if (autoCorrectOnRef.current && autotuneInsertIdRef.current) {
                const node = engine.getPitchShifterNode(autotuneInsertIdRef.current);
                if (node) {
                    const ratioParam = node.parameters.get("pitchRatio");
                    if (ratioParam) {
                        const p = data.pitch;
                        let ratio = 1;
                        if (p.confidence > 0.5 && p.frequency > 0) {
                            const detectedMidi =
                                12 * Math.log2(p.frequency / 440) + 69; // float
                            const pc = ((Math.round(detectedMidi) % 12) + 12) % 12;
                            const scaleNotes = getScaleNotes(
                                selectedKeyRef.current,
                                selectedScaleRef.current,
                            );
                            // Find the in-scale note nearest to the detected
                            // float MIDI (handles the "between notes" case).
                            let bestMidi = Math.round(detectedMidi);
                            if (!scaleNotes.has(pc)) {
                                let bestDelta = Infinity;
                                for (let off = 1; off <= 6; off++) {
                                    const up = ((pc + off) % 12 + 12) % 12;
                                    const down = (((pc - off) % 12) + 12) % 12;
                                    if (scaleNotes.has(up)) {
                                        const cand = Math.round(detectedMidi) + off;
                                        const d = Math.abs(cand - detectedMidi);
                                        if (d < bestDelta) { bestDelta = d; bestMidi = cand; }
                                    }
                                    if (scaleNotes.has(down)) {
                                        const cand = Math.round(detectedMidi) - off;
                                        const d = Math.abs(cand - detectedMidi);
                                        if (d < bestDelta) { bestDelta = d; bestMidi = cand; }
                                    }
                                    if (bestDelta < Infinity && off >= 2) break;
                                }
                            }
                            const semis = bestMidi - detectedMidi;
                            ratio = Math.pow(2, semis / 12);
                            // Clamp to worklet's parameter range.
                            ratio = Math.max(0.5, Math.min(2, ratio));
                        }
                        const tau = Math.max(0.005, autoCorrectSpeedRef.current);
                        ratioParam.setTargetAtTime(ratio, engine.audioContext.currentTime, tau);
                    }
                }
            }

            // Track pitch history (last 60 values)
            if (data.pitch.confidence > 0.5) {
                pitchHistoryRef.current = [...pitchHistoryRef.current.slice(-59), data.pitch];
            }

            // Update recommendations (throttled to 500ms)
            const now = performance.now();
            if (now - lastRecTimeRef.current > 500) {
                lastRecTimeRef.current = now;
                setRecommendations(generateRecommendations(
                    data.pitch, data.rms, data.peakL, data.peakR,
                    selectedKeyRef.current, selectedScaleRef.current,
                    noteNotationsRef.current,
                ));
            }

            // Draw waveform canvas
            drawWaveform(data.waveform);
            drawSpectrum(data.spectrum);

            rafRef.current = requestAnimationFrame(loop);
        };
        rafRef.current = requestAnimationFrame(loop);
        return () => { running = false; cancelAnimationFrame(rafRef.current); };
    }, [isActive]);

    // ─── Drawing ─────────────────────────────────────────────────────

    const drawWaveform = useCallback((waveform: Float32Array) => {
        const canvas = canvasRef.current;
        if (!canvas || waveform.length === 0) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        const w = canvas.width;
        const h = canvas.height;
        ctx.clearRect(0, 0, w, h);

        // Background gradient
        const grad = ctx.createLinearGradient(0, 0, 0, h);
        grad.addColorStop(0, "rgba(139, 92, 246, 0.03)");
        grad.addColorStop(0.5, "rgba(0, 0, 0, 0)");
        grad.addColorStop(1, "rgba(139, 92, 246, 0.03)");
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, w, h);

        // Center line
        ctx.strokeStyle = "rgba(255,255,255,0.04)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, h / 2);
        ctx.lineTo(w, h / 2);
        ctx.stroke();

        // Waveform
        const step = waveform.length / w;
        ctx.beginPath();
        for (let i = 0; i < w; i++) {
            const idx = Math.floor(i * step);
            const v = waveform[idx];
            const y = (1 - v) * h / 2;
            if (i === 0) ctx.moveTo(i, y);
            else ctx.lineTo(i, y);
        }
        ctx.strokeStyle = "oklch(0.7 0.2 280 / 0.7)";
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // Glow fill
        ctx.lineTo(w, h / 2);
        ctx.lineTo(0, h / 2);
        ctx.closePath();
        const fillGrad = ctx.createLinearGradient(0, 0, 0, h);
        fillGrad.addColorStop(0, "oklch(0.7 0.2 280 / 0.15)");
        fillGrad.addColorStop(0.5, "oklch(0.7 0.2 280 / 0.02)");
        fillGrad.addColorStop(1, "oklch(0.7 0.2 280 / 0.15)");
        ctx.fillStyle = fillGrad;
        ctx.fill();
    }, []);

    const drawSpectrum = useCallback((spectrum: Float32Array) => {
        const canvas = spectrumRef.current;
        if (!canvas || spectrum.length === 0) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        const w = canvas.width;
        const h = canvas.height;
        ctx.clearRect(0, 0, w, h);

        const barCount = 64;
        const barWidth = w / barCount;
        const logMax = Math.log10(spectrum.length);

        for (let i = 0; i < barCount; i++) {
            // Logarithmic frequency mapping
            const logIdx = Math.pow(10, (i / barCount) * logMax);
            const idx = Math.min(Math.floor(logIdx), spectrum.length - 1);
            const db = spectrum[idx];
            const normalized = Math.max(0, (db + 100) / 80); // -100dB to -20dB range
            const barH = normalized * h;

            const hue = 260 + (i / barCount) * 60; // Purple to pink gradient
            ctx.fillStyle = `oklch(0.65 0.18 ${hue} / ${0.3 + normalized * 0.5})`;
            ctx.fillRect(i * barWidth + 1, h - barH, barWidth - 2, barH);

            // Bright top cap
            if (barH > 2) {
                ctx.fillStyle = `oklch(0.8 0.2 ${hue} / 0.8)`;
                ctx.fillRect(i * barWidth + 1, h - barH, barWidth - 2, 2);
            }
        }
    }, []);

    // ─── Actions ─────────────────────────────────────────────────────

    const toggleActive = useCallback(async () => {
        const engine = engineRef.current;
        if (!engine) return;

        if (isActive) {
            await engine.stopInput();
            setIsActive(false);
            setLatencyInfo(null);
            pitchHistoryRef.current = [];
            setRecommendations([{ type: "info", text: "Press the microphone button to start. Select your key and scale for personalized guidance." }]);
        } else {
            setIsLoading(true);
            const ok = await engine.startInput(selectedDevice);
            setIsLoading(false);
            if (ok) {
                engine.input.gain.value = inputGain;
                engine.setChain(chain);
                setIsActive(true);
                setLatencyInfo(engine.getLatencyInfo());
            }
        }
    }, [isActive, selectedDevice, inputGain, chain]);

    const handleDeviceChange = useCallback(async (deviceId: string) => {
        setSelectedDevice(deviceId);
        if (isActive) {
            const engine = engineRef.current;
            if (engine) {
                await engine.stopInput();
                engine.input.gain.value = inputGain;
                await engine.startInput(deviceId);
            }
        }
    }, [isActive, inputGain]);

    const handleInputGainChange = useCallback((val: number) => {
        setInputGain(val);
        const engine = engineRef.current;
        if (engine) engine.input.gain.value = val;
    }, []);

    const handleOutputGainChange = useCallback((val: number) => {
        setOutputGain(val);
        const engine = engineRef.current;
        if (engine) engine.output.gain.value = val;
    }, []);

    const addEffect = useCallback((type: FxType) => {
        const insert: FxInsert = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            type,
            enabled: true,
            params: { ...FX_DEFAULTS[type] },
        };
        const newChain = [...chain, insert];
        setChain(newChain);
        engineRef.current?.setChain(newChain);
        setShowAddFx(false);
    }, [chain]);

    const removeEffect = useCallback((id: string) => {
        const newChain = chain.filter(i => i.id !== id);
        setChain(newChain);
        engineRef.current?.setChain(newChain);
    }, [chain]);

    const toggleEffect = useCallback((id: string) => {
        const newChain = chain.map(i => i.id === id ? { ...i, enabled: !i.enabled } : i);
        setChain(newChain);
        engineRef.current?.setChain(newChain);
    }, [chain]);

    const updateParam = useCallback((insertId: string, param: string, value: number) => {
        const newChain = chain.map(i => i.id === insertId ? { ...i, params: { ...i.params, [param]: value } } : i);
        setChain(newChain);
        engineRef.current?.updateInsertParam(insertId, param, value);
    }, [chain]);

    const loadPreset = useCallback((preset: FxPreset) => {
        const newChain = preset.chain.map(i => ({
            ...i,
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            params: { ...i.params },
        }));
        setChain(newChain);
        setSelectedPreset(preset.id);
        engineRef.current?.setChain(newChain);
        setShowPresetMenu(false);
    }, []);

    const saveAsPreset = useCallback(() => {
        const name = prompt("Preset name:");
        if (!name) return;
        const preset = AudioFxEngine.createPreset(name, "voice", chain);
        const updated = [...presets, preset];
        setPresets(updated);
        AudioFxEngine.savePresets(updated);
        setSelectedPreset(preset.id);
    }, [chain, presets]);

    // ─── Key / Scale Handlers ────────────────────────────────────────

    const handleQualityChange = useCallback((quality: "major" | "minor") => {
        setSelectedQuality(quality);
        const currentQ = SCALE_QUALITY[selectedScale];
        if (currentQ !== "both" && currentQ !== quality) {
            const eq: Record<number, number> = { 1: 2, 2: 1, 3: 4, 4: 3, 6: 7, 7: 6, 5: 4, 8: 2 };
            const mapped = eq[selectedScale];
            if (mapped !== undefined && (SCALE_QUALITY[mapped] === quality || SCALE_QUALITY[mapped] === "both")) {
                setSelectedScale(mapped);
            } else {
                setSelectedScale(quality === "major" ? 1 : 2);
            }
        }
    }, [selectedScale]);

    const handleAutoDetect = useCallback(() => {
        const engine = engineRef.current;
        if (!engine) return;

        // Auto-detect key and scale from pitch history
        const detection = autoDetectKeyAndScale(pitchHistoryRef.current);
        if (detection) {
            setSelectedKey(detection.key);
            setSelectedScale(detection.scale);
            setSelectedQuality(detection.quality);
        }

        // Build intelligent effects chain
        const cid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const autoChain: FxInsert[] = [];
        const m = meterRef.current;

        // 1. Noise suppression
        autoChain.push({
            id: cid(), type: "noiseSuppression", enabled: true,
            params: { threshold: -35, reduction: 15, attack: 0.005, release: 0.05 },
        });

        // 2. EQ from spectrum analysis
        const eq = analyzeSpectrumForEQ(m.spectrum, engine.audioContext.sampleRate);
        autoChain.push({
            id: cid(), type: "eq3", enabled: true,
            params: { low: eq.low, mid: eq.mid, high: eq.high },
        });

        // 3. Autotune if pitch variance is high
        const variance = computeAvgCentsDeviation(pitchHistoryRef.current);
        const dk = detection?.key ?? selectedKeyRef.current;
        const ds = detection?.scale ?? selectedScaleRef.current;
        if (variance > 12) {
            autoChain.push({
                id: cid(), type: "autotune", enabled: true,
                params: { speed: variance > 25 ? 0.05 : 0.15, amount: 0.8, key: dk, scale: ds },
            });
        }

        // 4. Compressor
        const rmsDb = m.rms > 0 ? 20 * Math.log10(m.rms) : -60;
        autoChain.push({
            id: cid(), type: "compressor", enabled: true,
            params: {
                threshold: rmsDb > -20 ? -18 : -24,
                knee: 10, ratio: 3, attack: 0.01, release: 0.15,
                makeupGain: rmsDb < -30 ? 6 : 3,
            },
        });

        // 5. De-esser
        autoChain.push({
            id: cid(), type: "deEsser", enabled: true,
            params: { threshold: -25, frequency: 6500, ratio: 4 },
        });

        // 6. Limiter for safety if signal is loud
        if (m.peakL > 0.7 || m.peakR > 0.7) {
            autoChain.push({
                id: cid(), type: "limiter", enabled: true,
                params: { threshold: -2, release: 0.08 },
            });
        }

        setChain(autoChain);
        engine.setChain(autoChain);
        setSelectedPreset("");
    }, []);

    const scaleNotes = useMemo(() => getScaleNotes(selectedKey, selectedScale), [selectedKey, selectedScale]);

    const filteredScales = useMemo(() => {
        return Object.entries(MUSICAL_SCALES)
            .filter(([idx]) => {
                const q = SCALE_QUALITY[Number(idx)];
                return q === "both" || q === selectedQuality;
            })
            .map(([idx, scale]) => [Number(idx), scale] as [number, typeof scale]);
    }, [selectedQuality]);

    // ─── Pitch Display ───────────────────────────────────────────────

    const pitchDisplay = useMemo(() => {
        const p = meter.pitch;
        if (p.confidence < 0.5 || p.frequency === 0) {
            return { note: "—", octave: "", cents: 0, color: "rgba(255,255,255,0.1)", active: false };
        }
        const noteIdx = ((p.noteIndex % 12) + 12) % 12;
        const octave = Math.floor(p.noteIndex / 12) - 1;
        return {
            note: formatNoteMulti(noteIdx, noteNotations),
            octave: String(octave),
            cents: p.cents,
            color: noteToColor(p.noteIndex),
            active: true,
        };
    }, [meter.pitch, noteNotations]);

    // ─── Render ──────────────────────────────────────────────────────

    // ─── Remote Bridge Registration ──────────────────────────────────

    const daw = useDAW();
    const chainRef = useRef(chain);
    chainRef.current = chain;
    const isActiveRef = useRef(isActive);
    isActiveRef.current = isActive;
    const inputGainRef = useRef(inputGain);
    inputGainRef.current = inputGain;
    const outputGainRef = useRef(outputGain);
    outputGainRef.current = outputGain;

    useEffect(() => {
        const bridge: VPBridge = {
            getState: (): VPRemoteState => ({
                isActive: isActiveRef.current,
                inputGain: inputGainRef.current,
                outputGain: outputGainRef.current,
                selectedKey: selectedKeyRef.current,
                selectedScale: selectedScaleRef.current,
                chain: chainRef.current.map(fx => ({
                    id: fx.id,
                    type: fx.type,
                    enabled: fx.enabled,
                    params: { ...fx.params },
                })),
                peakL: meterRef.current.peakL,
                peakR: meterRef.current.peakR,
                rms: meterRef.current.rms,
                pitchNote: meterRef.current.pitch.note,
                pitchCents: meterRef.current.pitch.cents,
                pitchConfidence: meterRef.current.pitch.confidence,
            }),
            handlers: {
                toggleActive,
                setInputGain: handleInputGainChange,
                setOutputGain: handleOutputGainChange,
                setKey: setSelectedKey,
                setScale: setSelectedScale,
                addEffect,
                removeEffect,
                toggleEffect,
                updateParam,
                autoDetect: handleAutoDetect,
            },
        };
        daw.registerVPBridge(bridge);
        return () => daw.unregisterVPBridge();
    }, [daw, toggleActive, handleInputGainChange, handleOutputGainChange, addEffect, removeEffect, toggleEffect, updateParam, handleAutoDetect]);

    // ─── Actual Render ───────────────────────────────────────────────

    return (
        <div className={cn("flex flex-col h-full bg-[var(--daw-bg,#0a0a0f)] text-white", className)}>
            {/* Header */}
            <div className="flex items-center gap-2 px-3 py-2 border-b border-white/[0.06] bg-black/20">
                <div className="flex items-center gap-2 flex-1 min-w-0">
                    <button
                        onClick={toggleActive}
                        disabled={isLoading}
                        className={cn(
                            "flex items-center justify-center w-8 h-8 rounded-full transition-all duration-300",
                            isActive
                                ? "bg-red-500/20 text-red-400 shadow-[0_0_15px_rgba(239,68,68,0.3)] hover:bg-red-500/30"
                                : "bg-white/5 text-white/40 hover:bg-white/10 hover:text-white/60",
                            isLoading && "animate-pulse"
                        )}
                    >
                        {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : isActive ? <Mic className="w-4 h-4" /> : <MicOff className="w-4 h-4" />}
                    </button>

                    <span className="text-[11px] font-medium text-white/60 truncate">Voice Processor</span>

                    {isActive && (
                        <div className="flex items-center gap-1">
                            <div className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse shadow-[0_0_4px_rgba(239,68,68,0.5)]" />
                            <span className="text-[9px] text-red-400/70 font-mono">LIVE</span>
                        </div>
                    )}
                </div>

                {/* Input device selector */}
                <DropdownSelect
                    value={selectedDevice}
                    onChange={handleDeviceChange}
                    options={[
                        { value: "default", label: "Default Microphone" },
                        ...inputDevices.map(d => ({ value: d.deviceId, label: d.label || `Input ${d.deviceId.slice(0, 8)}` })),
                    ]}
                    className="max-w-[160px]"
                />

                {/* Monitor toggle */}
                <button
                    onClick={() => setMonitorEnabled(v => !v)}
                    className={cn(
                        "w-6 h-6 flex items-center justify-center rounded transition-colors",
                        monitorEnabled ? "text-green-400 bg-green-400/10" : "text-white/20 bg-white/5"
                    )}
                    title={monitorEnabled ? "Monitoring On" : "Monitoring Off"}
                >
                    {monitorEnabled ? <Volume2 className="w-3 h-3" /> : <VolumeX className="w-3 h-3" />}
                </button>
            </div>

            {/* Main content */}
            <div className="flex-1 overflow-y-auto overflow-x-hidden">
                {/* Pitch & Meter Display */}
                <div className="flex gap-3 px-3 py-3">
                    {/* Pitch indicator */}
                    <div className="flex-1 flex flex-col items-center justify-center min-h-[100px] rounded-lg bg-black/30 border border-white/[0.04] relative overflow-hidden">
                        {/* Background glow */}
                        {pitchDisplay.active && (
                            <div
                                className="absolute inset-0 opacity-20 transition-all duration-300"
                                style={{ background: `radial-gradient(ellipse at center, ${pitchDisplay.color} 0%, transparent 70%)` }}
                            />
                        )}
                        {/* Note display */}
                        <div className="relative z-10 flex items-baseline gap-0.5">
                            <span
                                className={cn(
                                    "text-4xl font-bold tracking-tight transition-all duration-200",
                                    pitchDisplay.active ? "opacity-100" : "opacity-10"
                                )}
                                style={{ color: pitchDisplay.active ? pitchDisplay.color : "white" }}
                            >
                                {pitchDisplay.note}
                            </span>
                            {pitchDisplay.octave && (
                                <span className="text-lg text-white/30 font-light">{pitchDisplay.octave}</span>
                            )}
                        </div>
                        {/* Cents meter */}
                        <div className="relative z-10 w-24 h-1.5 rounded-full bg-white/5 mt-2 overflow-hidden">
                            <div
                                className="absolute top-0 bottom-0 w-1 rounded-full transition-all duration-100"
                                style={{
                                    left: `${50 + pitchDisplay.cents}%`,
                                    background: pitchDisplay.active ? pitchDisplay.color : "rgba(255,255,255,0.1)",
                                    boxShadow: pitchDisplay.active ? `0 0 6px ${pitchDisplay.color}` : "none",
                                }}
                            />
                            <div className="absolute top-0 bottom-0 left-1/2 w-px bg-white/20" />
                        </div>
                        {/* Frequency */}
                        <span className="text-[9px] text-white/20 mt-1 font-mono">
                            {meter.pitch.frequency > 0 ? `${meter.pitch.frequency.toFixed(1)} Hz` : "— Hz"}
                        </span>
                    </div>

                    {/* Level meters */}
                    <div className="flex gap-1 items-end py-1">
                        <MeterBar value={meter.peakL} label="L" />
                        <MeterBar value={meter.peakR} label="R" />
                    </div>
                </div>

                {/* Waveform display */}
                <div className="px-3 pb-2">
                    <canvas
                        ref={canvasRef}
                        className="w-full rounded-md border border-white/[0.04] bg-black/20"
                        width={600}
                        height={compact ? 48 : 64}
                        style={{ height: compact ? 32 : 48 }}
                    />
                </div>

                {/* Spectrum display */}
                <div className="px-3 pb-2">
                    <canvas
                        ref={spectrumRef}
                        className="w-full rounded-md border border-white/[0.04] bg-black/20"
                        width={600}
                        height={compact ? 48 : 64}
                        style={{ height: compact ? 32 : 48 }}
                    />
                </div>

                {/* Latency info bar */}
                {latencyInfo && (
                    <div className="mx-3 mb-2 flex items-center justify-between gap-2 px-2 py-1 rounded bg-black/30 border border-white/[0.04]">
                        <div className="flex items-center gap-1.5">
                            <Zap className="w-3 h-3 text-yellow-400/60" />
                            <span className="text-[9px] text-white/30 uppercase tracking-wider">Latency</span>
                        </div>
                        <div className="flex items-center gap-3 text-[9px] font-mono">
                            <span className="text-white/40">
                                base <span className="text-yellow-400/80">{(latencyInfo.baseLatency * 1000).toFixed(1)}ms</span>
                            </span>
                            <span className="text-white/40">
                                out <span className="text-yellow-400/80">{(latencyInfo.outputLatency * 1000).toFixed(1)}ms</span>
                            </span>
                            <span className="text-white/40">
                                RTT <span className={cn(
                                    "font-semibold",
                                    latencyInfo.totalMs < 10 ? "text-green-400" :
                                        latencyInfo.totalMs < 20 ? "text-yellow-400" :
                                            "text-red-400"
                                )}>~{latencyInfo.totalMs.toFixed(1)}ms</span>
                            </span>
                            <span className="text-white/20">
                                {latencyInfo.bufferSize}smp @{(latencyInfo.sampleRate / 1000).toFixed(0)}k
                            </span>
                        </div>
                    </div>
                )}

                {/* Musical Key & Scale Selection */}
                <div className="px-3 pb-2">
                    <div className="flex items-center justify-between mb-2 gap-2">
                        <span className="text-[9px] text-white/30 uppercase tracking-wider flex items-center gap-1">
                            <Music className="w-3 h-3" /> Musical Key
                        </span>
                        <div className="flex items-center gap-1.5">
                            <button
                                onClick={() => setAutoCorrectOn((v) => !v)}
                                title={
                                    autoCorrectOn
                                        ? `Auto-correct ON — snapping to ${MUSICAL_SCALES[selectedScale]?.name ?? "selected"} scale`
                                        : "Snap detected pitch to the nearest note in the selected scale"
                                }
                                className={cn(
                                    "flex items-center gap-1 h-5 px-2 text-[9px] rounded-full transition-all border",
                                    autoCorrectOn
                                        ? "bg-emerald-500/25 text-emerald-200 border-emerald-500/40 shadow-[0_0_12px_rgba(16,185,129,0.25)]"
                                        : "bg-white/[0.04] text-white/45 border-white/10 hover:text-white/80 hover:bg-white/[0.08]",
                                )}
                            >
                                <Wand2 className="w-3 h-3" />
                                {autoCorrectOn ? "Auto-correct ON" : "Auto-correct"}
                            </button>
                            <button
                                onClick={handleAutoDetect}
                                className="flex items-center gap-1 h-5 px-2 text-[9px] bg-gradient-to-r from-purple-500/20 to-pink-500/20 text-purple-300/80 rounded-full hover:from-purple-500/30 hover:to-pink-500/30 transition-all border border-purple-500/20 hover:shadow-[0_0_12px_rgba(168,85,247,0.2)]"
                            >
                                <Sparkles className="w-3 h-3" /> Auto
                            </button>
                        </div>
                    </div>

                    {autoCorrectOn && (
                        <div className="mb-2 rounded-md border border-emerald-500/15 bg-emerald-500/[0.04] p-2 space-y-1.5">
                            <div className="flex items-center justify-between text-[9px] text-emerald-300/80">
                                <span className="uppercase tracking-wider">Speed</span>
                                <span className="tabular-nums">
                                    {autoCorrectSpeed < 0.02 ? "Hard snap" : autoCorrectSpeed < 0.1 ? "Fast" : autoCorrectSpeed < 0.25 ? "Natural" : "Slow"}
                                </span>
                            </div>
                            <input
                                type="range"
                                min={0.005}
                                max={0.5}
                                step={0.005}
                                value={autoCorrectSpeed}
                                onChange={(e) => setAutoCorrectSpeed(parseFloat(e.target.value))}
                                className="w-full accent-emerald-400"
                            />
                            <div className="flex items-center justify-between text-[9px] text-emerald-300/80">
                                <span className="uppercase tracking-wider">Amount</span>
                                <span className="tabular-nums">{Math.round(autoCorrectAmount * 100)}%</span>
                            </div>
                            <input
                                type="range"
                                min={0}
                                max={1}
                                step={0.01}
                                value={autoCorrectAmount}
                                onChange={(e) => setAutoCorrectAmount(parseFloat(e.target.value))}
                                className="w-full accent-emerald-400"
                            />
                        </div>
                    )}

                    {/* Key buttons */}
                    <div className="grid grid-cols-12 gap-0.5 mb-2">
                        {NOTE_NAMES.map((name, idx) => {
                            const isSelected = idx === selectedKey;
                            const inScale = scaleNotes.has(idx);
                            const displayName = formatNoteMulti(idx, noteNotations, undefined, "\n");
                            return (
                                <button
                                    key={idx}
                                    onClick={() => setSelectedKey(idx)}
                                    className={cn(
                                        "h-7 rounded text-[9px] font-medium transition-all duration-150 leading-tight whitespace-pre-line",
                                        isSelected
                                            ? "bg-purple-500 text-white shadow-[0_0_10px_rgba(168,85,247,0.4)]"
                                            : inScale
                                                ? "bg-white/10 text-white/70 hover:bg-white/15"
                                                : "bg-white/[0.03] text-white/20 hover:bg-white/[0.06]",
                                        name.includes("#") && !isSelected && "text-[8px]"
                                    )}
                                    title={formatNoteMulti(idx, noteNotations)}
                                >
                                    {noteNotations.length > 1
                                        ? formatNoteIndex(idx, noteNotations[0])
                                        : displayName}
                                </button>
                            );
                        })}
                    </div>

                    {/* Quality toggle + Scale selector */}
                    <div className="flex gap-2 mb-2">
                        <div className="flex rounded overflow-hidden border border-white/10">
                            {(["major", "minor"] as const).map(q => (
                                <button
                                    key={q}
                                    onClick={() => handleQualityChange(q)}
                                    className={cn(
                                        "px-3 py-1 text-[9px] font-medium transition-colors capitalize",
                                        selectedQuality === q
                                            ? "bg-purple-500/20 text-purple-300"
                                            : "bg-white/[0.03] text-white/30 hover:text-white/50"
                                    )}
                                >
                                    {q}
                                </button>
                            ))}
                        </div>
                        <DropdownSelect
                            value={selectedScale}
                            onChange={v => setSelectedScale(Number(v))}
                            options={filteredScales.map(([idx, scale]) => ({ value: String(idx), label: scale.name }))}
                            className="flex-1"
                        />
                    </div>

                    {/* In-key notes */}
                    <div className="flex items-center gap-1 flex-wrap">
                        <span className="text-[8px] text-white/20 uppercase tracking-wider mr-1">In key:</span>
                        {NOTE_NAMES.map((name, idx) => (
                            scaleNotes.has(idx) ? (
                                <span
                                    key={idx}
                                    className={cn(
                                        "text-[9px] px-1.5 py-0.5 rounded",
                                        idx === selectedKey
                                            ? "bg-purple-500/30 text-purple-300 font-semibold"
                                            : "bg-white/5 text-white/50"
                                    )}
                                >
                                    {formatNoteMulti(idx, noteNotations)}
                                </span>
                            ) : null
                        ))}
                    </div>
                </div>

                {/* Recommendations */}
                {recommendations.length > 0 && (
                    <div className="mx-3 mb-2 rounded-md border border-white/[0.04] bg-black/20 p-2 space-y-1.5">
                        <span className="text-[8px] text-white/20 uppercase tracking-wider">Recommendations</span>
                        {recommendations.map((rec, i) => (
                            <div
                                key={i}
                                className={cn(
                                    "text-[10px] leading-relaxed flex items-start gap-1.5",
                                    rec.type === "success" && "text-green-400/80",
                                    rec.type === "warning" && "text-amber-400/80",
                                    rec.type === "info" && "text-blue-400/70",
                                    rec.type === "tip" && "text-purple-300/60",
                                )}
                            >
                                <span className="flex-shrink-0 mt-0.5">
                                    {rec.type === "success" ? "✓" : rec.type === "warning" ? "⚠" : rec.type === "tip" ? "💡" : "ℹ"}
                                </span>
                                <span>{rec.text}</span>
                            </div>
                        ))}
                    </div>
                )}

                {/* Input / Output Gain */}
                <div className="px-3 pb-2 flex gap-3">
                    <div className="flex-1">
                        <label className="text-[9px] text-white/30 uppercase tracking-wider mb-1 block">Input Gain</label>
                        <input
                            type="range" min={0} max={2} step={0.01} value={inputGain}
                            onChange={e => handleInputGainChange(Number(e.target.value))}
                            className="w-full h-1 accent-purple-500"
                        />
                    </div>
                    <div className="flex-1">
                        <label className="text-[9px] text-white/30 uppercase tracking-wider mb-1 block">Output</label>
                        <input
                            type="range" min={0} max={1} step={0.01} value={outputGain}
                            onChange={e => handleOutputGainChange(Number(e.target.value))}
                            className="w-full h-1 accent-purple-500"
                        />
                    </div>
                </div>

                {/* Preset selector */}
                <div className="px-3 pb-2 flex gap-1">
                    <div className="relative flex-1">
                        <button
                            ref={presetBtnRef}
                            onClick={() => setShowPresetMenu(v => !v)}
                            className="w-full h-7 px-2 flex items-center justify-between text-[10px] bg-white/5 border border-white/10 rounded hover:bg-white/8 transition-colors"
                        >
                            <span className="truncate text-white/50">
                                {presets.find(p => p.id === selectedPreset)?.name || "Select Preset..."}
                            </span>
                            <ChevronDown className="w-3 h-3 text-white/30 flex-shrink-0" />
                        </button>
                        {showPresetMenu && (
                            <PresetMenu
                                presets={presets}
                                selectedId={selectedPreset}
                                onSelect={loadPreset}
                                onClose={() => setShowPresetMenu(false)}
                                anchorRef={presetBtnRef}
                            />
                        )}
                    </div>
                    <button onClick={saveAsPreset} className="h-7 px-2 text-[10px] bg-white/5 border border-white/10 rounded hover:bg-white/10 text-white/40" title="Save Preset">
                        <Save className="w-3 h-3" />
                    </button>
                    <button onClick={() => { setChain([]); setSelectedPreset(""); engineRef.current?.setChain([]); }} className="h-7 px-2 text-[10px] bg-white/5 border border-white/10 rounded hover:bg-white/10 text-white/40" title="Clear Chain">
                        <RotateCcw className="w-3 h-3" />
                    </button>
                </div>

                {/* Effects Chain */}
                <div className="px-3 pb-2">
                    <div className="flex items-center justify-between mb-1.5">
                        <span className="text-[9px] text-white/30 uppercase tracking-wider">Effects Chain</span>
                        <div className="relative">
                            <button
                                ref={addFxBtnRef}
                                onClick={() => setShowAddFx(v => !v)}
                                className="flex items-center gap-1 h-5 px-1.5 text-[9px] bg-purple-500/10 text-purple-400/70 rounded hover:bg-purple-500/20 transition-colors"
                            >
                                <Plus className="w-2.5 h-2.5" /> Add Effect
                            </button>
                            {showAddFx && (
                                <AddEffectMenu onAdd={addEffect} onClose={() => setShowAddFx(false)} anchorRef={addFxBtnRef} />
                            )}
                        </div>
                    </div>

                    {chain.length === 0 ? (
                        <div className="py-4 text-center text-[10px] text-white/15 border border-dashed border-white/[0.06] rounded-md">
                            No effects — add one or load a preset
                        </div>
                    ) : (
                        <div className="space-y-1">
                            {chain.map((insert, idx) => (
                                <FxInsertCard
                                    key={insert.id}
                                    insert={insert}
                                    index={idx}
                                    onToggle={() => toggleEffect(insert.id)}
                                    onRemove={() => removeEffect(insert.id)}
                                    onParamChange={(p, v) => updateParam(insert.id, p, v)}
                                />
                            ))}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

// ─── Sub-components ──────────────────────────────────────────────────────

function MeterBar({ value, label }: { value: number; label: string }) {
    const db = value > 0 ? 20 * Math.log10(value) : -60;
    const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
    const isClipping = db > -1;

    return (
        <div className="flex flex-col items-center gap-0.5">
            <div className="w-3 h-[80px] rounded-full bg-black/40 border border-white/[0.06] relative overflow-hidden">
                <div
                    className="absolute bottom-0 left-0 right-0 rounded-full transition-all duration-75"
                    style={{
                        height: `${pct}%`,
                        background: isClipping
                            ? "linear-gradient(0deg, #22c55e 0%, #eab308 60%, #ef4444 90%)"
                            : pct > 70
                                ? "linear-gradient(0deg, #22c55e 0%, #eab308 100%)"
                                : "linear-gradient(0deg, #22c55e 0%, #22c55e 100%)",
                    }}
                />
            </div>
            <span className="text-[7px] text-white/20">{label}</span>
        </div>
    );
}

function FxInsertCard({
    insert, index, onToggle, onRemove, onParamChange,
}: {
    insert: FxInsert;
    index: number;
    onToggle: () => void;
    onRemove: () => void;
    onParamChange: (param: string, value: number) => void;
}) {
    const [expanded, setExpanded] = useState(false);

    const fxLabel = insert.type.replace(/([A-Z])/g, " $1").replace(/^./, s => s.toUpperCase());

    const iconMap: Partial<Record<FxType, React.ReactNode>> = {
        compressor: <Gauge className="w-3 h-3" />,
        eq3: <Activity className="w-3 h-3" />,
        reverb: <Waves className="w-3 h-3" />,
        autotune: <Music className="w-3 h-3" />,
        distortion: <Zap className="w-3 h-3" />,
        noiseSuppression: <Radio className="w-3 h-3" />,
    };

    return (
        <div className={cn(
            "rounded-md border transition-colors",
            insert.enabled ? "border-white/[0.08] bg-white/[0.02]" : "border-white/[0.04] bg-black/20 opacity-50"
        )}>
            <div className="flex items-center gap-1.5 px-2 py-1.5">
                <GripVertical className="w-3 h-3 text-white/10 flex-shrink-0 cursor-grab" />
                <button onClick={onToggle} className={cn("w-4 h-4 flex items-center justify-center rounded-sm", insert.enabled ? "text-purple-400" : "text-white/15")}>
                    <Power className="w-3 h-3" />
                </button>
                <button onClick={() => setExpanded(v => !v)} className="flex-1 text-left flex items-center gap-1.5 min-w-0">
                    <span className="text-white/30">{iconMap[insert.type] || <Settings2 className="w-3 h-3" />}</span>
                    <span className="text-[10px] text-white/60 truncate">{fxLabel}</span>
                    <span className="text-[8px] text-white/15 ml-auto">{index + 1}</span>
                </button>
                <button onClick={onRemove} className="w-4 h-4 flex items-center justify-center text-white/10 hover:text-red-400 transition-colors">
                    <Trash2 className="w-2.5 h-2.5" />
                </button>
            </div>
            {expanded && (
                <div className="px-2 pb-2 pt-1 space-y-1.5 border-t border-white/[0.04]">
                    {Object.entries(insert.params).map(([key, val]) => (
                        <ParamSlider key={key} label={key} value={val} fxType={insert.type} param={key} onChange={v => onParamChange(key, v)} />
                    ))}
                </div>
            )}
        </div>
    );
}

function ParamSlider({ label, value, fxType, param, onChange }: {
    label: string; value: number; fxType: FxType; param: string; onChange: (v: number) => void;
}) {
    const { min, max, step } = getParamRange(fxType, param);
    const displayVal = param.includes("frequency") || param.includes("cutoff") || param.includes("freq")
        ? `${value >= 1000 ? `${(value / 1000).toFixed(1)}k` : Math.round(value)} Hz`
        : param.includes("threshold") || param.includes("gain") || param.includes("makeupGain")
            ? `${value.toFixed(1)} dB`
            : param.includes("time") || param.includes("attack") || param.includes("release") || param.includes("decay") || param.includes("preDelay")
                ? value < 0.1 ? `${(value * 1000).toFixed(0)} ms` : `${value.toFixed(2)} s`
                : param.includes("ratio")
                    ? `${value.toFixed(1)}:1`
                    : value.toFixed(2);

    return (
        <div className="flex items-center gap-2">
            <span className="text-[9px] text-white/25 w-16 truncate capitalize">{label.replace(/([A-Z])/g, " $1")}</span>
            <input
                type="range" min={min} max={max} step={step} value={value}
                onChange={e => onChange(Number(e.target.value))}
                className="flex-1 h-0.5 accent-purple-500"
            />
            <span className="text-[8px] text-white/20 w-14 text-right font-mono">{displayVal}</span>
        </div>
    );
}

function getParamRange(_fxType: FxType, param: string): { min: number; max: number; step: number } {
    if (param.includes("threshold")) return { min: -60, max: 0, step: 0.5 };
    if (param.includes("ratio")) return { min: 1, max: 20, step: 0.1 };
    if (param.includes("knee")) return { min: 0, max: 40, step: 1 };
    if (param.includes("attack")) return { min: 0.001, max: 0.5, step: 0.001 };
    if (param.includes("release") || param.includes("decay")) return { min: 0.01, max: 5, step: 0.01 };
    if (param.includes("frequency") || param.includes("cutoff") || param.includes("freq")) return { min: 20, max: 20000, step: 1 };
    if (param.includes("resonance") || param === "q1" || param === "q2" || param === "q3") return { min: 0.1, max: 30, step: 0.1 };
    if (param.includes("gain") && !param.includes("makeup")) return { min: -24, max: 24, step: 0.5 };
    if (param.includes("makeupGain")) return { min: -12, max: 24, step: 0.5 };
    if (param === "mix" || param === "depth" || param === "amount" || param === "drive" || param === "tone" || param === "damping" || param === "spread") return { min: 0, max: 1, step: 0.01 };
    if (param === "rate") return { min: 0.1, max: 20, step: 0.1 };
    if (param === "time" || param === "preDelay") return { min: 0.01, max: 5, step: 0.01 };
    if (param === "feedback") return { min: 0, max: 0.95, step: 0.01 };
    if (param === "bits") return { min: 1, max: 16, step: 1 };
    if (param === "sampleRate") return { min: 0.1, max: 1, step: 0.01 };
    if (param === "stages") return { min: 2, max: 12, step: 2 };
    if (param === "width") return { min: 0, max: 2, step: 0.01 };
    if (param === "low" || param === "mid" || param === "high") return { min: -12, max: 12, step: 0.5 };
    if (param === "key") return { min: 0, max: 11, step: 1 };
    if (param === "scale") return { min: 0, max: 8, step: 1 };
    if (param === "speed") return { min: 0, max: 1, step: 0.01 };
    if (param === "semitones") return { min: -24, max: 24, step: 1 };
    if (param === "cents") return { min: -100, max: 100, step: 1 };
    if (param === "reduction" || param === "bands") return { min: 1, max: 30, step: 1 };
    if (param === "type") return { min: 0, max: 3, step: 1 };
    return { min: 0, max: 1, step: 0.01 };
}

function AddEffectMenu({ onAdd, onClose, anchorRef }: { onAdd: (type: FxType) => void; onClose: () => void; anchorRef: React.RefObject<HTMLElement | null> }) {
    const ref = useRef<HTMLDivElement>(null);
    const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

    useEffect(() => {
        const handler = (e: PointerEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) onClose();
        };
        document.addEventListener("pointerdown", handler);
        return () => document.removeEventListener("pointerdown", handler);
    }, [onClose]);

    useEffect(() => {
        if (anchorRef.current) {
            const rect = anchorRef.current.getBoundingClientRect();
            setPos({ top: rect.bottom + 4, left: Math.max(4, rect.right - 224) });
        }
    }, [anchorRef]);

    const menu = (
        <div
            ref={ref}
            className="fixed z-[9999] w-56 rounded-lg border border-white/10 bg-[var(--daw-surface,#141418)] shadow-xl py-1 max-h-80 overflow-y-auto"
            style={pos ? { top: pos.top, left: pos.left } : { top: 0, left: -9999 }}
        >
            {Object.entries(FX_CATEGORIES).map(([key, cat]) => (
                <div key={key}>
                    <div className="px-3 pt-2 pb-0.5 text-[8px] text-white/20 uppercase tracking-widest">{cat.label}</div>
                    {cat.types.map(type => {
                        const label = type.replace(/([A-Z])/g, " $1").replace(/^./, s => s.toUpperCase());
                        return (
                            <button
                                key={type}
                                onClick={() => onAdd(type)}
                                className="w-full text-left px-3 py-1 text-[10px] text-white/50 hover:bg-purple-500/10 hover:text-white/80 transition-colors"
                            >
                                {label}
                            </button>
                        );
                    })}
                </div>
            ))}
        </div>
    );

    return createPortal(menu, document.body);
}

function PresetMenu({ presets, selectedId, onSelect, onClose, anchorRef }: {
    presets: FxPreset[]; selectedId: string; onSelect: (p: FxPreset) => void; onClose: () => void; anchorRef: React.RefObject<HTMLElement | null>;
}) {
    const ref = useRef<HTMLDivElement>(null);
    const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);

    useEffect(() => {
        const handler = (e: PointerEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) onClose();
        };
        document.addEventListener("pointerdown", handler);
        return () => document.removeEventListener("pointerdown", handler);
    }, [onClose]);

    useEffect(() => {
        if (anchorRef.current) {
            const rect = anchorRef.current.getBoundingClientRect();
            setPos({ top: rect.bottom + 4, left: rect.left, width: Math.max(224, rect.width) });
        }
    }, [anchorRef]);

    const grouped = useMemo(() => {
        const map = new Map<string, FxPreset[]>();
        for (const p of presets) {
            const list = map.get(p.category) || [];
            list.push(p);
            map.set(p.category, list);
        }
        return map;
    }, [presets]);

    const catLabels: Record<string, string> = {
        voice: "Voice",
        instrument: "Instrument",
        master: "Master",
        creative: "Creative",
        utility: "Utility",
    };

    const menu = (
        <div
            ref={ref}
            className="fixed z-[9999] rounded-lg border border-white/10 bg-[var(--daw-surface,#141418)] shadow-xl py-1 max-h-80 overflow-y-auto"
            style={pos ? { top: pos.top, left: pos.left, width: pos.width } : { top: 0, left: -9999 }}
        >
            {Array.from(grouped.entries()).map(([cat, list]) => (
                <div key={cat}>
                    <div className="px-3 pt-2 pb-0.5 text-[8px] text-white/20 uppercase tracking-widest">{catLabels[cat] || cat}</div>
                    {list.map(preset => (
                        <button
                            key={preset.id}
                            onClick={() => onSelect(preset)}
                            className={cn(
                                "w-full text-left px-3 py-1 text-[10px] transition-colors",
                                selectedId === preset.id
                                    ? "text-purple-400 bg-purple-500/10"
                                    : "text-white/50 hover:bg-white/5 hover:text-white/70"
                            )}
                        >
                            {preset.name}
                            {preset.id.startsWith("user_") && <span className="ml-1 text-[7px] text-white/15">USER</span>}
                        </button>
                    ))}
                </div>
            ))}
            {presets.length === 0 && (
                <div className="py-4 text-center text-[10px] text-white/20">No presets</div>
            )}
        </div>
    );

    return createPortal(menu, document.body);
}

// ─── Reusable portal-based dropdown (replaces native <select>) ───────────

interface DropdownOption {
    value: string;
    label: string;
}

function DropdownSelect({ value, onChange, options, className, placeholder }: {
    value: string | number;
    onChange: (value: string) => void;
    options: DropdownOption[];
    className?: string;
    placeholder?: string;
}) {
    const [open, setOpen] = useState(false);
    const btnRef = useRef<HTMLButtonElement>(null);
    const menuRef = useRef<HTMLDivElement>(null);
    const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);

    const selectedLabel = options.find(o => String(o.value) === String(value))?.label || placeholder || "Select...";

    useEffect(() => {
        if (!open) return;
        const handler = (e: PointerEvent) => {
            if (menuRef.current && !menuRef.current.contains(e.target as Node) &&
                btnRef.current && !btnRef.current.contains(e.target as Node)) {
                setOpen(false);
            }
        };
        document.addEventListener("pointerdown", handler);
        return () => document.removeEventListener("pointerdown", handler);
    }, [open]);

    useEffect(() => {
        if (open && btnRef.current) {
            const rect = btnRef.current.getBoundingClientRect();
            const spaceBelow = window.innerHeight - rect.bottom;
            const menuMaxH = 240;
            const top = spaceBelow > menuMaxH ? rect.bottom + 4 : rect.top - menuMaxH - 4;
            setPos({ top: Math.max(4, top), left: rect.left, width: Math.max(160, rect.width) });
        }
    }, [open]);

    return (
        <div className={cn("relative", className)}>
            <button
                ref={btnRef}
                onClick={() => setOpen(v => !v)}
                className="w-full h-7 px-2 flex items-center justify-between text-[10px] bg-white/5 border border-white/10 rounded hover:bg-white/8 transition-colors"
            >
                <span className="truncate text-white/50">{selectedLabel}</span>
                <ChevronDown className={cn("w-3 h-3 text-white/30 flex-shrink-0 transition-transform", open && "rotate-180")} />
            </button>
            {open && createPortal(
                <div
                    ref={menuRef}
                    className="fixed z-[9999] rounded-lg border border-white/10 bg-[var(--daw-surface,#141418)] shadow-xl py-1 max-h-60 overflow-y-auto"
                    style={pos ? { top: pos.top, left: pos.left, width: pos.width } : { top: 0, left: -9999 }}
                >
                    {options.map(opt => (
                        <button
                            key={opt.value}
                            onClick={() => { onChange(String(opt.value)); setOpen(false); }}
                            className={cn(
                                "w-full text-left px-3 py-1.5 text-[10px] transition-colors",
                                String(opt.value) === String(value)
                                    ? "text-purple-400 bg-purple-500/10"
                                    : "text-white/50 hover:bg-white/5 hover:text-white/70"
                            )}
                        >
                            {opt.label}
                        </button>
                    ))}
                    {options.length === 0 && (
                        <div className="py-3 text-center text-[10px] text-white/20">No options</div>
                    )}
                </div>,
                document.body,
            )}
        </div>
    );
}
