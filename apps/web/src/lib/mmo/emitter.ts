/** Tiny typed event emitter (no deps). `on()` returns the unsubscribe function. */
export class Emitter<T> {
    private readonly listeners = new Set<(v: T) => void>();

    on(fn: (v: T) => void): () => void {
        this.listeners.add(fn);
        return () => { this.listeners.delete(fn); };
    }

    emit(v: T): void {
        for (const fn of Array.from(this.listeners)) {
            try { fn(v); } catch (e) { console.error("[emitter]", e); }
        }
    }

    get size(): number { return this.listeners.size; }
}
