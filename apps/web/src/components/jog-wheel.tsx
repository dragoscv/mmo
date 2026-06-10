"use client";

import { useRef, useEffect, useState, useCallback, memo } from "react";
import { useMixerActions } from "./mixer-context";
import { usePersonalization } from "@/hooks/use-personalization";
import type { DeckState, DeckSide } from "@/lib/mixer-engine";
import { useRenderCount } from "@/lib/dev-debugger";
import { useDeckCurrentTime } from "@/lib/mixer-time-store";
import { JOG_RENDERERS, type JogDesignProps } from "./jogwheel-designs";

// ─── Constants ───────────────────────────────────────────────────────────

const PROGRESS_R = 46;
const PROGRESS_C = 2 * Math.PI * PROGRESS_R;

// ─── Helpers ─────────────────────────────────────────────────────────────

function formatTime(s: number): string {
    if (!s || !isFinite(s)) return "0:00";
    const mins = Math.floor(s / 60);
    const secs = Math.floor(s % 60);
    return `${mins}:${secs.toString().padStart(2, "0")}`;
}

function formatTimeRemaining(current: number, duration: number): string {
    const rem = Math.max(0, duration - current);
    return `-${formatTime(rem)}`;
}

// ─── Tonearm Needle ──────────────────────────────────────────────────────
// Pivots from top-right corner, swings over the platter when playing

const Tonearm = memo(function Tonearm({ isPlaying, color, side }: { isPlaying: boolean; color: string; side: DeckSide }) {
    const isLeft = side === "A";
    return (
        <div
            className="absolute pointer-events-none z-10"
            style={{
                // Pivot point: top corner on the outside edge of the jog wheel
                top: "-6%",
                [isLeft ? "right" : "left"]: "-10%",
                width: "45%",
                height: "55%",
                transformOrigin: isLeft ? "95% 5%" : "5% 5%",
                transform: isPlaying
                    ? `rotate(${isLeft ? "25" : "-25"}deg)`
                    : `rotate(${isLeft ? "-30" : "30"}deg)`,
                transition: "transform 0.6s cubic-bezier(0.34, 1.56, 0.64, 1)",
            }}
        >
            <svg viewBox="0 0 60 80" className="w-full h-full" style={{ overflow: "visible" }}>
                {/* Pivot base (hinge) */}
                <circle
                    cx={isLeft ? 55 : 5} cy="4" r="4"
                    fill="rgba(60,60,60,0.9)"
                    stroke="rgba(255,255,255,0.15)"
                    strokeWidth="0.8"
                />
                {/* Arm */}
                <line
                    x1={isLeft ? 55 : 5} y1="4"
                    x2={isLeft ? 12 : 48} y2="62"
                    stroke="rgba(180,180,180,0.5)"
                    strokeWidth="2"
                    strokeLinecap="round"
                />
                {/* Secondary arm segment (slightly offset for 3D feel) */}
                <line
                    x1={isLeft ? 55 : 5} y1="4"
                    x2={isLeft ? 12 : 48} y2="62"
                    stroke="rgba(255,255,255,0.08)"
                    strokeWidth="3.5"
                    strokeLinecap="round"
                />
                {/* Headshell */}
                <rect
                    x={isLeft ? 6 : 42} y="58" width="12" height="6" rx="1.5"
                    fill="rgba(100,100,100,0.6)"
                    stroke="rgba(255,255,255,0.12)"
                    strokeWidth="0.5"
                />
                {/* Stylus tip — plain fill, no filter. `drop-shadow()` would
                    otherwise force an off-screen compositing layer per deck
                    on every frame the platter rotates. */}
                <circle
                    cx={isLeft ? 10 : 50} cy="68" r="1.5"
                    fill={isPlaying ? color : "rgba(255,255,255,0.3)"}
                    style={{ transition: "fill 0.3s" }}
                />
            </svg>
        </div>
    );
});

// ─── Progress Ring (static, never rotates) ───────────────────────────────

