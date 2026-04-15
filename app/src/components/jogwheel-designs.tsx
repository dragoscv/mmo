"use client";

import React from "react";
import type { JogwheelStyle } from "@/hooks/use-personalization";

// ─── Types ───────────────────────────────────────────────────────────────

export interface JogDesignProps {
    side: "A" | "B";
    color: string;
    progress: number;        // 0–1
    rotation: number;        // degrees
    isPlaying: boolean;
    timeDisplay: string;
    remainingDisplay: string;
    isWarning: boolean;
    warningIntensity: number; // 0–1
    warningFlicker: boolean;
}

export interface JogStyleMeta {
    id: JogwheelStyle;
    name: string;
    description: string;
    category: "physical" | "digital" | "abstract" | "retro";
}

// ─── Style Metadata ──────────────────────────────────────────────────────

export const JOG_STYLES: JogStyleMeta[] = [
    { id: "classic", name: "Classic", description: "Grip grooves & marker dot", category: "physical" },
    { id: "vinyl", name: "Vinyl", description: "Record player grooves", category: "physical" },
    { id: "cdj", name: "CDJ", description: "Segmented ring display", category: "digital" },
    { id: "minimal", name: "Minimal", description: "Ultra-clean thin arc", category: "abstract" },
    { id: "neon", name: "Neon", description: "Glowing cyberpunk rings", category: "digital" },
    { id: "radar", name: "Radar", description: "Sweep scan display", category: "digital" },
    { id: "techno", name: "Techno", description: "Hexagonal geometry", category: "abstract" },
    { id: "retro", name: "Retro", description: "Warm amber CRT style", category: "retro" },
    { id: "holo", name: "Holo", description: "Iridescent prismatic", category: "abstract" },
    { id: "spectrum", name: "Spectrum", description: "Rainbow gradient ring", category: "abstract" },
    { id: "carbon", name: "Carbon", description: "Carbon fiber platter", category: "physical" },
    { id: "laser", name: "Laser", description: "Disc refraction lines", category: "digital" },
    { id: "pulse", name: "Pulse", description: "Sonar expanding rings", category: "digital" },
    { id: "eclipse", name: "Eclipse", description: "Solar corona glow", category: "abstract" },
    { id: "circuit", name: "Circuit", description: "PCB board traces", category: "retro" },
    { id: "waveform", name: "Waveform", description: "Circular audio wave", category: "digital" },
    { id: "crystal", name: "Crystal", description: "Gem faceted surface", category: "abstract" },
    { id: "vortex", name: "Vortex", description: "Spiral arm rotation", category: "abstract" },
    { id: "dotgrid", name: "Dot Grid", description: "LED dot matrix", category: "retro" },
    { id: "plasma", name: "Plasma", description: "Electric plasma arcs", category: "digital" },
];

// ─── Shared Constants ────────────────────────────────────────────────────

const R = 46;
const C = 2 * Math.PI * R;
const CX = 50, CY = 50;

function pc(r: number, angleDeg: number): [number, number] {
    const rad = (angleDeg - 90) * Math.PI / 180;
    return [CX + Math.cos(rad) * r, CY + Math.sin(rad) * r];
}

function progressColor(color: string, p: JogDesignProps): string {
    if (!p.isWarning) return color;
    const r = 255, g = Math.round(80 * (1 - p.warningIntensity)), b = 0;
    const a = p.warningFlicker ? 1 : 0.5;
    return `rgba(${r},${g},${b},${a})`;
}

function CenterTime({ p, yTime = 47, yRem = 54, fontSize = 5, remSize = 3.5 }: {
    p: JogDesignProps; yTime?: number; yRem?: number; fontSize?: number; remSize?: number;
}) {
    const warnColor = p.isWarning && p.warningFlicker ? "#ff4444" : p.color;
    return (
        <>
            <text x={CX} y={yTime} textAnchor="middle" fill="white" fontSize={fontSize}
                fontWeight="700" fontFamily="monospace" opacity="0.7">
                {p.timeDisplay}
            </text>
            <text x={CX} y={yRem} textAnchor="middle" fill={warnColor} fontSize={remSize}
                fontFamily="monospace" opacity={p.isWarning ? 0.9 : 0.5}>
                {p.remainingDisplay}
            </text>
        </>
    );
}

// ─── 1. Classic ──────────────────────────────────────────────────────────

function Classic(p: JogDesignProps) {
    const col = progressColor(p.color, p);
    const off = C * (1 - p.progress);
    return (
        <>
            <defs>
                <radialGradient id={`jbg-${p.side}`} cx="40%" cy="35%" r="60%">
                    <stop offset="0%" stopColor="rgba(255,255,255,0.08)" />
                    <stop offset="100%" stopColor="rgba(0,0,0,0.3)" />
                </radialGradient>
                <radialGradient id={`jcn-${p.side}`} cx="45%" cy="40%" r="55%">
                    <stop offset="0%" stopColor="rgba(255,255,255,0.12)" />
                    <stop offset="100%" stopColor="rgba(0,0,0,0.2)" />
                </radialGradient>
            </defs>
            <circle cx={CX} cy={CY} r="48" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="1" />
            <circle cx={CX} cy={CY} r={R} fill="none" stroke="rgba(255,255,255,0.04)" strokeWidth="2.5" transform={`rotate(-90 ${CX} ${CY})`} />
            <circle cx={CX} cy={CY} r={R} fill="none" stroke={col} strokeWidth="2.5" strokeLinecap="round"
                strokeDasharray={C} strokeDashoffset={off} transform={`rotate(-90 ${CX} ${CY})`}
                style={{ transition: "stroke-dashoffset 0.3s linear" }} />
            <circle cx={CX} cy={CY} r="43" fill={`url(#jbg-${p.side})`} />
            <g transform={`rotate(${p.rotation} ${CX} ${CY})`}>
                {Array.from({ length: 24 }, (_, i) => {
                    const a = (i / 24) * Math.PI * 2;
                    return <line key={i} x1={CX + Math.cos(a) * 36} y1={CY + Math.sin(a) * 36}
                        x2={CX + Math.cos(a) * 42} y2={CY + Math.sin(a) * 42}
                        stroke={i % 6 === 0 ? "rgba(255,255,255,0.12)" : "rgba(255,255,255,0.04)"}
                        strokeWidth={i % 6 === 0 ? 0.8 : 0.5} />;
                })}
                <circle cx={pc(38, 0)[0]} cy={pc(38, 0)[1]} r="2" fill={p.isPlaying ? col : `${p.color}80`} />
                {p.isPlaying && <circle cx={pc(38, 0)[0]} cy={pc(38, 0)[1]} r="3.5" fill="none" stroke={col} strokeWidth="0.5" opacity="0.4" />}
            </g>
            <circle cx={CX} cy={CY} r="16" fill={`url(#jcn-${p.side})`} stroke="rgba(255,255,255,0.06)" strokeWidth="0.5" />
            <circle cx={CX} cy={CY} r="2" fill={p.isPlaying ? col : "rgba(255,255,255,0.2)"} />
            <CenterTime p={p} />
        </>
    );
}

