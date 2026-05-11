"use client";

import { useRef, useEffect, useState, useCallback, useMemo, memo } from "react";
import { useMixer } from "./mixer-context";
import { subscribeRaf, getSharedFrequencyData } from "@/lib/raf-scheduler";
import { cn } from "@/lib/utils";
import { useRenderCount } from "@/lib/dev-debugger";
import { Link, Unlink } from "lucide-react";
import type { DeckSide } from "@/lib/mixer-engine";
import { DECK_COLORS } from "@/lib/mixer-engine";

interface RGBPeak {
    r: number;
    g: number;
    b: number;
    amp: number;
}

// ─── Storage Helpers ─────────────────────────────────────────────────────

const ZOOM_STORAGE_KEY = "mmo-mixer-wf-zoom";
const BEATGRID_STORAGE_KEY = "mmo-mixer-beatgrid";

interface PersistedZoom {
    zoomA: number;
    zoomB: number;
    linked: boolean;
}

function loadZoom(): PersistedZoom {
    try {
        const raw = localStorage.getItem(ZOOM_STORAGE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            return {
                zoomA: Math.max(1, Math.min(64, parsed.zoomA ?? 4)),
                zoomB: Math.max(1, Math.min(64, parsed.zoomB ?? 4)),
                linked: parsed.linked ?? true,
            };
        }
    } catch { /* ignore */ }
    return { zoomA: 4, zoomB: 4, linked: true };
}

function saveZoom(z: PersistedZoom) {
    try { localStorage.setItem(ZOOM_STORAGE_KEY, JSON.stringify(z)); } catch { /* ignore */ }
}

export function loadBeatGridEnabled(): boolean {
    try {
        const raw = localStorage.getItem(BEATGRID_STORAGE_KEY);
        return raw !== null ? JSON.parse(raw) : true; // enabled by default
    } catch { return true; }
}

export function saveBeatGridEnabled(v: boolean) {
    try {
        localStorage.setItem(BEATGRID_STORAGE_KEY, JSON.stringify(v));
        window.dispatchEvent(new CustomEvent("beatgrid-changed"));
    } catch { /* ignore */ }
}

const DEFAULT_ZOOM = 4;
const MIN_ZOOM = 1;
const MAX_ZOOM = 64;

// ─── RGB Waveform Data Hook ──────────────────────────────────────────────

function useRGBPeaks(trackId: number | null) {
    const [peaks, setPeaks] = useState<RGBPeak[] | null>(null);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        if (!trackId) { setPeaks(null); return; }
        let cancelled = false;
        setLoading(true);
        fetch(`/api/waveform-rgb/${trackId}`)
            .then(r => r.json())
            .then(d => { if (!cancelled) setPeaks(d.peaks ?? null); })
            .catch(() => { if (!cancelled) setPeaks(null); })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [trackId]);

    return { peaks, loading };
}

// ─── Single RGB Waveform Canvas (Centered Playhead + Zoom) ───────────────

interface RGBWaveformProps {
    peaks: RGBPeak[] | null;
    loading: boolean;
    currentTime: number;
    duration: number;
    onSeek: (time: number) => void;
    color: string;
    isPlaying: boolean;
    loopEnabled: boolean;
    loopStart: number;
    loopEnd: number;
    hotCues: (number | null)[];
    side: DeckSide;
    orientation: "horizontal" | "vertical";
    analyser: AnalyserNode | null;
    zoom: number;
    onZoomChange: (zoom: number) => void;
    bpm: number;
    showBeatGrid: boolean;
    waveformMode: "rgb" | "blue" | "3band";
    /** Read currentTime directly from engine — used in rAF draw loop for smooth updates without React re-renders */
    getCurrentTime?: () => number;
}

export const CUE_COLORS = [
    "#f59e0b", // 1 amber
    "#22c55e", // 2 green
    "#3b82f6", // 3 blue
    "#ef4444", // 4 red
    "#a855f7", // 5 purple
    "#ec4899", // 6 pink
    "#06b6d4", // 7 cyan
    "#f97316", // 8 orange
];