const ProgressRing = memo(function ProgressRing({
    progress, color, isWarning, warningIntensity, warningFlicker,
}: {
    progress: number; color: string;
    isWarning: boolean; warningIntensity: number; warningFlicker: boolean;
}) {
    const strokeColor = isWarning
        ? `rgba(255,${Math.round(80 * (1 - warningIntensity))},0,${warningFlicker ? 1 : 0.5})`
        : color;
    const offset = PROGRESS_C * (1 - progress);

    return (
        <svg
            viewBox="0 0 100 100"
            className="absolute inset-0 w-full h-full pointer-events-none"
            style={{ zIndex: 2 }}
        >
            {/* Track background */}
            <circle cx="50" cy="50" r={PROGRESS_R} fill="none"
                stroke="rgba(255,255,255,0.04)" strokeWidth="2.5"
                transform="rotate(-90 50 50)" />
            {/* Progress fill */}
            <circle cx="50" cy="50" r={PROGRESS_R} fill="none"
                stroke={strokeColor} strokeWidth="2.5" strokeLinecap="round"
                strokeDasharray={PROGRESS_C} strokeDashoffset={offset}
                transform="rotate(-90 50 50)"
                style={{ transition: "stroke-dashoffset 0.3s linear, stroke 0.2s" }} />
        </svg>
    );
});

// ─── Center Display Overlay (static, never rotates) ──────────────────────

const CenterOverlay = memo(function CenterOverlay({
    timeDisplay, remainingDisplay, color, isWarning, warningFlicker,
}: {
    timeDisplay: string; remainingDisplay: string; color: string;
    isWarning: boolean; warningFlicker: boolean;
}) {
    const warnColor = isWarning && warningFlicker ? "#ff4444" : color;
    return (
        <svg
            viewBox="0 0 100 100"
            className="absolute inset-0 w-full h-full pointer-events-none"
            style={{ zIndex: 3 }}
        >
            <text x="50" y="47" textAnchor="middle" fill="white" fontSize="5"
                fontWeight="700" fontFamily="monospace" opacity="0.7">
                {timeDisplay}
            </text>
            <text x="50" y="54" textAnchor="middle" fill={warnColor} fontSize="3.5"
                fontFamily="monospace" opacity={isWarning ? 0.9 : 0.5}>
                {remainingDisplay}
            </text>
        </svg>
    );
});

// ─── Main JogWheel Component ─────────────────────────────────────────────

interface JogWheelProps {
    side: DeckSide;
    deck: DeckState;
    color: string;
}