// ─── 2. Vinyl ────────────────────────────────────────────────────────────

function Vinyl(p: JogDesignProps) {
    const col = progressColor(p.color, p);
    const off = C * (1 - p.progress);
    return (
        <>
            {/* Vinyl platter */}
            <circle cx={CX} cy={CY} r="48" fill="#0a0a0a" stroke="rgba(255,255,255,0.05)" strokeWidth="0.5" />
            {/* Concentric groove rings */}
            {Array.from({ length: 14 }, (_, i) => (
                <circle key={i} cx={CX} cy={CY} r={20 + i * 2} fill="none"
                    stroke={`rgba(255,255,255,${0.02 + (i % 3 === 0 ? 0.02 : 0)})`} strokeWidth="0.3" />
            ))}
            {/* Progress ring */}
            <circle cx={CX} cy={CY} r={R} fill="none" stroke="rgba(255,255,255,0.03)" strokeWidth="3"
                transform={`rotate(-90 ${CX} ${CY})`} />
            <circle cx={CX} cy={CY} r={R} fill="none" stroke={col} strokeWidth="3" strokeLinecap="round"
                strokeDasharray={C} strokeDashoffset={off} transform={`rotate(-90 ${CX} ${CY})`}
                style={{ transition: "stroke-dashoffset 0.3s linear" }} opacity="0.6" />
            {/* Rotating group */}
            <g transform={`rotate(${p.rotation} ${CX} ${CY})`}>
                {/* Lead-in groove highlight */}
                <line x1={CX} y1={CY - 18} x2={CX} y2={CY - 45} stroke="rgba(255,255,255,0.15)" strokeWidth="0.6" />
                {/* Subtle groove shimmer lines */}
                {[120, 240].map(deg => {
                    const rad = deg * Math.PI / 180;
                    return <line key={deg} x1={CX + Math.cos(rad) * 18} y1={CY + Math.sin(rad) * 18}
                        x2={CX + Math.cos(rad) * 44} y2={CY + Math.sin(rad) * 44}
                        stroke="rgba(255,255,255,0.03)" strokeWidth="0.3" />;
                })}
            </g>
            {/* Center label */}
            <circle cx={CX} cy={CY} r="17" fill="#1a1a1a" stroke="rgba(255,255,255,0.08)" strokeWidth="0.5" />
            <circle cx={CX} cy={CY} r="14" fill="#111" stroke={`${p.color}30`} strokeWidth="0.3" />
            {/* Spindle hole */}
            <circle cx={CX} cy={CY} r="2.5" fill="#050505" stroke="rgba(255,255,255,0.1)" strokeWidth="0.3" />
            <CenterTime p={p} yTime={46} yRem={53} />
        </>
    );
}

// ─── 3. CDJ ──────────────────────────────────────────────────────────────

function CDJ(p: JogDesignProps) {
    const col = progressColor(p.color, p);
    const segs = 40;
    const filledSegs = Math.round(p.progress * segs);
    return (
        <>
            <circle cx={CX} cy={CY} r="48" fill="#050508" stroke="rgba(255,255,255,0.08)" strokeWidth="1" />
            {/* Segmented ring */}
            {Array.from({ length: segs }, (_, i) => {
                const startA = (i / segs) * 360;
                const endA = ((i + 0.7) / segs) * 360;
                const s = pc(43, startA), e = pc(43, endA);
                const si = pc(47, startA), ei = pc(47, endA);
                const filled = i < filledSegs;
                return (
                    <path key={i}
                        d={`M${s[0]},${s[1]} A43,43 0 0 1 ${e[0]},${e[1]} L${ei[0]},${ei[1]} A47,47 0 0 0 ${si[0]},${si[1]}Z`}
                        fill={filled ? col : "rgba(255,255,255,0.03)"}
                        opacity={filled ? (p.isPlaying ? 0.9 : 0.6) : 1}
                        style={{ transition: "fill 0.15s" }}
                    />
                );
            })}
            {/* Inner ring */}
            <circle cx={CX} cy={CY} r="40" fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="0.5" />
            {/* Rotating platter */}
            <circle cx={CX} cy={CY} r="39" fill="rgba(255,255,255,0.02)" />
            <g transform={`rotate(${p.rotation} ${CX} ${CY})`}>
                {[0, 90, 180, 270].map(deg => {
                    const rad = (deg - 90) * Math.PI / 180;
                    return <line key={deg} x1={CX + Math.cos(rad) * 20} y1={CY + Math.sin(rad) * 20}
                        x2={CX + Math.cos(rad) * 38} y2={CY + Math.sin(rad) * 38}
                        stroke="rgba(255,255,255,0.05)" strokeWidth="0.4" />;
                })}
                <circle cx={pc(32, 0)[0]} cy={pc(32, 0)[1]} r="1.5" fill={col} />
            </g>
            {/* Center display */}
            <rect x={CX - 16} y={CY - 10} width="32" height="20" rx="2" fill="rgba(0,0,0,0.6)" stroke="rgba(255,255,255,0.06)" strokeWidth="0.5" />
            <CenterTime p={p} />
        </>
    );
}

// ─── 4. Minimal ──────────────────────────────────────────────────────────

