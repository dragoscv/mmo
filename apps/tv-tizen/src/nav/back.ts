/**
 * Back-key handler stack. Overlays (Dialog, SidePanel, PinPad dialogs, player panels) push a handler while
 * open; the App (and the Player's own key handler) call `consumeBack()` FIRST, so Back closes the topmost
 * overlay before it navigates. React: `useBackHandler(fn, enabled)`.
 */
import { useEffect, useRef } from "react";

type Handler = () => boolean | void;
let stack: Array<{ id: number; fn: Handler }> = [];
let seq = 0;

/** Registers a handler; returns the remover. Handlers return `false` to pass Back to the next one. */
export function pushBack(fn: Handler): () => void {
    const id = ++seq;
    stack.push({ id, fn });
    return () => { stack = stack.filter((h) => h.id !== id); };
}

/** Runs the topmost handler(s); true when one consumed the key. */
export function consumeBack(): boolean {
    for (let i = stack.length - 1; i >= 0; i--) {
        const h = stack[i]!;
        if (h.fn() !== false) return true;
    }
    return false;
}

export function hasBackHandlers(): boolean { return stack.length > 0; }

/** While `enabled`, Back calls `fn` (latest closure) instead of navigating. */
export function useBackHandler(fn: Handler, enabled = true): void {
    const ref = useRef(fn);
    ref.current = fn;
    useEffect(() => {
        if (!enabled) return;
        return pushBack(() => ref.current());
    }, [enabled]);
}