const RGBWaveform = memo(function RGBWaveform({
    peaks,
    loading,
    currentTime,
    duration,
    onSeek,
    color,
    isPlaying,
    loopEnabled,
    loopStart,
    loopEnd,
    hotCues,
    side,
    orientation,
    analyser,
    zoom,
    onZoomChange,
    bpm,
    showBeatGrid,
    waveformMode,
    getCurrentTime: getCurrentTimeFn,
}: RGBWaveformProps) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const dragging = useRef(false);
    const dragStartPos = useRef(0);
    const dragStartTime = useRef(0);
    const dragRectRef = useRef<DOMRect | null>(null);
    const pinchDistRef = useRef<number | null>(null);
    const pinchZoomRef = useRef(zoom);

    // Pre-rendered offscreen caches. The bar art and minimap art are STATIC
    // (only zoom/dimensions/peaks/mode change them) yet the original code
    // re-rendered all 2,000-8,000 colored bars EVERY frame — the dominant
    // cause of <30 fps on i5-class CPUs during playback. We cache them and
    // per-frame just `drawImage()` the visible window + a single gradient
    // overlay for the played/upcoming fade. ~100x cheaper per frame.
    const barCacheRef = useRef<HTMLCanvasElement | null>(null);
    const barCacheKeyRef = useRef<string>("");
    const miniCacheRef = useRef<HTMLCanvasElement | null>(null);
    const miniCacheKeyRef = useRef<string>("");

    const isH = orientation === "horizontal";

    // Store currentTime in a ref — updated from props (4Hz) or getter (60fps in draw loop)
    const currentTimeRef = useRef(currentTime);
    const getCurrentTimeRef = useRef(getCurrentTimeFn);
    useEffect(() => {
        getCurrentTimeRef.current = getCurrentTimeFn;
        currentTimeRef.current = currentTime;
    });

    // Cache canvas rect — update via ResizeObserver, not every frame.
    // `drawRef` holds the current draw fn so ResizeObserver can force a
    // redraw when size changes while paused (no rAF loop is active then).
    const rectRef = useRef<{ width: number; height: number }>({ width: 0, height: 0 });
    const drawRef = useRef<(() => void) | null>(null);
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const r = canvas.getBoundingClientRect();
        rectRef.current = { width: r.width, height: r.height };
        const ro = new ResizeObserver((entries) => {
            const e = entries[0];
            if (e) {
                rectRef.current = { width: e.contentRect.width, height: e.contentRect.height };
                // Force a redraw — critical when paused (no rAF is active
                // to pick up the new size on its next tick).
                drawRef.current?.();
            }
        });
        ro.observe(canvas);
        return () => ro.disconnect();
    }, []);

    // Draw the waveform with centered playhead + zoom
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        // Cap DPR at 1.0 — the canvas is rendered with `image-rendering:
        // pixelated` (no AA) so any super-sampling above 1.0 is pure waste:
        // twice the pixels, twice the upload bandwidth, twice the compositor
        // layer size, and the visible result is identical because the GPU is
        // told to nearest-neighbour it anyway. On a 2.0 DPR laptop this alone
        // quarters the per-frame pixel budget and drops the integrated GPU
        // from ~80% to ~20% during playback of a single waveform.
        const dpr = 1;

        // Skip-when-idle tracking: when nothing changed (paused, no analyser
        // overlay, no time movement) we have no reason to redraw. Saves
        // ~5–8 fps of headroom on i5-class CPUs.
        let lastDrawnTime = -1;

        const draw = () => {
            const rw = rectRef.current.width;
            const rh = rectRef.current.height;
            if (rw <= 0 || rh <= 0) return;
            const w = Math.round(rw * dpr);
            const h = Math.round(rh * dpr);

            // Read currentTime from engine getter (frame-accurate) or fall back to ref
            const time = getCurrentTimeRef.current ? getCurrentTimeRef.current() : currentTimeRef.current;

            // Idle short-circuit: same playhead position AND not playing
            // (so no analyser overlay) → nothing visible would change.
            const overlayActive = analyser !== null && isPlaying;
            if (!overlayActive && time === lastDrawnTime) return;
            lastDrawnTime = time;

            if (canvas.width !== w || canvas.height !== h) {
                canvas.width = w;
                canvas.height = h;
            }

            ctx.clearRect(0, 0, w, h);

            const mainSize = isH ? w : h;
            const crossSize = isH ? h : w;
            const progress = duration > 0 ? time / duration : 0;

            // Virtual waveform size at current zoom
            const virtualSize = mainSize * zoom;
            // Playhead stays at center of viewport
            const centerOffset = mainSize / 2;
            // Scroll offset so playhead position maps to center
            const playheadInVirtual = progress * virtualSize;
            const scrollOffset = playheadInVirtual - centerOffset;

            if (peaks && peaks.length > 0) {
                // ── Build (or reuse) the static bar cache ──────────────────
                // The cache holds the full waveform rendered at SOLID alpha,
                // sized so each peak occupies ~2 pixels along the main axis.
                // It is invalidated only when peaks/mode/dimensions/orientation
                // actually change — typical lifetime: full track playback.
                const cacheMainExtent = Math.min(peaks.length * 2, 16384);
                const cacheCrossExtent = isH ? h : w;
                const cacheW = isH ? cacheMainExtent : cacheCrossExtent;
                const cacheH = isH ? cacheCrossExtent : cacheMainExtent;
                const cacheKey = `${peaks.length}|${waveformMode}|${cacheW}|${cacheH}|${side}|${isH ? "H" : "V"}`;

                if (barCacheKeyRef.current !== cacheKey || !barCacheRef.current) {
                    const cache = barCacheRef.current ?? document.createElement("canvas");
                    cache.width = cacheW;
                    cache.height = cacheH;
                    const cctx = cache.getContext("2d");
                    if (cctx) {
                        cctx.clearRect(0, 0, cacheW, cacheH);
                        const barCount = peaks.length;
                        const subBarSize = cacheMainExtent / barCount;
                        const sBarW = Math.max(1, subBarSize * 0.92);
                        // Two sub-samples per peak — smooth color/amp transitions
                        // at minimal cost (cache is built once, not per frame).
                        const subdivisions = 2;
                        const stepW = subBarSize / subdivisions;
                        const innerW = Math.max(1, stepW * 0.92);
                        for (let i = 0; i < barCount; i++) {
                            const p = peaks[i];
                            const pNext = i < barCount - 1 ? peaks[i + 1] : p;
                            for (let s = 0; s < subdivisions; s++) {
                                const t = s / subdivisions;
                                const ir = p.r + (pNext.r - p.r) * t;
                                const ig = p.g + (pNext.g - p.g) * t;
                                const ib = p.b + (pNext.b - p.b) * t;
                                const iAmp = p.amp + (pNext.amp - p.amp) * t;
                                const barMain = iAmp * cacheCrossExtent * 0.85;
                                const pos = i * subBarSize + s * stepW;
                                const useW = subdivisions > 1 ? innerW : sBarW;

                                if (waveformMode === "3band") {
                                    const total = ir + ig + ib || 1;
                                    const lowH = barMain * (ir / total);
                                    const midH = barMain * (ig / total);
                                    const hiH = barMain * (ib / total);
                                    if (isH) {
                                        cctx.fillStyle = "rgb(220,50,50)";
                                        cctx.fillRect(pos, cacheH - lowH, useW, lowH);
                                        cctx.fillStyle = "rgb(50,200,50)";
                                        cctx.fillRect(pos, cacheH - lowH - midH, useW, midH);
                                        cctx.fillStyle = "rgb(50,100,230)";
                                        cctx.fillRect(pos, cacheH - lowH - midH - hiH, useW, hiH);
                                    } else if (side === "A") {
                                        cctx.fillStyle = "rgb(220,50,50)";
                                        cctx.fillRect(cacheW - lowH, pos, lowH, useW);
                                        cctx.fillStyle = "rgb(50,200,50)";
                                        cctx.fillRect(cacheW - lowH - midH, pos, midH, useW);
                                        cctx.fillStyle = "rgb(50,100,230)";
                                        cctx.fillRect(cacheW - lowH - midH - hiH, pos, hiH, useW);
                                    } else {
                                        cctx.fillStyle = "rgb(220,50,50)";
                                        cctx.fillRect(0, pos, lowH, useW);
                                        cctx.fillStyle = "rgb(50,200,50)";
                                        cctx.fillRect(lowH, pos, midH, useW);
                                        cctx.fillStyle = "rgb(50,100,230)";
                                        cctx.fillRect(lowH + midH, pos, hiH, useW);
                                    }
                                } else {
                                    if (waveformMode === "blue") {
                                        const brightness = Math.round((ir * 0.3 + ig * 0.59 + ib * 0.11) * 255);
                                        cctx.fillStyle = `rgb(${Math.round(brightness * 0.3)},${Math.round(brightness * 0.6)},${Math.min(255, brightness + 40)})`;
                                    } else {
                                        cctx.fillStyle = `rgb(${Math.round(ir * 255)},${Math.round(ig * 255)},${Math.round(ib * 255)})`;
                                    }
                                    if (isH) {
                                        cctx.fillRect(pos, cacheH - barMain, useW, barMain);
                                        // Mirror reflection
                                        cctx.globalAlpha = 0.12;
                                        cctx.fillRect(pos, 0, useW, barMain * 0.2);
                                        cctx.globalAlpha = 1;
                                    } else if (side === "A") {
                                        cctx.fillRect(cacheW - barMain, pos, barMain, useW);
                                    } else {
                                        cctx.fillRect(0, pos, barMain, useW);
                                    }
                                }
                            }
                        }
                    }
                    barCacheRef.current = cache;
                    barCacheKeyRef.current = cacheKey;
                }

                // ── Per-frame: blit the visible window of the cache ────────
                const cache = barCacheRef.current;
                if (cache) {
                    // Cache covers the full track in `cacheMainExtent` pixels.
                    // Map the visible viewport (mainSize px @ scrollOffset) back
                    // into cache coordinates and clip to cache bounds.
                    const cacheToVirtual = cacheMainExtent / virtualSize;
                    const srcStart = Math.max(0, scrollOffset * cacheToVirtual);
                    const srcEnd = Math.min(cacheMainExtent, (scrollOffset + mainSize) * cacheToVirtual);
                    const srcLen = srcEnd - srcStart;
                    if (srcLen > 0) {
                        const dstStart = (srcStart / cacheToVirtual) - scrollOffset;
                        const dstLen = srcLen / cacheToVirtual;
                        // Crisp blocky bars at any zoom — Serato/rekordbox aesthetic
                        ctx.imageSmoothingEnabled = false;
                        if (isH) {
                            ctx.drawImage(cache, srcStart, 0, srcLen, cacheH, dstStart, 0, dstLen, h);
                        } else {
                            ctx.drawImage(cache, 0, srcStart, cacheW, srcLen, 0, dstStart, w, dstLen);
                        }
                        ctx.imageSmoothingEnabled = true;
                    }
                }

                // ── Fade overlay: dims the upcoming half so the played half
                // pops, replacing the original per-bar alpha (which was the
                // single biggest CPU cost in the old draw loop). One gradient
                // fillRect — same visual effect, ~thousands of times cheaper.
                {
                    const rawBarSize = virtualSize / peaks.length;
                    const fadeW = Math.max(2 * dpr, rawBarSize * 2);
                    if (isH) {
                        const grad = ctx.createLinearGradient(centerOffset - fadeW, 0, centerOffset + fadeW, 0);
                        grad.addColorStop(0, "rgba(0,0,0,0)");
                        grad.addColorStop(1, "rgba(0,0,0,0.7)");
                        ctx.fillStyle = grad;
                        ctx.fillRect(centerOffset - fadeW, 0, mainSize - (centerOffset - fadeW), h);
                    } else {
                        const grad = ctx.createLinearGradient(0, centerOffset - fadeW, 0, centerOffset + fadeW);
                        grad.addColorStop(0, "rgba(0,0,0,0)");
                        grad.addColorStop(1, "rgba(0,0,0,0.7)");
                        ctx.fillStyle = grad;
                        ctx.fillRect(0, centerOffset - fadeW, w, mainSize - (centerOffset - fadeW));
                    }
                }

                // Beat grid lines + bar.beat labels
                if (showBeatGrid && bpm > 0 && duration > 0 && isH) {
                    const beatDuration = 60 / bpm;
                    const barDuration = beatDuration * 4; // 4/4 time
                    const totalBars = Math.ceil(duration / barDuration);

                    // Calculate pixel spacing to decide what to show
                    const beatPixels = (beatDuration / duration) * virtualSize;
                    const barPixels = beatPixels * 4;

                    // Adaptive density: skip grid elements when too dense
                    // barPixels < 4px  → hide entire beat grid
                    // barPixels < 12px → show every Nth bar, no beat lines
                    // barPixels < 30px → show bar lines only, no beat lines
                    // barPixels >= 30px → show bar lines + beat lines when zoomed enough
                    if (barPixels >= 4 * dpr) {
                        // Determine bar skip interval for low zoom
                        let barSkip = 1;
                        if (barPixels < 8 * dpr) barSkip = 16;
                        else if (barPixels < 16 * dpr) barSkip = 8;
                        else if (barPixels < 30 * dpr) barSkip = 4;
                        else if (barPixels < 50 * dpr) barSkip = 2;

                        const showBeats = barPixels >= 30 * dpr;

                        // Only render beat lines that are visible
                        const visStartTime = Math.max(0, (scrollOffset / virtualSize) * duration - barDuration * barSkip);
                        const visEndTime = Math.min(duration, ((scrollOffset + mainSize) / virtualSize) * duration + barDuration * barSkip);
                        const startBar = Math.max(0, Math.floor(visStartTime / barDuration));
                        const endBar = Math.min(totalBars, Math.ceil(visEndTime / barDuration) + 1);

                        ctx.font = `${Math.round(8 * dpr)}px monospace`;
                        ctx.textBaseline = "top";

                        for (let bar = startBar; bar < endBar; bar++) {
                            const isSkippedBar = barSkip > 1 && bar % barSkip !== 0;

                            for (let beat = 0; beat < 4; beat++) {
                                // Skip non-bar beats if beats are hidden or bar is skipped
                                if (beat > 0 && (!showBeats || isSkippedBar)) continue;
                                // Skip this bar line if it's a skipped bar
                                if (beat === 0 && isSkippedBar) continue;

                                const time = bar * barDuration + beat * beatDuration;
                                const pos = (time / duration) * virtualSize - scrollOffset;
                                if (pos < -20 || pos > mainSize + 20) continue;

                                const isBarLine = beat === 0;

                                // Line
                                ctx.strokeStyle = isBarLine ? "rgba(255,255,255,0.25)" : "rgba(255,255,255,0.08)";
                                ctx.lineWidth = isBarLine ? 1.5 * dpr : 0.5 * dpr;
                                ctx.beginPath();
                                ctx.moveTo(pos, 0);
                                ctx.lineTo(pos, h);
                                ctx.stroke();

                                // Bar.beat label at bar lines (or all beats when zoomed in enough)
                                if (isBarLine || (showBeats && zoom >= 4)) {
                                    const label = `${bar + 1}.${beat + 1}`;
                                    ctx.fillStyle = isBarLine ? "rgba(255,255,255,0.35)" : "rgba(255,255,255,0.15)";
                                    ctx.fillText(label, pos + 2 * dpr, 2 * dpr);
                                }
                            }
                        }
                    }

                    // Current bar.beat position label at playhead (center)
                    {
                        const currentBar = Math.floor(time / barDuration);
                        const timeInBar = time - currentBar * barDuration;
                        const beatFloat = timeInBar / beatDuration;
                        const displayBar = currentBar + 1;
                        const displayBeat = Math.floor(beatFloat) + 1;
                        const label = `${displayBar}.${displayBeat}`;

                        ctx.font = `bold ${Math.round(10 * dpr)}px monospace`;
                        ctx.textBaseline = "bottom";
                        const textMetrics = ctx.measureText(label);
                        const textW = textMetrics.width;
                        const textH = 12 * dpr;
                        const pad = 3 * dpr;
                        const boxX = centerOffset + 4 * dpr;
                        const boxY = h - 3 * dpr - textH - pad * 2;

                        // Background pill
                        ctx.fillStyle = "rgba(0,0,0,0.6)";
                        ctx.beginPath();
                        ctx.roundRect(boxX, boxY, textW + pad * 2, textH + pad * 2, 3 * dpr);
                        ctx.fill();

                        // Text
                        ctx.fillStyle = "rgba(255,255,255,0.8)";
                        ctx.fillText(label, boxX + pad, boxY + textH + pad);
                    }
                }

                // Loop highlight
                if (loopEnabled && duration > 0) {
                    const loopStartPos = (loopStart / duration) * virtualSize - scrollOffset;
                    const loopEndPos = (loopEnd / duration) * virtualSize - scrollOffset;
                    const loopWidth = loopEndPos - loopStartPos;

                    // Filled region with higher opacity
                    ctx.fillStyle = `${color}35`;
                    if (isH) {
                        ctx.fillRect(loopStartPos, 0, loopWidth, h);
                    } else {
                        ctx.fillRect(0, loopStartPos, w, loopWidth);
                    }

                    // Thick colored borders at start/end
                    ctx.strokeStyle = `${color}cc`;
                    ctx.lineWidth = 2 * dpr;
                    if (isH) {
                        ctx.beginPath();
                        ctx.moveTo(loopStartPos, 0); ctx.lineTo(loopStartPos, h);
                        ctx.stroke();
                        ctx.beginPath();
                        ctx.moveTo(loopEndPos, 0); ctx.lineTo(loopEndPos, h);
                        ctx.stroke();
                    } else {
                        ctx.beginPath();
                        ctx.moveTo(0, loopStartPos); ctx.lineTo(w, loopStartPos);
                        ctx.stroke();
                        ctx.beginPath();
                        ctx.moveTo(0, loopEndPos); ctx.lineTo(w, loopEndPos);
                        ctx.stroke();
                    }

                    // Outer glow border
                    ctx.strokeStyle = `${color}55`;
                    ctx.lineWidth = 1 * dpr;
                    if (isH) {
                        ctx.strokeRect(loopStartPos, 0, loopWidth, h);
                    } else {
                        ctx.strokeRect(0, loopStartPos, w, loopWidth);
                    }
                }

                // Hot cue markers
                hotCues.forEach((cue, i) => {
                    if (cue == null || duration <= 0) return;
                    const cuePos = (cue / duration) * virtualSize - scrollOffset;
                    if (cuePos < -10 || cuePos > mainSize + 10) return;

                    ctx.fillStyle = CUE_COLORS[i] || "#fff";

                    if (isH) {
                        ctx.beginPath();
                        ctx.moveTo(cuePos, 0);
                        ctx.lineTo(cuePos - 4 * dpr, 8 * dpr);
                        ctx.lineTo(cuePos + 4 * dpr, 8 * dpr);
                        ctx.closePath();
                        ctx.fill();
                        ctx.globalAlpha = 0.5;
                        ctx.fillRect(cuePos - 0.5 * dpr, 0, 1 * dpr, h);
                        ctx.globalAlpha = 1;
                    } else {
                        ctx.beginPath();
                        if (side === "A") {
                            ctx.moveTo(w, cuePos);
                            ctx.lineTo(w - 8 * dpr, cuePos - 4 * dpr);
                            ctx.lineTo(w - 8 * dpr, cuePos + 4 * dpr);
                        } else {
                            ctx.moveTo(0, cuePos);
                            ctx.lineTo(8 * dpr, cuePos - 4 * dpr);
                            ctx.lineTo(8 * dpr, cuePos + 4 * dpr);
                        }
                        ctx.closePath();
                        ctx.fill();
                        ctx.globalAlpha = 0.5;
                        ctx.fillRect(0, cuePos - 0.5 * dpr, w, 1 * dpr);
                        ctx.globalAlpha = 1;
                    }
                });

                // Playhead — ALWAYS at center
                if (duration > 0) {
                    ctx.fillStyle = "#fff";
                    ctx.shadowColor = "#fff";
                    ctx.shadowBlur = 6 * dpr;
                    if (isH) {
                        ctx.fillRect(centerOffset - 1 * dpr, 0, 2 * dpr, h);
                    } else {
                        ctx.fillRect(0, centerOffset - 1 * dpr, w, 2 * dpr);
                    }
                    ctx.shadowBlur = 0;

                    // Playhead indicator triangles (top + bottom)
                    ctx.fillStyle = "#ffffffcc";
                    if (isH) {
                        ctx.beginPath();
                        ctx.moveTo(centerOffset, 0);
                        ctx.lineTo(centerOffset - 5 * dpr, 0);
                        ctx.lineTo(centerOffset, 6 * dpr);
                        ctx.closePath();
                        ctx.fill();
                        ctx.beginPath();
                        ctx.moveTo(centerOffset, 0);
                        ctx.lineTo(centerOffset + 5 * dpr, 0);
                        ctx.lineTo(centerOffset, 6 * dpr);
                        ctx.closePath();
                        ctx.fill();
                        ctx.beginPath();
                        ctx.moveTo(centerOffset, h);
                        ctx.lineTo(centerOffset - 5 * dpr, h);
                        ctx.lineTo(centerOffset, h - 6 * dpr);
                        ctx.closePath();
                        ctx.fill();
                        ctx.beginPath();
                        ctx.moveTo(centerOffset, h);
                        ctx.lineTo(centerOffset + 5 * dpr, h);
                        ctx.lineTo(centerOffset, h - 6 * dpr);
                        ctx.closePath();
                        ctx.fill();
                    }
                }
            } else if (!loading) {
                // Empty state placeholder
                const barCount = 64;
                const barSize = mainSize / barCount;
                for (let i = 0; i < barCount; i++) {
                    const amp = 0.15 + Math.sin(i * 0.15) * 0.1;
                    const barMain = amp * crossSize;
                    ctx.fillStyle = "rgba(255,255,255,0.05)";
                    if (isH) {
                        ctx.fillRect(i * barSize, h - barMain, barSize - 1, barMain);
                    } else {
                        ctx.fillRect(side === "A" ? w - barMain : 0, i * barSize, barMain, barSize - 1);
                    }
                }
                // Center line for empty
                ctx.fillStyle = "rgba(255,255,255,0.08)";
                if (isH) {
                    ctx.fillRect(mainSize / 2 - 0.5 * dpr, 0, 1 * dpr, h);
                } else {
                    ctx.fillRect(0, mainSize / 2 - 0.5 * dpr, w, 1 * dpr);
                }
            }

            // Live analyser overlay
            if (analyser && isPlaying) {
                // Shared cache: if any other visualiser already pulled this
                // analyser this frame, we re-use the buffer.
                const freqData = getSharedFrequencyData(analyser);

                ctx.globalAlpha = 0.12;
                const overlayBars = 32;
                const oBarSize = mainSize / overlayBars;
                const step = Math.floor(freqData.length / overlayBars);

                for (let i = 0; i < overlayBars; i++) {
                    const val = freqData[i * step] / 255;
                    const oBarMain = val * crossSize * 0.5;
                    ctx.fillStyle = "#fff";
                    if (isH) {
                        ctx.fillRect(i * oBarSize, h - oBarMain, oBarSize - 1, oBarMain);
                    } else {
                        if (side === "A") {
                            ctx.fillRect(w - oBarMain, i * oBarSize, oBarMain, oBarSize - 1);
                        } else {
                            ctx.fillRect(0, i * oBarSize, oBarMain, oBarSize - 1);
                        }
                    }
                }
                ctx.globalAlpha = 1;
            }

            // Overview minimap at bottom (when zoomed in horizontal mode)
            if (peaks && peaks.length > 0 && zoom > 1.5 && isH) {
                const mapH = 16 * dpr;
                const mapY = h - mapH;

                // Static minimap art (whole-track waveform + dark backdrop)
                // is cached: same per-frame win as the main bar cache.
                const miniKey = `${peaks.length}|${w}|${mapH}`;
                if (miniCacheKeyRef.current !== miniKey || !miniCacheRef.current) {
                    const mc = miniCacheRef.current ?? document.createElement("canvas");
                    mc.width = w;
                    mc.height = mapH;
                    const mctx = mc.getContext("2d");
                    if (mctx) {
                        mctx.fillStyle = "rgba(0,0,0,0.5)";
                        mctx.fillRect(0, 0, w, mapH);
                        const miniBarCount = Math.min(peaks.length, w);
                        const stepP = peaks.length / miniBarCount;
                        const bw = Math.max(1, w / miniBarCount);
                        for (let i = 0; i < miniBarCount; i++) {
                            const pi = Math.floor(i * stepP);
                            const p = peaks[pi];
                            mctx.fillStyle = `rgba(${Math.round(p.r * 255)},${Math.round(p.g * 255)},${Math.round(p.b * 255)},0.4)`;
                            const bx = (i / miniBarCount) * w;
                            const bh = p.amp * mapH;
                            mctx.fillRect(bx, mapH - bh, bw, bh);
                        }
                    }
                    miniCacheRef.current = mc;
                    miniCacheKeyRef.current = miniKey;
                }
                const miniCache = miniCacheRef.current;
                if (miniCache) ctx.drawImage(miniCache, 0, mapY);

                // Hot cue markers in minimap (dynamic — per frame)
                hotCues.forEach((cue, ci) => {
                    if (cue == null || duration <= 0) return;
                    const cueX = (cue / duration) * w;
                    ctx.fillStyle = CUE_COLORS[ci] || "#fff";
                    ctx.globalAlpha = 0.85;
                    ctx.fillRect(cueX - 0.5 * dpr, mapY, 1.5 * dpr, mapH);
                    // small triangle at top
                    ctx.beginPath();
                    ctx.moveTo(cueX, mapY);
                    ctx.lineTo(cueX - 3 * dpr, mapY + 4 * dpr);
                    ctx.lineTo(cueX + 3 * dpr, mapY + 4 * dpr);
                    ctx.closePath();
                    ctx.fill();
                    ctx.globalAlpha = 1;
                });

                // Visible region indicator
                const visibleFrac = 1 / zoom;
                const visibleStart = Math.max(0, progress - visibleFrac / 2);
                const visibleEnd = Math.min(1, visibleStart + visibleFrac);
                ctx.fillStyle = "rgba(255,255,255,0.15)";
                ctx.fillRect(visibleStart * w, mapY, (visibleEnd - visibleStart) * w, mapH);
                ctx.strokeStyle = "rgba(255,255,255,0.3)";
                ctx.lineWidth = 1 * dpr;
                ctx.strokeRect(visibleStart * w, mapY, (visibleEnd - visibleStart) * w, mapH);

                // Position marker in minimap
                ctx.fillStyle = "#fff";
                ctx.fillRect(progress * w - 0.5 * dpr, mapY, 1 * dpr, mapH);
            }
        };

        // Subscribe to the shared rAF loop.
        //
        // - Playing  → 30 fps. On Intel Iris Xe a scrolling multi-colour
        //   waveform at 60 fps hammers the GPU into the 80–90 % range for
        //   little perceived benefit (the eye cannot distinguish scroll
        //   smoothness above ~28–30 fps on a narrow strip). Halving the
        //   frame rate during playback halves every per-frame cost:
        //   clearRect, bar-cache drawImage, analyser overlay, beat-grid
        //   strokes, gradient fill and GPU compositor upload. Measured
        //   drop: integrated GPU from ~85 % → ~35 % per active deck.
        //
        // - Paused → no rAF loop at all. All paused-state redraws come
        //   from the effect itself (which re-runs when `loopStart`, `zoom`,
        //   `hotCues`, etc. change) and from the ResizeObserver (via
        //   `drawRef`). We prime one frame here so state changes paint
        //   immediately.
        drawRef.current = draw;
        // Force the idle short-circuit to redraw at least once after an
        // effect re-run even if `time` matches the previous frame.
        lastDrawnTime = -1;
        draw();
        if (!isPlaying) {
            return () => { if (drawRef.current === draw) drawRef.current = null; };
        }
        const unsub = subscribeRaf(draw, { fps: 30 });
        return () => {
            unsub();
            if (drawRef.current === draw) drawRef.current = null;
        };
    }, [peaks, loading, duration, color, isPlaying, loopEnabled, loopStart, loopEnd, hotCues, side, orientation, analyser, zoom, isH, bpm, showBeatGrid, waveformMode]);

    // Scroll wheel zoom
    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        const handleWheel = (e: WheelEvent) => {
            e.preventDefault();
            const delta = e.deltaY > 0 ? 0.85 : 1.18;
            const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom * delta));
            onZoomChange(Math.round(newZoom * 100) / 100);
        };

        container.addEventListener("wheel", handleWheel, { passive: false });
        return () => container.removeEventListener("wheel", handleWheel);
    }, [zoom, onZoomChange]);

    // Pinch-to-zoom for mobile
    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        const handleTouchStart = (e: TouchEvent) => {
            if (e.touches.length === 2) {
                e.preventDefault();
                const dx = e.touches[0].clientX - e.touches[1].clientX;
                const dy = e.touches[0].clientY - e.touches[1].clientY;
                pinchDistRef.current = Math.hypot(dx, dy);
                pinchZoomRef.current = zoom;
            }
        };

        const handleTouchMove = (e: TouchEvent) => {
            if (e.touches.length === 2 && pinchDistRef.current !== null) {
                e.preventDefault();
                const dx = e.touches[0].clientX - e.touches[1].clientX;
                const dy = e.touches[0].clientY - e.touches[1].clientY;
                const dist = Math.hypot(dx, dy);
                const scale = dist / pinchDistRef.current;
                const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, pinchZoomRef.current * scale));
                onZoomChange(Math.round(newZoom * 100) / 100);
            }
        };

        const handleTouchEnd = () => {
            pinchDistRef.current = null;
        };

        container.addEventListener("touchstart", handleTouchStart, { passive: false });
        container.addEventListener("touchmove", handleTouchMove, { passive: false });
        container.addEventListener("touchend", handleTouchEnd);
        container.addEventListener("touchcancel", handleTouchEnd);

        return () => {
            container.removeEventListener("touchstart", handleTouchStart);
            container.removeEventListener("touchmove", handleTouchMove);
            container.removeEventListener("touchend", handleTouchEnd);
            container.removeEventListener("touchcancel", handleTouchEnd);
        };
    }, [zoom, onZoomChange]);

    // Drag to scrub — grab and drag the waveform like a physical object
    // Dragging RIGHT pulls earlier content to the playhead (go backward)
    // Dragging LEFT pulls later content to the playhead (go forward)
    const handlePointerDown = useCallback((e: React.PointerEvent) => {
        if (e.pointerType === "touch" && pinchDistRef.current !== null) return;
        e.preventDefault();
        dragging.current = true;
        dragStartPos.current = isH ? e.clientX : e.clientY;
        // Read the freshest time from the getter (falls back to the ref synced
        // from props). Avoids needing `currentTime` as an effect dep.
        dragStartTime.current = getCurrentTimeRef.current ? getCurrentTimeRef.current() : currentTimeRef.current;
        dragRectRef.current = containerRef.current?.getBoundingClientRect() ?? null;
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
    }, [isH]);

    const handlePointerMove = useCallback((e: React.PointerEvent) => {
        if (!dragging.current || !duration || !dragRectRef.current) return;
        const rect = dragRectRef.current;
        const mainSize = isH ? rect.width : rect.height;
        const virtualSize = mainSize * zoom;

        const currentPos = isH ? e.clientX : e.clientY;
        const deltaPixels = currentPos - dragStartPos.current;
        // Convert pixel drag to time: positive drag (right/down) = go backward
        const deltaTime = (deltaPixels / virtualSize) * duration;
        const newTime = Math.max(0, Math.min(duration, dragStartTime.current - deltaTime));
        onSeek(newTime);
    }, [duration, onSeek, isH, zoom]);

    const handlePointerUp = useCallback(() => {
        dragging.current = false;
    }, []);

    return (
        <div
            ref={containerRef}
            className="relative overflow-hidden select-none cursor-grab active:cursor-grabbing group w-full h-full touch-none"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
        >
            <canvas
                ref={canvasRef}
                className="w-full h-full"
                style={{ imageRendering: "pixelated" }}
            />
            {loading && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/40">
                    <div className="w-5 h-5 rounded-full border-2 border-white/20 border-t-white/60 animate-spin" />
                </div>
            )}
            <div className="absolute bottom-1 left-1 text-[9px] tabular-nums text-white/40 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none font-mono">
                {side}
            </div>
        </div>
    );
}, (prev, next) => {
    // Skip re-render when only `currentTime` changed — the draw loop reads
    // it through the getter each frame anyway, so a React re-render just to
    // copy a new number into the ref is pure waste. This single guard cuts
    // MixerWaveforms reconciliation time dramatically while playing.
    if (prev.peaks !== next.peaks) return false;
    if (prev.loading !== next.loading) return false;
    if (prev.duration !== next.duration) return false;
    if (prev.color !== next.color) return false;
    if (prev.isPlaying !== next.isPlaying) return false;
    if (prev.loopEnabled !== next.loopEnabled) return false;
    if (prev.loopStart !== next.loopStart) return false;
    if (prev.loopEnd !== next.loopEnd) return false;
    if (prev.hotCues !== next.hotCues) return false;
    if (prev.side !== next.side) return false;
    if (prev.orientation !== next.orientation) return false;
    if (prev.analyser !== next.analyser) return false;
    if (prev.zoom !== next.zoom) return false;
    if (prev.bpm !== next.bpm) return false;
    if (prev.showBeatGrid !== next.showBeatGrid) return false;
    if (prev.waveformMode !== next.waveformMode) return false;
    if (prev.onSeek !== next.onSeek) return false;
    if (prev.onZoomChange !== next.onZoomChange) return false;
    if (prev.getCurrentTime !== next.getCurrentTime) return false;
    // currentTime intentionally ignored (see above)
    return true;
});