function Minimal(p: JogDesignProps) {
    const col = progressColor(p.color, p);
    const off = C * (1 - p.progress);
    const mPos = pc(R, p.rotation % 360);
    return (
        <>
            <circle cx={CX} cy={CY} r="48" fill="none" stroke="rgba(255,255,255,0.04)" strokeWidth="0.5" />
            {/* Progress arc */}
            <circle cx={CX} cy={CY} r={R} fill="none" stroke="rgba(255,255,255,0.03)" strokeWidth="1.5"
                transform={`rotate(-90 ${CX} ${CY})`} />
            <circle cx={CX} cy={CY} r={R} fill="none" stroke={col} strokeWidth="1.5" strokeLinecap="round"
                strokeDasharray={C} strokeDashoffset={off} transform={`rotate(-90 ${CX} ${CY})`}
                style={{ transition: "stroke-dashoffset 0.3s linear" }} />
            {/* Rotating marker */}
            <g transform={`rotate(${p.rotation} ${CX} ${CY})`}>
                <polygon points={`${CX},${CY - 44} ${CX - 1.5},${CY - 40} ${CX + 1.5},${CY - 40}`}
                    fill={p.isPlaying ? col : "rgba(255,255,255,0.15)"} />
            </g>
            {/* Time */}
            <CenterTime p={p} fontSize={6} remSize={3.5} />
        </>
    );
}

// ─── 5. Neon ─────────────────────────────────────────────────────────────

function Neon(p: JogDesignProps) {
    const col = progressColor(p.color, p);
    const off = C * (1 - p.progress);
    const innerC = 2 * Math.PI * 38;
    return (
        <>
            <defs>
                <filter id={`neon-glow-${p.side}`}>
                    <feGaussianBlur in="SourceGraphic" stdDeviation="2" />
                </filter>
            </defs>
            <circle cx={CX} cy={CY} r="48" fill="rgba(0,0,0,0.4)" />
            {/* Outer glow ring */}
            <circle cx={CX} cy={CY} r={R} fill="none" stroke={col} strokeWidth="3" strokeLinecap="round"
                strokeDasharray={C} strokeDashoffset={off} transform={`rotate(-90 ${CX} ${CY})`}
                filter={`url(#neon-glow-${p.side})`}
                style={{ transition: "stroke-dashoffset 0.3s linear" }} />
            {/* Crisp ring on top */}
            <circle cx={CX} cy={CY} r={R} fill="none" stroke={col} strokeWidth="1.5" strokeLinecap="round"
                strokeDasharray={C} strokeDashoffset={off} transform={`rotate(-90 ${CX} ${CY})`}
                style={{ transition: "stroke-dashoffset 0.3s linear" }} />
            {/* Track background */}
            <circle cx={CX} cy={CY} r={R} fill="none" stroke="rgba(255,255,255,0.03)" strokeWidth="1.5"
                transform={`rotate(-90 ${CX} ${CY})`} />
            {/* Inner decorative ring */}
            <circle cx={CX} cy={CY} r="38" fill="none" stroke={`${p.color}20`} strokeWidth="0.8"
                strokeDasharray={`${innerC / 16} ${innerC / 16}`}
                transform={`rotate(${p.rotation * 0.5} ${CX} ${CY})`} />
            {/* Rotating marker */}
            <g transform={`rotate(${p.rotation} ${CX} ${CY})`}>
                <circle cx={CX} cy={CY - 42} r="2.5" fill={col}
                    filter={p.isPlaying ? `url(#neon-glow-${p.side})` : undefined} />
                <circle cx={CX} cy={CY - 42} r="1.5" fill="white" opacity="0.7" />
            </g>
            {/* Center */}
            <circle cx={CX} cy={CY} r="15" fill="rgba(0,0,0,0.5)" stroke={`${p.color}25`} strokeWidth="0.5" />
            <CenterTime p={p} />
        </>
    );
}

// ─── 6. Radar ────────────────────────────────────────────────────────────

function Radar(p: JogDesignProps) {
    const col = progressColor(p.color, p);
    const sweepAngle = p.rotation % 360;
    const progressAngle = p.progress * 360;
    return (
        <>
            <circle cx={CX} cy={CY} r="48" fill="rgba(0,10,0,0.4)" stroke="rgba(0,255,100,0.08)" strokeWidth="0.5" />
            {/* Grid lines */}
            <line x1={CX} y1={CY - 47} x2={CX} y2={CY + 47} stroke="rgba(0,255,100,0.06)" strokeWidth="0.3" />
            <line x1={CX - 47} y1={CY} x2={CX + 47} y2={CY} stroke="rgba(0,255,100,0.06)" strokeWidth="0.3" />
            {/* Range rings */}
            {[15, 30, 44].map(r => (
                <circle key={r} cx={CX} cy={CY} r={r} fill="none" stroke="rgba(0,255,100,0.05)" strokeWidth="0.3" />
            ))}
            {/* Progress arc */}
            {progressAngle > 0 && (
                <path d={`M${CX},${CY} L${pc(46, 0)[0]},${pc(46, 0)[1]} A46,46 0 ${progressAngle > 180 ? 1 : 0} 1 ${pc(46, progressAngle)[0]},${pc(46, progressAngle)[1]}Z`}
                    fill={col} opacity="0.08" />
            )}
            {/* Sweep line */}
            <g transform={`rotate(${sweepAngle} ${CX} ${CY})`}>
                <line x1={CX} y1={CY} x2={CX} y2={CY - 46} stroke="rgba(0,255,100,0.5)" strokeWidth="0.8" />
                {/* Sweep fade */}
                <path d={`M${CX},${CY} L${pc(46, 0)[0]},${pc(46, 0)[1]} A46,46 0 0 0 ${pc(46, -30)[0]},${pc(46, -30)[1]}Z`}
                    fill="rgba(0,255,100,0.06)" />
            </g>
            {/* Blip dots */}
            {[45, 150, 260].map((deg, i) => (
                <circle key={i} cx={pc(20 + i * 10, deg)[0]} cy={pc(20 + i * 10, deg)[1]}
                    r="1" fill="rgba(0,255,100,0.4)" />
            ))}
            {/* Center */}
            <circle cx={CX} cy={CY} r="14" fill="rgba(0,5,0,0.6)" stroke="rgba(0,255,100,0.1)" strokeWidth="0.5" />
            <CenterTime p={p} />
        </>
    );
}

// ─── 7. Techno ───────────────────────────────────────────────────────────

