/**
 * Global shortcuts: Space = bypass, M = mute, ←/→ = prev/next part, T = tap, Esc = close panels.
 * Ignored while typing or while a focused control (slider, select, button) owns the key.
 */
import type { MixState } from "./protocol";

export type ShortcutAction = "bypass" | "mute" | "prev" | "next" | "tap" | "escape";

export interface KeyLike {
    key: string;
    code?: string;
    ctrlKey?: boolean;
    metaKey?: boolean;
    altKey?: boolean;
    repeat?: boolean;
}

export interface TargetInfo {
    tag: string;
    role: string | null;
    editable: boolean;
}

const OWNS_ARROWS = new Set(["slider", "radio", "radiogroup", "tab", "listbox", "option", "combobox", "menuitem", "spinbutton"]);

/** Pure mapping from a key event + focused element to an action (unit-testable). */
export function shortcutFor(e: KeyLike, target: TargetInfo | null): ShortcutAction | null {
    if (e.ctrlKey || e.metaKey || e.altKey) return null;
    if (e.key === "Escape") return "escape";
    if (target && (target.editable || target.tag === "input" || target.tag === "textarea" || target.tag === "select")) return null;
    if (e.repeat) return null;
    const role = target?.role ?? null;
    if (e.key === " " || e.code === "Space") {
        // Space activates focused buttons/switches; only act when focus is on the page itself.
        if (target && (target.tag === "button" || role === "switch" || role === "checkbox" || role === "slider" || target.tag === "a")) return null;
        return "bypass";
    }
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        if (role && OWNS_ARROWS.has(role)) return null;
        return e.key === "ArrowLeft" ? "prev" : "next";
    }
    const k = e.key.toLowerCase();
    if (k === "m") return "mute";
    if (k === "t") return "tap";
    return null;
}

export function targetInfo(el: Element | null): TargetInfo | null {
    if (!el || el === document.body) return null;
    const h = el as HTMLElement;
    return { tag: el.tagName.toLowerCase(), role: el.getAttribute("role"), editable: !!h.isContentEditable };
}

export function toggleFor(action: "bypass" | "mute", mix: MixState | undefined) {
    return action === "bypass" ? { bypass: !(mix?.bypass ?? false) } : { mute: !(mix?.mute ?? false) };
}
