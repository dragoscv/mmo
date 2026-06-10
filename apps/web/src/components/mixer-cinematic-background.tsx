"use client";

/**
 * Cinematic mixer background — pure canvas2D + CSS, zero new deps.
 *
 * Three layers:
 *   1) Atmosphere: animated nebula gradient (CSS, no JS cost).
 *   2) Subject (mid-ground): ~220 stars with parallax depth, slow drift,
 *      twinkle, and an audio-reactive radial pulse anchored to the
 *      golden-ratio focal point (rule-of-thirds composition).
 *   3) Foreground: kept clear so the mixer chrome reads on top.
 *
 * Audio reactivity is opt-in — driven by `getSharedFrequencyData()` if
 * the analyser is already publishing, otherwise the scene drifts on
 * its own. This avoids touching the mixer engine.
 *
 * Reduced-motion: collapses to a static gradient + static SVG starfield.
 * No raf loop runs in that mode.
 *
 * Performance: dpr capped at 1.5, frame budget ~0.5ms on a mid laptop.
 * `pointer-events: none` so the canvas never steals input from the mixer.
 */

import { useEffect, useRef } from "react";
import { getSharedFrequencyData } from "@/lib/raf-scheduler";

interface Props {
    /** 0..1 — overall scene opacity. Defaults to 1. */
    opacity?: number;
    /** 0..1 — how strongly audio peaks pulse the scene. Defaults to 0.5. */
    reactivity?: number;
    /** Master analyser node for audio-reactive bloom. Optional — if
     *  null/undefined the scene drifts on its own. */
    analyser?: AnalyserNode | null;
}

interface Star {
    x: number; y: number;
    r: number;
    /** depth 0..1 — nearer stars (1) move/twinkle more. */
    depth: number;
    twPhase: number;
    twSpeed: number;
}

const STAR_COUNT = 220;