function Techno(p: JogDesignProps) {
    const col = progressColor(p.color, p);
    const sides = 8;
    const hexPoints = (r: number) => Array.from({ length: sides }, (_, i) => pc(r, (i / sides) * 360)).map(pt => pt.join(",")).join(" ");
    const off = C * (1 - p.progress);
    return (
        <>
            {/* Octagonal frame */}
            <polygon points={hexPoints(48)} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="0.8" />
            <polygon points={hexPoints(44)} fill="rgba(255,255,255,0.02)" stroke="rgba(255,255,255,0.04)" strokeWidth="0.5" />
            {/* Progress ring (still circular for smooth progress) */}
            <circle cx={CX} cy={CY} r={R} fill="none" stroke="rgba(255,255,255,0.03)" strokeWidth="2"
                transform={`rotate(-90 ${CX} ${CY})`} />
            <circle cx={CX} cy={CY} r={R} fill="none" stroke={col} strokeWidth="2" strokeLinecap="butt"
                strokeDasharray={C} strokeDashoffset={off} transform={`rotate(-90 ${CX} ${CY})`}
                style={{ transition: "stroke-dashoffset 0.3s linear" }} />
            {/* Geometric ticks */}
            {Array.from({ length: sides }, (_, i) => {
                const a = (i / sides) * 360;
                const [x1, y1] = pc(35, a), [x2, y2] = pc(44, a);
                return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke="rgba(255,255,255,0.1)" strokeWidth="1" />;
            })}
            {/* Rotating inner */}
            <g transform={`rotate(${p.rotation} ${CX} ${CY})`}>
                <polygon points={hexPoints(32)} fill="none" stroke="rgba(255,255,255,0.04)" strokeWidth="0.5" />
                <line x1={CX} y1={CY - 18} x2={CX} y2={CY - 35} stroke={col} strokeWidth="1" opacity="0.8" />
            </g>
            {/* Center */}
            <polygon points={hexPoints(16)} fill="rgba(0,0,0,0.3)" stroke="rgba(255,255,255,0.06)" strokeWidth="0.5" />
            <CenterTime p={p} />
        </>
    );
}

// ─── 8. Retro ────────────────────────────────────────────────────────────

function Retro(p: JogDesignProps) {
    const amber = p.isWarning ? progressColor("#ffa000", p) : "#ffa000";
    const off = C * (1 - p.progress);
    return (
        <>
            <circle cx={CX} cy={CY} r="48" fill="rgba(20,15,5,0.5)" stroke="rgba(255,160,0,0.1)" strokeWidth="1.5" />
            {/* Scanlines */}
            {Array.from({ length: 12 }, (_, i) => (
                <line key={i} x1={CX - 47} y1={CY - 47 + i * 8} x2={CX + 47} y2={CY - 47 + i * 8}
                    stroke="rgba(255,160,0,0.03)" strokeWidth="0.5" />
            ))}
            {/* Thick progress ring */}
            <circle cx={CX} cy={CY} r={R} fill="none" stroke="rgba(255,160,0,0.06)" strokeWidth="5"
                transform={`rotate(-90 ${CX} ${CY})`} />
            <circle cx={CX} cy={CY} r={R} fill="none" stroke={amber} strokeWidth="5" strokeLinecap="round"
                strokeDasharray={C} strokeDashoffset={off} transform={`rotate(-90 ${CX} ${CY})`}
                opacity="0.7" style={{ transition: "stroke-dashoffset 0.3s linear" }} />
            {/* Rotating marker */}
            <g transform={`rotate(${p.rotation} ${CX} ${CY})`}>
                <rect x={CX - 1.5} y={CY - 43} width="3" height="8" rx="1" fill={amber} opacity="0.7" />
            </g>
            {/* Center */}
            <circle cx={CX} cy={CY} r="18" fill="rgba(10,8,2,0.6)" stroke="rgba(255,160,0,0.08)" strokeWidth="0.8" />
            <text x={CX} y={46} textAnchor="middle" fill={amber} fontSize="5.5" fontWeight="700" fontFamily="monospace" opacity="0.8">
                {p.timeDisplay}
            </text>
            <text x={CX} y={53.5} textAnchor="middle" fill={amber} fontSize="3.5" fontFamily="monospace"
                opacity={p.isWarning ? 0.9 : 0.5}>
                {p.remainingDisplay}
            </text>
        </>
    );
}

// ─── 9. Holo ─────────────────────────────────────────────────────────────

function Holo(p: JogDesignProps) {
    const col = progressColor(p.color, p);
    const off = C * (1 - p.progress);
    const hueShift = p.rotation % 360;
    return (
        <>
            <defs>
                <linearGradient id={`holo-g-${p.side}`} gradientTransform={`rotate(${hueShift})`}>
                    <stop offset="0%" stopColor="#ff00ff" stopOpacity="0.3" />
                    <stop offset="25%" stopColor="#00ffff" stopOpacity="0.3" />
                    <stop offset="50%" stopColor="#ff00ff" stopOpacity="0.3" />
                    <stop offset="75%" stopColor="#ffff00" stopOpacity="0.3" />
                    <stop offset="100%" stopColor="#ff00ff" stopOpacity="0.3" />
                </linearGradient>
            </defs>
            <circle cx={CX} cy={CY} r="48" fill="rgba(0,0,0,0.3)" />
            {/* Holographic sheen */}
            <circle cx={CX} cy={CY} r="44" fill={`url(#holo-g-${p.side})`} />
            {/* Progress ring */}
            <circle cx={CX} cy={CY} r={R} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="2"
                transform={`rotate(-90 ${CX} ${CY})`} />
            <circle cx={CX} cy={CY} r={R} fill="none" stroke={col} strokeWidth="2" strokeLinecap="round"
                strokeDasharray={C} strokeDashoffset={off} transform={`rotate(-90 ${CX} ${CY})`}
                style={{ transition: "stroke-dashoffset 0.3s linear" }} />
            {/* Prismatic reflection lines */}
            <g transform={`rotate(${p.rotation} ${CX} ${CY})`} opacity="0.15">
                {[0, 72, 144, 216, 288].map(deg => {
                    const [x1, y1] = pc(8, deg), [x2, y2] = pc(42, deg);
                    return <line key={deg} x1={x1} y1={y1} x2={x2} y2={y2} stroke="white" strokeWidth="0.3" />;
                })}
            </g>
            {/* Center */}
            <circle cx={CX} cy={CY} r="15" fill="rgba(0,0,0,0.4)" stroke="rgba(255,255,255,0.1)" strokeWidth="0.5" />
            <CenterTime p={p} />
        </>
    );
}

// ─── 10. Spectrum ────────────────────────────────────────────────────────