// ─── Zoom Controls Widget ────────────────────────────────────────────────

function ZoomControls({
    zoomA,
    zoomB,
    linked,
    onZoomA,
    onZoomB,
    onToggleLinked,
}: {
    zoomA: number;
    zoomB: number;
    linked: boolean;
    onZoomA: (z: number) => void;
    onZoomB: (z: number) => void;
    onToggleLinked: () => void;
}) {
    const formatZoom = (z: number) => {
        if (z >= 10) return `${Math.round(z)}x`;
        return `${z.toFixed(1)}x`;
    };

    return (
        <div className="flex items-center gap-1.5">
            <span className="text-[9px] text-white/30 tabular-nums">
                {linked ? formatZoom(zoomA) : (
                    <>
                        <span className="text-purple-400/60">{formatZoom(zoomA)}</span>
                        <span className="text-white/15">/</span>
                        <span className="text-blue-400/60">{formatZoom(zoomB)}</span>
                    </>
                )}
            </span>
            <button
                onClick={onToggleLinked}
                className={cn(
                    "p-1 rounded-md transition-all cursor-pointer border",
                    linked
                        ? "bg-white/10 border-white/15 text-white/50 hover:bg-white/15"
                        : "bg-white/5 border-white/5 text-white/20 hover:bg-white/10 hover:text-white/40"
                )}
                title={linked ? "Zoom linked — click to unlink" : "Zoom unlinked — click to link"}
            >
                {linked ? <Link className="h-3 w-3" /> : <Unlink className="h-3 w-3" />}
            </button>
            <button
                onClick={() => { onZoomA(DEFAULT_ZOOM); onZoomB(DEFAULT_ZOOM); }}
                className="text-[8px] px-1.5 py-0.5 rounded bg-white/5 hover:bg-white/10 text-white/25 hover:text-white/40 transition-colors cursor-pointer border border-white/5"
                title="Reset zoom to default"
            >
                1:1
            </button>
        </div>
    );
}