export const JogWheel = memo(function JogWheel({ side, deck, color }: JogWheelProps) {
    useRenderCount(`JogWheel:${side}`);
    const mixer = useMixerActions();
    const personalization = usePersonalization();
    const currentTime = useDeckCurrentTime(side);
    const isDragging = useRef(false);
    const lastAngle = useRef(0);
    const containerRef = useRef<HTMLDivElement>(null);
    const platterRef = useRef<HTMLDivElement>(null);

    // ── CSS animation speed ──────────────────────────────────────────
    // We use a CSS animation for rotation. The speed is controlled by
    // animation-duration (derived from BPM). When paused, we freeze
    // the animation via animation-play-state.
    //
    // ~0.55 RPS at 120 BPM → duration = 1/rps seconds per revolution
    const rps = deck.bpm / 220;
    const animDuration = rps > 0 ? (1 / rps) : 10;

    // ── End-of-track warning ─────────────────────────────────────────
    const remaining = deck.duration > 0 ? Math.max(0, deck.duration - currentTime) : Infinity;
    const endWarnSec = personalization.endWarningSeconds;
    const isWarning = endWarnSec > 0 && remaining < endWarnSec && remaining < Infinity && deck.isPlaying;
    const warningIntensity = isWarning ? Math.max(0, 1 - remaining / endWarnSec) : 0;

    // Warning flicker — ref-driven for zero-cost updates
    const [warningFlicker, setWarningFlicker] = useState(false);
    useEffect(() => {
        if (!isWarning) { setWarningFlicker(false); return; }
        const interval = setInterval(() => {
            setWarningFlicker(f => !f);
        }, 500 - warningIntensity * 300);
        return () => clearInterval(interval);
    }, [isWarning, warningIntensity > 0.5]);

    // ── Jog drag (scratch / nudge / seek) ────────────────────────────
    // Behaviour: dragging the wheel does TWO things at once so it feels
    // like a real DJ jog wheel and is never silent —
    //   1. **Always seek** the audio by an amount proportional to the
    //      angular delta. One full revolution moves the playhead by
    //      `secondsPerRev` (default 1.8 s, scaled by `jogSensitivity`).
    //      This makes scrubbing through cue points possible while paused
    //      and adds a tactile "scratch" feel while playing.
    //   2. **Pitch-bend** the deck while playing so other decks audibly
    //      react to the push/pull, matching CDJ behaviour.
    // The previous implementation only called `mixer.nudge`, which is
    // a no-op while the deck is paused (playbackRate has no effect on a
    // paused HTMLAudioElement) — that's why "moving the wheel did
    // nothing" when the deck wasn't playing.
    //
    // We use Pointer Events with setPointerCapture so the drag keeps
    // tracking even if the cursor leaves the (small) wheel — the old
    // mouse-event implementation called `onEnd` on `onMouseLeave`,
    // which made fast drags appear unresponsive on the 64×64 platter.
    const dragStartTimeRef = useRef(0);
    const dragAccumRef = useRef(0); // accumulated radians, signed
    const SECONDS_PER_REV = 1.8;

    const getAngleFromPointer = useCallback((clientX: number, clientY: number) => {
        const el = containerRef.current;
        if (!el) return 0;
        const rect = el.getBoundingClientRect();
        return Math.atan2(clientY - rect.top - rect.height / 2, clientX - rect.left - rect.width / 2);
    }, []);

    const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        // Only respond to primary button / single touch.
        if (e.button !== 0 && e.pointerType === "mouse") return;
        e.currentTarget.setPointerCapture(e.pointerId);
        isDragging.current = true;
        lastAngle.current = getAngleFromPointer(e.clientX, e.clientY);
        dragAccumRef.current = 0;
        dragStartTimeRef.current = mixer.getDeckCurrentTime(side);
    }, [getAngleFromPointer, mixer, side]);

    const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        if (!isDragging.current) return;
        const angle = getAngleFromPointer(e.clientX, e.clientY);
        let delta = angle - lastAngle.current;
        if (delta > Math.PI) delta -= Math.PI * 2;
        if (delta < -Math.PI) delta += Math.PI * 2;
        lastAngle.current = angle;

        // Accumulate angular displacement and convert to a time delta.
        // jogSensitivity (default 1.0) scales how far the wheel travels
        // per revolution; >1 = more sensitive (faster scrub).
        dragAccumRef.current += delta;
        const sens = personalization.jogSensitivity || 1;
        const secondsPerRev = SECONDS_PER_REV / sens;
        const target = dragStartTimeRef.current + (dragAccumRef.current / (2 * Math.PI)) * secondsPerRev;
        const clamped = Math.max(0, Math.min(target, deck.duration || target));
        mixer.seek(side, clamped);

        // Apply a pitch-bend proportional to the instantaneous angular
        // velocity so other decks hear the push/pull while playing.
        // (Harmless when paused — playbackRate has no audible effect.)
        const strength = Math.min(0.08, Math.abs(delta) * 0.3);
        mixer.nudge(side, delta > 0 ? strength * 1000 : -strength * 1000);
    }, [getAngleFromPointer, mixer, side, personalization.jogSensitivity, deck.duration]);

    const onPointerEnd = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        if (!isDragging.current) return;
        try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* */ }
        isDragging.current = false;
        dragAccumRef.current = 0;
        mixer.nudgeRelease(side);
    }, [mixer, side]);

    // ── Progress & time ──────────────────────────────────────────────
    const progress = deck.duration > 0 ? currentTime / deck.duration : 0;
    const timeDisplay = formatTime(currentTime);
    const remainingDisplay = deck.duration > 0 ? formatTimeRemaining(currentTime, deck.duration) : "—:——";

    // ── Design props for renderer ────────────────────────────────────
    // Rotation is always 0: the renderer's <g transform=rotate(0)> elements
    // are static within the platter SVG, and the platter DIV rotates via CSS.
    const designProps: JogDesignProps = {
        side,
        color,
        progress: 0, // progress ring is drawn separately, not by the renderer
        rotation: 0,
        isPlaying: deck.isPlaying,
        timeDisplay: "", // text overlay drawn separately
        remainingDisplay: "",
        isWarning,
        warningIntensity,
        warningFlicker,
    };

    const renderer = JOG_RENDERERS[personalization.jogwheelStyle] || JOG_RENDERERS.classic;

    return (
        <div
            ref={containerRef}
            className="w-16 h-16 md:w-20 md:h-20 lg:w-24 lg:h-24 xl:w-28 xl:h-28 shrink-0 relative cursor-grab active:cursor-grabbing select-none touch-none"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerEnd}
            onPointerCancel={onPointerEnd}
            style={{ touchAction: "none" }}
        >
            {/* Layer 1: Rotating platter (CSS animation — GPU composited) */}
            <div
                ref={platterRef}
                className="absolute inset-0 rounded-full"
                style={{
                    animationName: "jog-spin",
                    animationDuration: `${animDuration.toFixed(3)}s`,
                    animationTimingFunction: "linear",
                    animationIterationCount: "infinite",
                    animationPlayState: deck.isPlaying ? "running" : "paused",
                    // Only promote the layer while spinning. A paused platter
                    // with `will-change: transform` still holds its own GPU
                    // texture for no benefit — significant VRAM on 4 decks.
                    willChange: deck.isPlaying ? "transform" : undefined,
                }}
            >
                <svg viewBox="0 0 100 100" className="w-full h-full">
                    {renderer(designProps)}
                </svg>
            </div>

            {/* Layer 2: Progress ring (never rotates) */}
            <ProgressRing
                progress={progress}
                color={color}
                isWarning={isWarning}
                warningIntensity={warningIntensity}
                warningFlicker={warningFlicker}
            />

            {/* Layer 3: Center time display (never rotates) */}
            <CenterOverlay
                timeDisplay={timeDisplay}
                remainingDisplay={remainingDisplay}
                color={color}
                isWarning={isWarning}
                warningFlicker={warningFlicker}
            />

            {/* Layer 4: Tonearm needle */}
            <Tonearm isPlaying={deck.isPlaying} color={color} side={side} />

            {/* Playing glow ring — static ring, no animation. A pulsing
                `box-shadow` with a large blur radius is one of the most
                expensive compositor ops (it has to re-blur every frame of
                the pulse); on 2× decks during playback it was a measurable
                chunk of the 89% GPU usage. Keep the visual cue, drop the
                animation + shrink the blur. */}
            {deck.isPlaying && !isWarning && (
                <div className="absolute inset-0 rounded-full pointer-events-none"
                    style={{
                        boxShadow: `inset 0 0 6px 1px ${color}20`,
                        zIndex: 4,
                    }}
                />
            )}

            {/* End-of-track warning glow */}
            {isWarning && (
                <div
                    className="absolute inset-0 rounded-full pointer-events-none"
                    style={{
                        // Much smaller blur radius — the original `30px+` blur
                        // forced Chromium to re-composite the whole jog wheel
                        // area every frame. A tight inset glow gives the same
                        // "hot" feel for a fraction of the fill-rate cost.
                        boxShadow: `inset 0 0 ${6 + warningIntensity * 8}px ${1 + warningIntensity * 2}px rgba(255,${Math.round(40 * (1 - warningIntensity))},0,0.45)`,
                        opacity: warningFlicker ? 1 : 0.55,
                        transition: "opacity 200ms",
                        zIndex: 4,
                    }}
                />
            )}
        </div>
    );
});