function Spectrum(p: JogDesignProps) {
    const off = C * (1 - p.progress);
    const warnCol = p.isWarning && p.warningFlicker ? "#ff4444" : undefined;
    return (
        <>
            <defs>
                <linearGradient id={`spec-${p.side}`} gradientUnits="userSpaceOnUse" x1="4" y1="50" x2="96" y2="50">
                    <stop offset="0%" stopColor="#ff0000" />
                    <stop offset="17%" stopColor="#ff8800" />
                    <stop offset="33%" stopColor="#ffff00" />
                    <stop offset="50%" stopColor="#00ff00" />
                    <stop offset="67%" stopColor="#0088ff" />
                    <stop offset="83%" stopColor="#8800ff" />
                    <stop offset="100%" stopColor="#ff00ff" />
                </linearGradient>
            </defs>
            <circle cx={CX} cy={CY} r="48" fill="rgba(0,0,0,0.2)" stroke="rgba(255,255,255,0.04)" strokeWidth="0.5" />
            {/* Background ring */}
            <circle cx={CX} cy={CY} r={R} fill="none" stroke="rgba(255,255,255,0.03)" strokeWidth="4"
                transform={`rotate(-90 ${CX} ${CY})`} />
            {/* Rainbow progress */}
            <circle cx={CX} cy={CY} r={R} fill="none" stroke={warnCol || `url(#spec-${p.side})`} strokeWidth="4" strokeLinecap="round"
                strokeDasharray={C} strokeDashoffset={off} transform={`rotate(-90 ${CX} ${CY})`}
                style={{ transition: "stroke-dashoffset 0.3s linear" }} />
            {/* Rotating marker */}
            <g transform={`rotate(${p.rotation} ${CX} ${CY})`}>
                <circle cx={CX} cy={CY - 40} r="1.5" fill="white" opacity="0.6" />
            </g>
            {/* Center */}
            <circle cx={CX} cy={CY} r="16" fill="rgba(0,0,0,0.3)" stroke="rgba(255,255,255,0.06)" strokeWidth="0.5" />
            <CenterTime p={p} />
        </>
    );
}

// ─── 11. Carbon ──────────────────────────────────────────────────────────

function Carbon(p: JogDesignProps) {
    const col = progressColor(p.color, p);
    const off = C * (1 - p.progress);
    return (
        <>
            <defs>
                <pattern id={`cf-${p.side}`} width="4" height="4" patternUnits="userSpaceOnUse">
                    <rect width="4" height="4" fill="rgba(15,15,15,1)" />
                    <line x1="0" y1="0" x2="4" y2="4" stroke="rgba(255,255,255,0.03)" strokeWidth="0.5" />
                    <line x1="4" y1="0" x2="0" y2="4" stroke="rgba(255,255,255,0.03)" strokeWidth="0.5" />
                </pattern>
            </defs>
            {/* Carbon fiber platter */}
            <circle cx={CX} cy={CY} r="48" fill={`url(#cf-${p.side})`} stroke="rgba(255,255,255,0.1)" strokeWidth="1" />
            {/* Chrome bezel ring */}
            <circle cx={CX} cy={CY} r="47" fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth="0.3" />
            {/* Progress ring */}
            <circle cx={CX} cy={CY} r={R} fill="none" stroke="rgba(255,255,255,0.04)" strokeWidth="2"
                transform={`rotate(-90 ${CX} ${CY})`} />
            <circle cx={CX} cy={CY} r={R} fill="none" stroke={col} strokeWidth="2" strokeLinecap="round"
                strokeDasharray={C} strokeDashoffset={off} transform={`rotate(-90 ${CX} ${CY})`}
                style={{ transition: "stroke-dashoffset 0.3s linear" }} opacity="0.8" />
            {/* Rotating inner */}
            <g transform={`rotate(${p.rotation} ${CX} ${CY})`}>
                {[0, 120, 240].map(deg => {
                    const [x, y] = pc(38, deg);
                    return <circle key={deg} cx={x} cy={y} r="1" fill="rgba(255,255,255,0.08)" />;
                })}
                <line x1={CX} y1={CY - 20} x2={CX} y2={CY - 42} stroke="rgba(255,255,255,0.15)" strokeWidth="0.6" />
            </g>
            {/* Center */}
            <circle cx={CX} cy={CY} r="17" fill="rgba(10,10,10,0.8)" stroke="rgba(255,255,255,0.08)" strokeWidth="0.5" />
            <CenterTime p={p} />
        </>
    );
}

// ─── 12. Laser ───────────────────────────────────────────────────────────

function Laser(p: JogDesignProps) {
    const col = progressColor(p.color, p);
    const off = C * (1 - p.progress);
    return (
        <>
            <circle cx={CX} cy={CY} r="48" fill="rgba(0,0,10,0.4)" stroke="rgba(255,255,255,0.06)" strokeWidth="0.5" />
            {/* Refraction radial lines */}
            <g transform={`rotate(${p.rotation * 0.3} ${CX} ${CY})`} opacity="0.12">
                {Array.from({ length: 36 }, (_, i) => {
                    const a = (i / 36) * 360;
                    const [x1, y1] = pc(6, a), [x2, y2] = pc(47, a);
                    const colors = ["#ff00ff", "#00ffff", "#ffff00", "#ff6600", "#00ff66", "#6600ff"];
                    return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke={colors[i % 6]} strokeWidth="0.3" />;
                })}
            </g>
            {/* Disc rings */}
            {[25, 32, 39].map(r => (
                <circle key={r} cx={CX} cy={CY} r={r} fill="none" stroke="rgba(255,255,255,0.03)" strokeWidth="0.3" />
            ))}
            {/* Progress ring */}
            <circle cx={CX} cy={CY} r={R} fill="none" stroke="rgba(255,255,255,0.04)" strokeWidth="2.5"
                transform={`rotate(-90 ${CX} ${CY})`} />
            <circle cx={CX} cy={CY} r={R} fill="none" stroke={col} strokeWidth="2.5" strokeLinecap="round"
                strokeDasharray={C} strokeDashoffset={off} transform={`rotate(-90 ${CX} ${CY})`}
                style={{ transition: "stroke-dashoffset 0.3s linear" }} />
            {/* Center */}
            <circle cx={CX} cy={CY} r="16" fill="rgba(0,0,10,0.5)" stroke="rgba(255,255,255,0.06)" strokeWidth="0.5" />
            <circle cx={CX} cy={CY} r="2" fill={col} opacity="0.6" />
            <CenterTime p={p} />
        </>
    );
}

// ─── 13. Pulse ───────────────────────────────────────────────────────────