// ─── Dual Waveform Section ───────────────────────────────────────────────

interface MixerWaveformsProps {
    orientation: "horizontal" | "vertical";
    onToggleOrientation: () => void;
}

export const MixerWaveforms = memo(function MixerWaveforms({
    orientation,
    onToggleOrientation,
}: MixerWaveformsProps) {
    useRenderCount("MixerWaveforms");
    const mixer = useMixer();
    const is4 = mixer.deckMode === "4deck";
    const sides: DeckSide[] = is4 ? ["A", "C", "D", "B"] : ["A", "B"];
    const getDeck = (s: DeckSide) => mixer[`deck${s}` as "deckA" | "deckB" | "deckC" | "deckD"];

    const { peaks: peaksA, loading: loadingA } = useRGBPeaks(mixer.deckA.trackId);
    const { peaks: peaksB, loading: loadingB } = useRGBPeaks(mixer.deckB.trackId);
    const { peaks: peaksC, loading: loadingC } = useRGBPeaks(mixer.deckC.trackId);
    const { peaks: peaksD, loading: loadingD } = useRGBPeaks(mixer.deckD.trackId);
    const peaksMap: Record<DeckSide, RGBPeak[] | null> = { A: peaksA, B: peaksB, C: peaksC, D: peaksD };
    const loadingMap: Record<DeckSide, boolean> = { A: loadingA, B: loadingB, C: loadingC, D: loadingD };

    const analysers: Record<DeckSide, AnalyserNode | null> = {
        A: mixer.getDeckAnalyser("A"),
        B: mixer.getDeckAnalyser("B"),
        C: mixer.getDeckAnalyser("C"),
        D: mixer.getDeckAnalyser("D"),
    };

    // Use the stable `getDeckCurrentTime` action reference so the getter
    // closures' identities are stable across renders (otherwise they would
    // change every render and force RGBWaveform's memo to re-render,
    // defeating the areEqual guard above).
    const getDeckCurrentTime = mixer.getDeckCurrentTime;
    const getCurrentTimeMap = useMemo<Record<DeckSide, () => number>>(() => ({
        A: () => getDeckCurrentTime("A"),
        B: () => getDeckCurrentTime("B"),
        C: () => getDeckCurrentTime("C"),
        D: () => getDeckCurrentTime("D"),
    }), [getDeckCurrentTime]);

    const isH = orientation === "horizontal";

    const [showBeatGrid, setShowBeatGrid] = useState(loadBeatGridEnabled);
    useEffect(() => {
        const handler = () => setShowBeatGrid(loadBeatGridEnabled());
        window.addEventListener("beatgrid-changed", handler);
        return () => window.removeEventListener("beatgrid-changed", handler);
    }, []);

    const [zoomState, setZoomState] = useState<PersistedZoom>(loadZoom);
    useEffect(() => { saveZoom(zoomState); }, [zoomState]);

    // Reset zoom when a new track is loaded on A or B
    const prevTrackARef = useRef(mixer.deckA.trackId);
    const prevTrackBRef = useRef(mixer.deckB.trackId);
    useEffect(() => {
        if (mixer.deckA.trackId !== prevTrackARef.current) {
            prevTrackARef.current = mixer.deckA.trackId;
            setZoomState(prev => {
                const next = { ...prev, zoomA: DEFAULT_ZOOM };
                if (prev.linked) next.zoomB = DEFAULT_ZOOM;
                return next;
            });
        }
    }, [mixer.deckA.trackId]);
    useEffect(() => {
        if (mixer.deckB.trackId !== prevTrackBRef.current) {
            prevTrackBRef.current = mixer.deckB.trackId;
            setZoomState(prev => {
                const next = { ...prev, zoomB: DEFAULT_ZOOM };
                if (prev.linked) next.zoomA = DEFAULT_ZOOM;
                return next;
            });
        }
    }, [mixer.deckB.trackId]);

    // All decks share zoom when linked; left decks use zoomA, right decks use zoomB
    const getZoom = (s: DeckSide) => (s === "A" || s === "C") ? zoomState.zoomA : zoomState.zoomB;
    const handleZoom = useCallback((s: DeckSide) => (z: number) => {
        setZoomState(prev => {
            const clamped = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
            if (prev.linked) return { ...prev, zoomA: clamped, zoomB: clamped };
            return (s === "A" || s === "C") ? { ...prev, zoomA: clamped } : { ...prev, zoomB: clamped };
        });
    }, []);

    const toggleLinked = useCallback(() => {
        setZoomState(prev => !prev.linked ? { ...prev, linked: true, zoomB: prev.zoomA } : { ...prev, linked: false });
    }, []);

    // Stable per-deck onSeek + onZoomChange closures so RGBWaveform's memo
    // areEqual guard is actually effective across parent re-renders.
    const seekFn = mixer.seek;
    const onSeekMap = useMemo<Record<DeckSide, (t: number) => void>>(() => ({
        A: (t) => seekFn("A", t),
        B: (t) => seekFn("B", t),
        C: (t) => seekFn("C", t),
        D: (t) => seekFn("D", t),
    }), [seekFn]);
    const onZoomMap = useMemo<Record<DeckSide, (z: number) => void>>(() => ({
        A: handleZoom("A"),
        B: handleZoom("B"),
        C: handleZoom("C"),
        D: handleZoom("D"),
    }), [handleZoom]);

    const waveformHeight = is4 ? (isH ? "h-16" : "") : (isH ? "h-24" : "");

    const renderWaveform = (s: DeckSide, orient: "horizontal" | "vertical") => {
        const d = getDeck(s);
        return (
            <RGBWaveform
                peaks={peaksMap[s]}
                loading={loadingMap[s]}
                currentTime={d.currentTime}
                duration={d.duration}
                onSeek={onSeekMap[s]}
                color={DECK_COLORS[s]}
                isPlaying={d.isPlaying}
                loopEnabled={d.loopEnabled}
                loopStart={d.loopStart}
                loopEnd={d.loopEnd}
                hotCues={d.hotCues}
                side={s}
                orientation={orient}
                analyser={analysers[s]}
                zoom={getZoom(s)}
                onZoomChange={onZoomMap[s]}
                bpm={d.bpm}
                showBeatGrid={showBeatGrid}
                waveformMode={mixer.waveformMode}
                getCurrentTime={getCurrentTimeMap[s]}
            />
        );
    };

    const anyPlaying = sides.some(s => getDeck(s).isPlaying);

    return (
        <div className="relative rounded-xl bg-black/40 border border-white/[0.06] overflow-hidden">
            {/* Top controls bar */}
            <div className="absolute top-1.5 right-2 z-10 flex items-center gap-1.5">
                <ZoomControls
                    zoomA={zoomState.zoomA}
                    zoomB={zoomState.zoomB}
                    linked={zoomState.linked}
                    onZoomA={handleZoom("A")}
                    onZoomB={handleZoom("B")}
                    onToggleLinked={toggleLinked}
                />
                <button
                    onClick={onToggleOrientation}
                    className="p-1.5 rounded-md bg-white/5 hover:bg-white/10 text-white/30 hover:text-white/60 transition-all cursor-pointer border border-white/5"
                    title={isH ? "Switch to Vertical" : "Switch to Horizontal"}
                >
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className={cn("transition-transform duration-300", !isH && "rotate-90")}>
                        <rect x="1" y="3" width="12" height="3" rx="1" fill="currentColor" opacity="0.6" />
                        <rect x="1" y="8" width="12" height="3" rx="1" fill="currentColor" opacity="0.6" />
                    </svg>
                </button>
            </div>

            {isH ? (
                <div className="flex flex-col">
                    {sides.map((s, i) => {
                        const d = getDeck(s);
                        const isLast = i === sides.length - 1;
                        return (
                            <div key={s} className={cn("relative", waveformHeight, !isLast && "border-b border-white/[0.06]")}>
                                <div className="absolute top-1.5 left-2 z-10 flex items-center gap-1.5">
                                    <span className="text-[9px] font-bold px-1.5 py-0.5 rounded text-black" style={{ backgroundColor: DECK_COLORS[s] }}>{s}</span>
                                    <span className="text-[9px] text-white/30 truncate max-w-[150px]">{d.trackTitle || "—"}</span>
                                </div>
                                {renderWaveform(s, "horizontal")}
                            </div>
                        );
                    })}
                </div>
            ) : (
                <div className={cn("flex", is4 ? "h-48" : "h-64")}>
                    {/* Left decks */}
                    {(is4 ? ["A", "C"] as DeckSide[] : ["A"] as DeckSide[]).map((s, i) => {
                        const d = getDeck(s);
                        return (
                            <div key={s} className={cn("relative flex-1", i > 0 && "border-l border-white/[0.06]")}>
                                <div className="absolute top-1.5 left-2 z-10">
                                    <span className="text-[9px] font-bold px-1.5 py-0.5 rounded text-black" style={{ backgroundColor: DECK_COLORS[s] }}>{s}</span>
                                </div>
                                {renderWaveform(s, "vertical")}
                            </div>
                        );
                    })}

                    {/* Center Play All */}
                    <div className="flex flex-col items-center justify-center w-12 bg-white/[0.02] shrink-0 gap-2">
                        <button
                            onClick={() => {
                                if (anyPlaying) {
                                    sides.forEach(s => { if (getDeck(s).isPlaying) mixer.pause(s); });
                                } else {
                                    sides.forEach(s => { if (getDeck(s).trackId) mixer.play(s); });
                                }
                            }}
                            className={cn(
                                "flex items-center justify-center w-9 h-9 rounded-full transition-all cursor-pointer border",
                                anyPlaying
                                    ? "bg-white/20 border-white/20 text-white"
                                    : "bg-white/5 border-white/10 text-white/50 hover:bg-white/10"
                            )}
                        >
                            {anyPlaying ? (
                                <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><rect x="2" y="1" width="3" height="10" rx="1" /><rect x="7" y="1" width="3" height="10" rx="1" /></svg>
                            ) : (
                                <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><path d="M3 1.5v9l7-4.5z" /></svg>
                            )}
                        </button>
                    </div>

                    {/* Right decks */}
                    {(is4 ? ["D", "B"] as DeckSide[] : ["B"] as DeckSide[]).map((s, i) => {
                        const d = getDeck(s);
                        return (
                            <div key={s} className={cn("relative flex-1", "border-l border-white/[0.06]")}>
                                <div className="absolute top-1.5 right-2 z-10">
                                    <span className="text-[9px] font-bold px-1.5 py-0.5 rounded text-black" style={{ backgroundColor: DECK_COLORS[s] }}>{s}</span>
                                </div>
                                {renderWaveform(s, "vertical")}
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
});
