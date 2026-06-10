import { useEffect, useRef } from "react";
import type { DeckState } from "@/bridge/types";
import { useMixerStore } from "@/state/mixer-store";

interface WaveformProps {
    deck: DeckState;
    accent: string;
}

/**
 * Waveform overview. Renders real downsampled peaks computed at decode time
 * (stored per deck in the mixer store) with a played/unplayed split, the loop
 * region, hot-cue markers, and a playhead. Falls back to a faint procedural
 * pattern when no track is loaded so the layout reads during design.
 */
export function Waveform({ deck, accent }: WaveformProps) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const peaks = useMixerStore((s) => s.waveforms[deck.id]);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        const dpr = window.devicePixelRatio || 1;
        const resize = () => {
            const { clientWidth, clientHeight } = canvas;
            canvas.width = clientWidth * dpr;
            canvas.height = clientHeight * dpr;
        };
        resize();

        let raf = 0;
        const draw = () => {
            const w = canvas.width;
            const h = canvas.height;
            ctx.clearRect(0, 0, w, h);

            const mid = h / 2;
            const progress = deck.duration > 0 ? deck.position / deck.duration : 0;

            // Loop region shading.
            if (deck.loopActive && deck.duration > 0 && deck.loopEnd > deck.loopStart) {
                const x0 = (deck.loopStart / deck.duration) * w;
                const x1 = (deck.loopEnd / deck.duration) * w;
                ctx.fillStyle = "rgba(255, 196, 0, 0.16)";
                ctx.fillRect(x0, 0, x1 - x0, h);
            }

            const hasPeaks = peaks && peaks.length > 0;
            const bars = Math.floor(w / (3 * dpr));

            // Beatgrid lines (every beat from firstBeat at the detected BPM).
            if (deck.bpm > 0 && deck.duration > 0) {
                const beatSecs = 60 / deck.bpm;
                const maxBeats = Math.ceil(deck.duration / beatSecs);
                for (let b = 0; b < maxBeats; b++) {
                    const t = deck.firstBeat + b * beatSecs;
                    if (t > deck.duration) break;
                    const x = (t / deck.duration) * w;
                    // Emphasise every 4th beat (downbeat).
                    const downbeat = b % 4 === 0;
                    ctx.fillStyle = downbeat ? "rgba(255,255,255,0.22)" : "rgba(255,255,255,0.08)";
                    ctx.fillRect(x, 0, (downbeat ? 1.4 : 0.8) * dpr, h);
                }
            }

            for (let i = 0; i < bars; i++) {
                const x = i * 3 * dpr;
                const t = i / bars;
                let norm: number;
                if (hasPeaks) {
                    const idx = Math.min(peaks.length - 1, Math.floor(t * peaks.length));
                    norm = peaks[idx] ?? 0;
                } else {
                    const seed = Math.sin(i * 0.35) * 0.5 + Math.sin(i * 0.11) * 0.5;
                    norm = (0.25 + Math.abs(seed) * 0.7) * (deck.loaded ? 0.5 : 0.12);
                }
                const amp = Math.max(norm * mid, dpr);
                const played = t < progress;
                ctx.fillStyle = played ? accent : "rgba(255,255,255,0.22)";
                ctx.fillRect(x, mid - amp, 2 * dpr, amp * 2);
            }

            // Hot-cue markers.
            if (deck.duration > 0) {
                for (const c of deck.hotCues) {
                    if (c == null) continue;
                    const x = (c / deck.duration) * w;
                    ctx.fillStyle = "rgba(255,255,255,0.85)";
                    ctx.fillRect(x - dpr * 0.5, 0, dpr, h);
                    ctx.fillStyle = accent;
                    ctx.fillRect(x - dpr * 1.5, 0, dpr * 3, dpr * 4);
                }
            }

            // Playhead.
            ctx.fillStyle = "rgba(255,255,255,0.9)";
            ctx.fillRect(progress * w - dpr, 0, 2 * dpr, h);

            raf = requestAnimationFrame(draw);
        };
        draw();

        window.addEventListener("resize", resize);
        return () => {
            cancelAnimationFrame(raf);
            window.removeEventListener("resize", resize);
        };
    }, [deck, peaks, accent]);

    return (
        <canvas
            ref={canvasRef}
            style={{
                width: "100%",
                height: 72,
                display: "block",
                borderRadius: 10,
                background: "var(--bg-elev)",
                border: "1px solid var(--border)",
            }}
        />
    );
}