function Pulse(p: JogDesignProps) {
    const col = progressColor(p.color, p);
    const off = C * (1 - p.progress);
    // 3 expanding rings, staggered phase
    const pulsePhase = (p.rotation / 120) % 1; // normalized 0–1
    return (
        <>
            <circle cx={CX} cy={CY} r="48" fill="rgba(0,0,0,0.3)" />
            {/* Expanding sonar rings */}
            {p.isPlaying && [0, 0.33, 0.66].map((offset, i) => {
                const phase = (pulsePhase + offset) % 1;
                const r = 10 + phase * 38;
                const opacity = (1 - phase) * 0.15;
                return <circle key={i} cx={CX} cy={CY} r={r} fill="none" stroke={col} strokeWidth="0.8" opacity={opacity} />;
            })}
            {/* Static progress ring */}
            <circle cx={CX} cy={CY} r={R} fill="none" stroke="rgba(255,255,255,0.04)" strokeWidth="2"
                transform={`rotate(-90 ${CX} ${CY})`} />
            <circle cx={CX} cy={CY} r={R} fill="none" stroke={col} strokeWidth="2" strokeLinecap="round"
                strokeDasharray={C} strokeDashoffset={off} transform={`rotate(-90 ${CX} ${CY})`}
                style={{ transition: "stroke-dashoffset 0.3s linear" }} opacity="0.7" />
            {/* Inner ring */}
            <circle cx={CX} cy={CY} r="28" fill="none" stroke="rgba(255,255,255,0.03)" strokeWidth="0.5" />
            {/* Rotating marker */}
            <g transform={`rotate(${p.rotation} ${CX} ${CY})`}>
                <circle cx={CX} cy={CY - 38} r="2" fill={col} opacity="0.6" />
            </g>
            {/* Center */}
            <circle cx={CX} cy={CY} r="15" fill="rgba(0,0,0,0.4)" stroke={`${p.color}15`} strokeWidth="0.5" />
            <CenterTime p={p} />
        </>
    );
}

// ─── 14. Eclipse ─────────────────────────────────────────────────────────

function Eclipse(p: JogDesignProps) {
    const col = progressColor(p.color, p);
    const off = C * (1 - p.progress);
    return (
        <>
            <defs>
                <radialGradient id={`ecl-${p.side}`} cx="50%" cy="50%" r="50%">
                    <stop offset="70%" stopColor="rgba(0,0,0,0.95)" />
                    <stop offset="95%" stopColor={`${p.color}30`} />
                    <stop offset="100%" stopColor={`${p.color}10`} />
                </radialGradient>
                <filter id={`ecl-glow-${p.side}`}>
                    <feGaussianBlur in="SourceGraphic" stdDeviation="3" />
                </filter>
            </defs>
            {/* Corona glow */}
            <circle cx={CX} cy={CY} r="47" fill="none" stroke={col} strokeWidth="3"
                filter={`url(#ecl-glow-${p.side})`} opacity={p.isPlaying ? 0.4 : 0.15} />
            {/* Dark body */}
            <circle cx={CX} cy={CY} r="47" fill={`url(#ecl-${p.side})`} />
            {/* Progress (as corona coverage) */}
            <circle cx={CX} cy={CY} r="47" fill="none" stroke={col} strokeWidth="1.5" strokeLinecap="round"
                strokeDasharray={C * 47 / R} strokeDashoffset={(C * 47 / R) * (1 - p.progress)}
                transform={`rotate(-90 ${CX} ${CY})`}
                opacity="0.5" style={{ transition: "stroke-dashoffset 0.3s linear" }} />
            {/* Rim light (progress position) */}
            <circle cx={CX} cy={CY} r={R} fill="none" stroke={col} strokeWidth="2"
                strokeDasharray={C} strokeDashoffset={off} transform={`rotate(-90 ${CX} ${CY})`}
                style={{ transition: "stroke-dashoffset 0.3s linear" }} />
            {/* Rotating */}
            <g transform={`rotate(${p.rotation} ${CX} ${CY})`}>
                <circle cx={CX} cy={CY - 44} r="1.5" fill={col} opacity="0.7" />
            </g>
            {/* Center time */}
            <CenterTime p={p} />
        </>
    );
}

// ─── 15. Circuit ─────────────────────────────────────────────────────────

function Circuit(p: JogDesignProps) {
    const green = p.isWarning ? progressColor("#00ff41", p) : "#00ff41";
    const off = C * (1 - p.progress);
    return (
        <>
            <circle cx={CX} cy={CY} r="48" fill="rgba(0,15,5,0.4)" stroke="rgba(0,255,65,0.1)" strokeWidth="0.5" />
            {/* PCB traces */}
            <g opacity="0.1">
                <path d="M10,50 H30 V30 H40" fill="none" stroke="#00ff41" strokeWidth="0.8" />
                <path d="M50,10 V25 H70 V40" fill="none" stroke="#00ff41" strokeWidth="0.8" />
                <path d="M90,50 H75 V65 H60" fill="none" stroke="#00ff41" strokeWidth="0.8" />
                <path d="M50,90 V78 H35 V65" fill="none" stroke="#00ff41" strokeWidth="0.8" />
            </g>
            {/* Component pads */}
            {[0, 45, 90, 135, 180, 225, 270, 315].map(deg => {
                const [x, y] = pc(40, deg);
                const filled = (deg / 360) <= p.progress;
                return <rect key={deg} x={x - 1.5} y={y - 1.5} width="3" height="3"
                    fill={filled ? green : "rgba(0,255,65,0.05)"} stroke="rgba(0,255,65,0.15)" strokeWidth="0.3" />;
            })}
            {/* Progress ring */}
            <circle cx={CX} cy={CY} r={R} fill="none" stroke="rgba(0,255,65,0.05)" strokeWidth="1.5"
                transform={`rotate(-90 ${CX} ${CY})`} />
            <circle cx={CX} cy={CY} r={R} fill="none" stroke={green} strokeWidth="1.5"
                strokeDasharray={C} strokeDashoffset={off} transform={`rotate(-90 ${CX} ${CY})`}
                opacity="0.5" style={{ transition: "stroke-dashoffset 0.3s linear" }} />
            {/* Rotating IC chip */}
            <g transform={`rotate(${p.rotation} ${CX} ${CY})`}>
                <line x1={CX} y1={CY - 18} x2={CX} y2={CY - 36} stroke={green} strokeWidth="0.8" opacity="0.6" />
            </g>
            {/* Center IC */}
            <rect x={CX - 12} y={CY - 10} width="24" height="20" rx="1" fill="rgba(0,10,3,0.7)" stroke="rgba(0,255,65,0.12)" strokeWidth="0.5" />
            <text x={CX} y={47} textAnchor="middle" fill={green} fontSize="5" fontWeight="700" fontFamily="monospace" opacity="0.8">
                {p.timeDisplay}
            </text>
            <text x={CX} y={54} textAnchor="middle" fill={green} fontSize="3.2" fontFamily="monospace"
                opacity={p.isWarning ? 0.9 : 0.4}>
                {p.remainingDisplay}
            </text>
        </>
    );
}

