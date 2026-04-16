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
            setDraft(value);
            requestAnimationFrame(() => {
                inputRef.current?.focus();
                inputRef.current?.select();
            });
        }
    }, [editing, value]);

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
            onDoubleClick={e => { e.stopPropagation(); setEditing(true); }}
            title="Double-click to rename"
        >
            {value}
        </span>
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// Scroll-to-Adjust Hook
// ═══════════════════════════════════════════════════════════════════════════

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

    useEffect(() => {
        const el = ref.current;
        if (!el) return;

        const handleWheel = (e: WheelEvent) => {
            e.preventDefault();
            e.stopPropagation();
            const effectiveStep = e.shiftKey && fineStep ? fineStep : step;
            const delta = e.deltaY > 0 ? -effectiveStep : effectiveStep;
            const newVal = Math.min(max, Math.max(min, value + delta));
            onChange(newVal);
        };

        el.addEventListener("wheel", handleWheel, { passive: false });
        return () => el.removeEventListener("wheel", handleWheel);
    }, [value, min, max, step, fineStep, onChange]);

    return ref;
}
