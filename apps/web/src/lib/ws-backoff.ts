/**
 * Exponential-backoff reconnect timer shared between WebSocket clients
 * (`device-ws.ts`, `native-companion.ts`, future native shells).
 *
 * Why a helper instead of inline `setTimeout` per client:
 *  - All our WS clients want the same curve (1s → 2s → 4s → … → 30s cap).
 *  - Resetting on successful open and cancelling on user-close are easy
 *    to get wrong (forgotten `reset()` after open leaves new connections
 *    waiting 30s before the first reconnect attempt — happened in
 *    `native-companion.ts` before this extraction).
 *  - Centralises the cap so we can tweak network behaviour in one place.
 */

export interface BackoffOptions {
    /** First retry delay in ms. Default 1000. */
    initialMs?: number;
    /** Maximum retry delay in ms. Default 30000. */
    maxMs?: number;
    /** Growth factor per failure. Default 2. */
    factor?: number;
}

export class ReconnectingTimer {
    private currentMs: number;
    private readonly initialMs: number;
    private readonly maxMs: number;
    private readonly factor: number;
    private timer: ReturnType<typeof setTimeout> | null = null;

    constructor(opts: BackoffOptions = {}) {
        this.initialMs = opts.initialMs ?? 1000;
        this.maxMs = opts.maxMs ?? 30000;
        this.factor = opts.factor ?? 2;
        this.currentMs = this.initialMs;
    }

    /** Schedule `fn` after the current backoff delay, then grow the
     *  delay for the next failure. Safe to call multiple times — the
     *  previous pending timer is replaced. */
    schedule(fn: () => void): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.timer = null;
            fn();
        }, this.currentMs);
        this.currentMs = Math.min(this.currentMs * this.factor, this.maxMs);
    }

    /** Reset the delay back to `initialMs` (call this on successful open). */
    reset(): void {
        this.currentMs = this.initialMs;
    }

    /** Cancel any pending scheduled retry without resetting the delay
     *  curve. Used when the user closes the connection intentionally. */
    cancel(): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }

    /** Current backoff delay in ms, useful for telemetry / logs. */
    get nextDelayMs(): number {
        return this.currentMs;
    }
}
