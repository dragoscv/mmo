/** Bounded undo stack (pure). Newest item last. */
export const UNDO_MAX = 10;

export function pushUndo<T>(stack: readonly T[], item: T, max = UNDO_MAX): T[] {
    const next = [...stack, item];
    return next.length > max ? next.slice(next.length - max) : next;
}

export function popUndo<T>(stack: readonly T[]): [T | undefined, T[]] {
    if (stack.length === 0) return [undefined, []];
    return [stack[stack.length - 1], stack.slice(0, -1)];
}