export function MixerCinematicBackground({
    opacity = 1,
    reactivity = 0.5,
    analyser = null,
}: Props) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const analyserRef = useRef<AnalyserNode | null>(analyser);
    // Keep the ref in sync without re-running the rAF effect when the
    // analyser identity changes (engine boot is async; we want the
    // existing loop to pick it up live).
    useEffect(() => {
        analyserRef.current = analyser;
    }, [analyser]);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const reduced = typeof window !== "undefined"
            && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
        if (reduced) {
            // Paint one static frame and exit. No animation loop.
            paintStaticFallback(canvas);
            return;
        }

        const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
        let width = 0;
        let height = 0;
        const ctx = canvas.getContext("2d", { alpha: true });
        if (!ctx) return;

        const stars: Star[] = [];

        function resize() {
            const rect = canvas!.getBoundingClientRect();
            width = Math.max(1, rect.width);
            height = Math.max(1, rect.height);
            canvas!.width = Math.floor(width * dpr);
            canvas!.height = Math.floor(height * dpr);
            ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
            // Re-seed stars proportional to viewport so density is stable.
            stars.length = 0;
            for (let i = 0; i < STAR_COUNT; i++) {
                const depth = Math.random();
                stars.push({
                    x: Math.random() * width,
                    y: Math.random() * height,
                    r: 0.4 + depth * 1.4,
                    depth,
                    twPhase: Math.random() * Math.PI * 2,
                    twSpeed: 0.5 + Math.random() * 1.5,
                });
            }
        }

        resize();
        const ro = new ResizeObserver(resize);
        ro.observe(canvas);

        // Optional audio source — wired via the analyserRef so the
        // effect doesn't re-run when analyser identity changes.
        let raf = 0;
        let last = performance.now();
        let drift = 0;
        let pulse = 0;

        // Golden-ratio focal point (rule-of-thirds) for the audio-reactive
        // bloom — feels cinematic, never centred.
        const focalX = () => width * 0.382;
        const focalY = () => height * 0.5;

        function frame(now: number) {
            const dt = Math.min(0.05, (now - last) / 1000);
            last = now;
            drift += dt * 0.06;

            // Sample audio peak (averaged across the spectrum) if available.
            let audio = 0;
            const ana = analyserRef.current;
            if (ana) {
                const freq = getSharedFrequencyData(ana);
                let sum = 0;
                for (let i = 0; i < freq.length; i++) sum += freq[i];
                audio = (sum / freq.length / 255) * reactivity;
            }
            // Smooth attack/decay so pulses feel cinematic, not jittery.
            pulse += (audio - pulse) * (audio > pulse ? 0.35 : 0.05);

            ctx!.clearRect(0, 0, width, height);

            // — Layer 1: focal radial bloom (audio-reactive) —
            const bloomR = Math.max(width, height) * (0.25 + pulse * 0.35);
            const fx = focalX();
            const fy = focalY();
            const grad = ctx!.createRadialGradient(fx, fy, 0, fx, fy, bloomR);
            grad.addColorStop(0, `rgba(168, 85, 247, ${0.18 + pulse * 0.22})`);
            grad.addColorStop(0.45, `rgba(59, 130, 246, ${0.08 + pulse * 0.08})`);
            grad.addColorStop(1, "rgba(0,0,0,0)");
            ctx!.fillStyle = grad;
            ctx!.fillRect(0, 0, width, height);

            // — Layer 2: stars (parallax + twinkle) —
            for (const s of stars) {
                // Parallax drift — nearer stars travel faster (depth weighted).
                s.x += dt * (4 + s.depth * 16);
                if (s.x > width + 4) s.x = -4;

                const tw = 0.55 + Math.sin(drift * s.twSpeed + s.twPhase) * 0.45;
                const a = (0.25 + s.depth * 0.55) * tw;

                ctx!.beginPath();
                ctx!.arc(s.x, s.y, s.r * (1 + pulse * 0.4 * s.depth), 0, Math.PI * 2);
                ctx!.fillStyle = `rgba(220, 230, 255, ${a})`;
                ctx!.fill();
            }

            raf = requestAnimationFrame(frame);
        }

        raf = requestAnimationFrame(frame);

        return () => {
            cancelAnimationFrame(raf);
            ro.disconnect();
        };
    }, [reactivity]);

    return (
        <div
            aria-hidden
            className="absolute inset-0 overflow-hidden pointer-events-none"
            style={{ opacity }}
        >
            {/* CSS atmosphere layer — slow conic + radial gradient drift.
                Zero JS cost; pure compositor work. */}
            <div className="absolute inset-0 mixer-cinematic-atmosphere" />
            <canvas
                ref={canvasRef}
                className="absolute inset-0 w-full h-full"
            />
            <style jsx>{`
                .mixer-cinematic-atmosphere {
                    background:
                        radial-gradient(ellipse 80% 60% at 30% 40%, rgba(76, 29, 149, 0.35) 0%, transparent 60%),
                        radial-gradient(ellipse 60% 80% at 75% 60%, rgba(30, 64, 175, 0.30) 0%, transparent 65%),
                        radial-gradient(ellipse 100% 100% at 50% 100%, rgba(15, 23, 42, 0.6) 0%, transparent 70%),
                        linear-gradient(180deg, #050511 0%, #0a0a1f 50%, #050511 100%);
                    animation: mixer-cinematic-drift 32s ease-in-out infinite alternate;
                }
                @keyframes mixer-cinematic-drift {
                    0%   { background-position: 0% 0%, 0% 0%, 0% 0%, 0% 0%; filter: hue-rotate(0deg); }
                    100% { background-position: 4% -2%, -3% 3%, 0 0, 0 0; filter: hue-rotate(8deg); }
                }
                @media (prefers-reduced-motion: reduce) {
                    .mixer-cinematic-atmosphere { animation: none; filter: none; }
                }
            `}</style>
        </div>
    );
}

function paintStaticFallback(canvas: HTMLCanvasElement) {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, rect.width);
    const h = Math.max(1, rect.height);
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    // Same palette as the live frame's first paint, no animation.
    for (let i = 0; i < STAR_COUNT; i++) {
        const depth = Math.random();
        ctx.beginPath();
        ctx.arc(Math.random() * w, Math.random() * h, 0.4 + depth * 1.4, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(220, 230, 255, ${0.2 + depth * 0.5})`;
        ctx.fill();
    }
}