// ─── 16. Waveform ────────────────────────────────────────────────────────

function Waveform(p: JogDesignProps) {
    const col = progressColor(p.color, p);
    // Generate wavy ring path
    const pts = 120;
    const wavePath = Array.from({ length: pts }, (_, i) => {
        const angle = (i / pts) * Math.PI * 2 - Math.PI / 2;
        const wave = Math.sin(i * 0.5 + p.rotation * 0.02) * 2.5;
        const r = 42 + wave;
        const x = CX + Math.cos(angle) * r;
        const y = CY + Math.sin(angle) * r;
        return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ") + "Z";

    const progressWavePath = Array.from({ length: Math.round(pts * p.progress) + 1 }, (_, i) => {
        const angle = (i / pts) * Math.PI * 2 - Math.PI / 2;
        const wave = Math.sin(i * 0.5 + p.rotation * 0.02) * 2.5;
        const r = 42 + wave;
        const x = CX + Math.cos(angle) * r;
        const y = CY + Math.sin(angle) * r;
        return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");

    return (
        <>
            <circle cx={CX} cy={CY} r="48" fill="rgba(0,0,0,0.2)" stroke="rgba(255,255,255,0.04)" strokeWidth="0.5" />
            {/* Wavy ring background */}
            <path d={wavePath} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="1.5" />
            {/* Wavy ring progress */}
            {p.progress > 0 && (
                <path d={progressWavePath} fill="none" stroke={col} strokeWidth="2" strokeLinecap="round" opacity="0.7" />
            )}
            {/* Inner circle */}
            <circle cx={CX} cy={CY} r="30" fill="none" stroke="rgba(255,255,255,0.03)" strokeWidth="0.3" />
            {/* Rotating marker */}
            <g transform={`rotate(${p.rotation} ${CX} ${CY})`}>
                <circle cx={CX} cy={CY - 42} r="2" fill={col} opacity="0.5" />
            </g>
            {/* Center */}
            <circle cx={CX} cy={CY} r="15" fill="rgba(0,0,0,0.35)" stroke="rgba(255,255,255,0.05)" strokeWidth="0.5" />
            <CenterTime p={p} />
        </>
    );
}

// ─── 17. Crystal ─────────────────────────────────────────────────────────

function Crystal(p: JogDesignProps) {
    const col = progressColor(p.color, p);
    const off = C * (1 - p.progress);
    const facets = 12;
    return (
        <>
            <circle cx={CX} cy={CY} r="48" fill="rgba(0,0,0,0.2)" />
            {/* Faceted segments */}
            {Array.from({ length: facets }, (_, i) => {
                const a1 = (i / facets) * 360;
                const a2 = ((i + 1) / facets) * 360;
                const [ox, oy] = pc(44, (a1 + a2) / 2);
                const [p1x, p1y] = pc(44, a1);
                const [p2x, p2y] = pc(44, a2);
                // Brightness varies with rotation for shimmer
                const shimmer = Math.sin((p.rotation + i * 30) * Math.PI / 180) * 0.03 + 0.04;
                return (
                    <path key={i} d={`M${CX},${CY} L${p1x},${p1y} L${p2x},${p2y}Z`}
                        fill={`rgba(255,255,255,${shimmer.toFixed(3)})`}
                        stroke="rgba(255,255,255,0.04)" strokeWidth="0.3" />
                );
            })}
            {/* Progress ring */}
            <circle cx={CX} cy={CY} r={R} fill="none" stroke="rgba(255,255,255,0.04)" strokeWidth="2"
                transform={`rotate(-90 ${CX} ${CY})`} />
            <circle cx={CX} cy={CY} r={R} fill="none" stroke={col} strokeWidth="2" strokeLinecap="round"
                strokeDasharray={C} strokeDashoffset={off} transform={`rotate(-90 ${CX} ${CY})`}
                style={{ transition: "stroke-dashoffset 0.3s linear" }} />
            {/* Facet edges from center */}
            {Array.from({ length: facets }, (_, i) => {
                const a = (i / facets) * 360;
                const [x, y] = pc(44, a);
                return <line key={i} x1={CX} y1={CY} x2={x} y2={y} stroke="rgba(255,255,255,0.04)" strokeWidth="0.3" />;
            })}
            {/* Center gem */}
            <circle cx={CX} cy={CY} r="15" fill="rgba(0,0,0,0.3)" stroke="rgba(255,255,255,0.1)" strokeWidth="0.5" />
            <CenterTime p={p} />
        </>
    );
}

// ─── 18. Vortex ──────────────────────────────────────────────────────────

function Vortex(p: JogDesignProps) {
    const col = progressColor(p.color, p);
    const off = C * (1 - p.progress);
    const arms = 5;
    return (
        <>
            <circle cx={CX} cy={CY} r="48" fill="rgba(0,0,0,0.3)" stroke="rgba(255,255,255,0.04)" strokeWidth="0.5" />
            {/* Spiral arms */}
            <g transform={`rotate(${p.rotation} ${CX} ${CY})`}>
                {Array.from({ length: arms }, (_, arm) => {
                    const baseAngle = (arm / arms) * 360;
                    const pts = Array.from({ length: 20 }, (_, j) => {
                        const t = j / 19;
                        const r = 8 + t * 36;
                        const spiralAngle = baseAngle + t * 120; // 120° of spiral
                        const rad = (spiralAngle - 90) * Math.PI / 180;
                        return `${j === 0 ? "M" : "L"}${(CX + Math.cos(rad) * r).toFixed(1)},${(CY + Math.sin(rad) * r).toFixed(1)}`;
                    }).join(" ");
                    const opacity = p.isPlaying ? 0.15 : 0.06;
                    return <path key={arm} d={pts} fill="none" stroke={col} strokeWidth="1.2" opacity={opacity} strokeLinecap="round" />;
                })}
            </g>
            {/* Progress ring */}
            <circle cx={CX} cy={CY} r={R} fill="none" stroke="rgba(255,255,255,0.03)" strokeWidth="2"
                transform={`rotate(-90 ${CX} ${CY})`} />
            <circle cx={CX} cy={CY} r={R} fill="none" stroke={col} strokeWidth="2" strokeLinecap="round"
                strokeDasharray={C} strokeDashoffset={off} transform={`rotate(-90 ${CX} ${CY})`}
                style={{ transition: "stroke-dashoffset 0.3s linear" }} opacity="0.6" />
            {/* Center */}
            <circle cx={CX} cy={CY} r="14" fill="rgba(0,0,0,0.4)" stroke={`${p.color}20`} strokeWidth="0.5" />
            <CenterTime p={p} />
        </>
    );
}

// ─── 19. Dot Grid ────────────────────────────────────────────────────────

function Dotgrid(p: JogDesignProps) {
    const col = progressColor(p.color, p);
    const dotCount = 48;
    const filledDots = Math.round(p.progress * dotCount);
    return (
        <>
            <circle cx={CX} cy={CY} r="48" fill="rgba(0,0,0,0.3)" stroke="rgba(255,255,255,0.04)" strokeWidth="0.5" />
            {/* Dot ring */}
            {Array.from({ length: dotCount }, (_, i) => {
                const angle = (i / dotCount) * 360;
                const [x, y] = pc(43, angle);
                const lit = i < filledDots;
                return (
                    <circle key={i} cx={x} cy={y} r={lit ? 1.8 : 1.2}
                        fill={lit ? col : "rgba(255,255,255,0.06)"}
                        opacity={lit ? (p.isPlaying ? 0.9 : 0.6) : 1} />
                );
            })}
            {/* Inner dot ring (decorative, rotating) */}
            <g transform={`rotate(${p.rotation} ${CX} ${CY})`}>
                {Array.from({ length: 12 }, (_, i) => {
                    const angle = (i / 12) * 360;
                    const [x, y] = pc(30, angle);
                    return <circle key={i} cx={x} cy={y} r="0.8"
                        fill={i === 0 ? col : "rgba(255,255,255,0.04)"} />;
                })}
            </g>
            {/* Center display */}
            <rect x={CX - 15} y={CY - 9} width="30" height="18" rx="2" fill="rgba(0,0,0,0.5)" stroke="rgba(255,255,255,0.06)" strokeWidth="0.4" />
            <CenterTime p={p} />
        </>
    );
}

// ─── 20. Plasma ──────────────────────────────────────────────────────────

function Plasma(p: JogDesignProps) {
    const col = progressColor(p.color, p);
    const off = C * (1 - p.progress);
    const phase = p.rotation * 0.01;
    return (
        <>
            <defs>
                <radialGradient id={`plm-a-${p.side}`} cx={`${50 + Math.sin(phase) * 15}%`} cy={`${50 + Math.cos(phase) * 15}%`} r="50%">
                    <stop offset="0%" stopColor={p.color} stopOpacity="0.15" />
                    <stop offset="100%" stopColor="transparent" />
                </radialGradient>
                <radialGradient id={`plm-b-${p.side}`} cx={`${50 + Math.cos(phase * 1.3) * 15}%`} cy={`${50 + Math.sin(phase * 1.7) * 15}%`} r="40%">
                    <stop offset="0%" stopColor="#ff00ff" stopOpacity="0.1" />
                    <stop offset="100%" stopColor="transparent" />
                </radialGradient>
            </defs>
            <circle cx={CX} cy={CY} r="48" fill="rgba(0,0,0,0.3)" />
            {/* Plasma blobs */}
            <circle cx={CX} cy={CY} r="44" fill={`url(#plm-a-${p.side})`} />
            <circle cx={CX} cy={CY} r="44" fill={`url(#plm-b-${p.side})`} />
            {/* Electric arcs */}
            {p.isPlaying && Array.from({ length: 4 }, (_, i) => {
                const baseAngle = (i / 4) * 360 + p.rotation;
                const rad = (baseAngle - 90) * Math.PI / 180;
                const midR = 20 + Math.sin(phase * 3 + i) * 5;
                const midAngle = (baseAngle + 15 * Math.sin(phase * 5 + i * 2) - 90) * Math.PI / 180;
                const mx = CX + Math.cos(midAngle) * midR;
                const my = CY + Math.sin(midAngle) * midR;
                const ex = CX + Math.cos(rad) * 40;
                const ey = CY + Math.sin(rad) * 40;
                return <path key={i} d={`M${CX},${CY} Q${mx.toFixed(1)},${my.toFixed(1)} ${ex.toFixed(1)},${ey.toFixed(1)}`}
                    fill="none" stroke={col} strokeWidth="0.6" opacity="0.3" />;
            })}
            {/* Progress ring */}
            <circle cx={CX} cy={CY} r={R} fill="none" stroke="rgba(255,255,255,0.04)" strokeWidth="2"
                transform={`rotate(-90 ${CX} ${CY})`} />
            <circle cx={CX} cy={CY} r={R} fill="none" stroke={col} strokeWidth="2" strokeLinecap="round"
                strokeDasharray={C} strokeDashoffset={off} transform={`rotate(-90 ${CX} ${CY})`}
                style={{ transition: "stroke-dashoffset 0.3s linear" }} opacity="0.6" />
            {/* Center orb */}
            <circle cx={CX} cy={CY} r="14" fill="rgba(0,0,0,0.4)" />
            <circle cx={CX} cy={CY} r="5" fill={col} opacity={p.isPlaying ? 0.15 : 0.05} />
            <CenterTime p={p} />
        </>
    );
}

// ─── Renderer Map ────────────────────────────────────────────────────────

export const JOG_RENDERERS: Record<JogwheelStyle, (p: JogDesignProps) => React.ReactNode> = {
    classic: Classic,
    vinyl: Vinyl,
    cdj: CDJ,
    minimal: Minimal,
    neon: Neon,
    radar: Radar,
    techno: Techno,
    retro: Retro,
    holo: Holo,
    spectrum: Spectrum,
    carbon: Carbon,
    laser: Laser,
    pulse: Pulse,
    eclipse: Eclipse,
    circuit: Circuit,
    waveform: Waveform,
    crystal: Crystal,
    vortex: Vortex,
    dotgrid: Dotgrid,
    plasma: Plasma,
};
