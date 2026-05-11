"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// ═══════════════════════════════════════════════════════════════════════════
// Inline Editable Name
// ═══════════════════════════════════════════════════════════════════════════

export function InlineEditName({ value, onCommit, className }: {
    value: string;
    onCommit: (name: string) => void;
    className?: string;
}) {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(value);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (editing) {
            // Focus the input + select-all on the next frame; the draft has
            // already been seeded from `value` in the onDoubleClick handler.
            requestAnimationFrame(() => {
                inputRef.current?.focus();
                inputRef.current?.select();
            });
        }
    }, [editing]);

    const commit = useCallback(() => {
        const trimmed = draft.trim();
        if (trimmed && trimmed !== value) {
            onCommit(trimmed);
        }
        setEditing(false);
    }, [draft, value, onCommit]);

    if (editing) {
        return (
            <input
                ref={inputRef}
                value={draft}
                onChange={e => setDraft(e.target.value)}
                onBlur={commit}
                onKeyDown={e => {
                    if (e.key === "Enter") commit();
                    if (e.key === "Escape") setEditing(false);
                    e.stopPropagation();
                }}
                onClick={e => e.stopPropagation()}
                className={`daw-inline-edit ${className ?? ""}`}
            />
        );
    }

    return (
        <span
            className={`${className ?? ""} cursor-default`}
            onDoubleClick={e => { e.stopPropagation(); setDraft(value); setEditing(true); }}
            title="Double-click to rename"
        >
            {value}
        </span>
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// Scroll-to-Adjust Hook
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Attach to a slider / knob / fader to support BOTH:
 *  - Mouse wheel adjust (desktop)
 *  - Vertical pointer drag (touch + pen + mouse)
 *
 * Works on any DOM element, not just `<input type="range">` — the element
 * just needs to render the value somehow. Pointer drag uses captured pointer
 * events so it keeps working when the pointer leaves the element. Vertical
 * drag = adjust value (like a hardware knob); ~120 px of travel covers the
 * full min..max range. Hold Shift while wheeling for fine adjustment.
 */
export function useScrollAdjust(opts: {
    value: number;
    min: number;
    max: number;
    step?: number;
    fineStep?: number;
    onChange: (value: number) => void;
}) {
    const ref = useRef<HTMLInputElement>(null);
    const { value, min, max, step = 0.01, fineStep, onChange } = opts;

    // Stash the latest opts in refs so the listener doesn't have to re-bind
    // every render — re-binding would race with an in-progress drag.
    // Refs are mirrored *after* commit (no ref writes during render).
    const valueRef = useRef(value);
    const minRef = useRef(min);
    const maxRef = useRef(max);
    const stepRef = useRef(step);
    const fineStepRef = useRef(fineStep);
    const onChangeRef = useRef(onChange);
    useEffect(() => {
        valueRef.current = value;
        minRef.current = min;
        maxRef.current = max;
        stepRef.current = step;
        fineStepRef.current = fineStep;
        onChangeRef.current = onChange;
    });

    useEffect(() => {
        const el = ref.current;
        if (!el) return;

        const handleWheel = (e: WheelEvent) => {
            e.preventDefault();
            e.stopPropagation();
            const fStep = fineStepRef.current;
            const effectiveStep = e.shiftKey && fStep ? fStep : stepRef.current;
            const delta = e.deltaY > 0 ? -effectiveStep : effectiveStep;
            const newVal = Math.min(maxRef.current, Math.max(minRef.current, valueRef.current + delta));
            onChangeRef.current(newVal);
        };

        // Pointer-based vertical drag for touch / pen / mouse alike.
        let dragStartY = 0;
        let dragStartValue = 0;
        let dragging = false;
        let activePointerId: number | null = null;

        const handlePointerDown = (e: PointerEvent) => {
            // Skip native input range thumb drags — let the browser handle them
            // for `<input type="range">`. Custom knob elements have no native
            // drag so we always handle them here.
            if (el.tagName === "INPUT" && (el as HTMLInputElement).type === "range") {
                // Native range works on touch out of the box; we only attach
                // wheel + use the input's own change handler. Bail out here.
                return;
            }
            // Only primary button for mouse
            if (e.pointerType === "mouse" && e.button !== 0) return;
            e.preventDefault();
            dragging = true;
            dragStartY = e.clientY;
            dragStartValue = valueRef.current;
            activePointerId = e.pointerId;
            try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        };

        const handlePointerMove = (e: PointerEvent) => {
            if (!dragging || e.pointerId !== activePointerId) return;
            const dy = dragStartY - e.clientY; // up = positive
            const range = maxRef.current - minRef.current;
            // 200 px of vertical travel = full range (gentle for touch).
            const fine = e.shiftKey && fineStepRef.current ? 0.2 : 1;
            const newVal = Math.min(
                maxRef.current,
                Math.max(minRef.current, dragStartValue + (dy / 200) * range * fine),
            );
            // Snap to step granularity.
            const s = stepRef.current;
            const snapped = s > 0 ? Math.round(newVal / s) * s : newVal;
            onChangeRef.current(snapped);
        };

        const handlePointerEnd = (e: PointerEvent) => {
            if (e.pointerId !== activePointerId) return;
            dragging = false;
            activePointerId = null;
            try { el.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
        };

        el.addEventListener("wheel", handleWheel, { passive: false });
        el.addEventListener("pointerdown", handlePointerDown);
        el.addEventListener("pointermove", handlePointerMove);
        el.addEventListener("pointerup", handlePointerEnd);
        el.addEventListener("pointercancel", handlePointerEnd);
        return () => {
            el.removeEventListener("wheel", handleWheel);
            el.removeEventListener("pointerdown", handlePointerDown);
            el.removeEventListener("pointermove", handlePointerMove);
            el.removeEventListener("pointerup", handlePointerEnd);
            el.removeEventListener("pointercancel", handlePointerEnd);
        };
    }, []);

    return ref;
}

// ═══════════════════════════════════════════════════════════════════════════
// Touch Drag-and-Drop
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Custom DnD for touch (HTML5 drag-and-drop is mouse-only on most mobile
 * browsers). Returns props to spread on the source element. On touch/pen,
 * once the pointer moves past `threshold` px we render a floating ghost
 * that follows the finger; on release we look up the element under the
 * pointer for an attribute matching `targetSelector` and dispatch a custom
 * `daw-touch-drop` window event with the payload + drop target.
 *
 * Mouse pointers are ignored — native HTML5 `draggable` handles those.
 *
 * Drop targets should:
 *   1. Have an attribute matching `targetSelector` (e.g. `data-track-lane`).
 *   2. Listen for `window.addEventListener("daw-touch-drop", handler)`,
 *      filtering on `event.detail.targetEl` (the element matched).
 */
export interface TouchDropEventDetail<T = unknown> {
    payload: T;
    targetEl: HTMLElement;
    clientX: number;
    clientY: number;
}

export function useTouchDrag<T>(opts: {
    payload: T | (() => T);
    ghostText: string;
    threshold?: number;
    targetSelector?: string;
}) {
    const { ghostText, threshold = 8, targetSelector = "[data-touch-drop-target]" } = opts;
    const payloadRef = useRef(opts.payload);
    useEffect(() => { payloadRef.current = opts.payload; });
    const startedRef = useRef(false);
    const startPosRef = useRef<{ x: number; y: number } | null>(null);
    const ghostRef = useRef<HTMLDivElement | null>(null);
    const lastTargetRef = useRef<HTMLElement | null>(null);

    const cleanup = useCallback(() => {
        if (ghostRef.current) {
            ghostRef.current.remove();
            ghostRef.current = null;
        }
        if (lastTargetRef.current) {
            lastTargetRef.current.removeAttribute("data-touch-drop-active");
            lastTargetRef.current = null;
        }
        startedRef.current = false;
        startPosRef.current = null;
    }, []);

    const ensureGhost = useCallback(() => {
        if (ghostRef.current) return ghostRef.current;
        const ghost = document.createElement("div");
        ghost.style.cssText = [
            "position: fixed",
            "top: 0",
            "left: 0",
            "padding: 6px 12px",
            "border-radius: 6px",
            "background: linear-gradient(135deg, rgba(139,92,246,0.95), rgba(109,40,217,0.95))",
            "color: white",
            "font-size: 11px",
            "font-family: system-ui",
            "box-shadow: 0 8px 32px rgba(0,0,0,0.4)",
            "border: 1px solid rgba(255,255,255,0.18)",
            "white-space: nowrap",
            "pointer-events: none",
            "z-index: 9999",
            "transform: translate(-50%, -120%)",
            "transition: opacity 120ms",
        ].join("; ");
        ghost.textContent = ghostText;
        document.body.appendChild(ghost);
        ghostRef.current = ghost;
        return ghost;
    }, [ghostText]);

    const onPointerDown = useCallback((e: React.PointerEvent) => {
        // Native HTML5 drag handles mouse — only intercept touch / pen.
        if (e.pointerType === "mouse") return;
        startPosRef.current = { x: e.clientX, y: e.clientY };
        startedRef.current = false;
    }, []);

    const onPointerMove = useCallback((e: React.PointerEvent) => {
        if (!startPosRef.current || e.pointerType === "mouse") return;
        const dx = e.clientX - startPosRef.current.x;
        const dy = e.clientY - startPosRef.current.y;

        if (!startedRef.current) {
            if (Math.hypot(dx, dy) < threshold) return;
            startedRef.current = true;
            try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* ignore */ }
            ensureGhost();
        }

        const ghost = ghostRef.current;
        if (ghost) {
            ghost.style.left = `${e.clientX}px`;
            ghost.style.top = `${e.clientY}px`;
        }

        // Highlight current drop target
        const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
        const target = el?.closest(targetSelector) as HTMLElement | null;
        if (target !== lastTargetRef.current) {
            lastTargetRef.current?.removeAttribute("data-touch-drop-active");
            target?.setAttribute("data-touch-drop-active", "true");
            lastTargetRef.current = target;
        }
    }, [ensureGhost, threshold, targetSelector]);

    const onPointerUp = useCallback((e: React.PointerEvent) => {
        if (!startedRef.current) {
            cleanup();
            return;
        }
        // Hide ghost first so elementFromPoint doesn't return it
        if (ghostRef.current) ghostRef.current.style.display = "none";
        const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
        const target = el?.closest(targetSelector) as HTMLElement | null;
        if (target) {
            const payload = typeof payloadRef.current === "function"
                ? (payloadRef.current as () => T)()
                : payloadRef.current;
            const detail: TouchDropEventDetail<T> = {
                payload,
                targetEl: target,
                clientX: e.clientX,
                clientY: e.clientY,
            };
            window.dispatchEvent(new CustomEvent("daw-touch-drop", { detail }));
        }
        cleanup();
    }, [cleanup, targetSelector]);

    const onPointerCancel = useCallback(() => cleanup(), [cleanup]);

    return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel };
}
