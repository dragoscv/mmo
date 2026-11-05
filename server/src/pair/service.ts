/**
 * Quick Connect pairing — in-memory state machine (no I/O).
 *
 * A TV / phone that cannot type asks for a 6-digit code, shows it on screen
 * (plus a QR), and polls. A device that already holds the real
 * `deviceToken` approves the code; the next poll hands the token over
 * exactly once and the entry is gone.
 *
 * Kept free of Express / store so it is unit-testable and reusable from
 * the WS channel later.
 */

import crypto from "node:crypto";

export const PAIR_TTL_MS = 10 * 60 * 1000;
export const PAIR_MAX_PENDING = 20;
export const PAIR_POLL_MIN_INTERVAL_MS = 2000;
export const PAIR_CODE_LENGTH = 6;
const CODE_RE = /^\d{6}$/;
const MAX_NAME_LEN = 64;

export interface PairRequest {
    code: string;
    secret: string;
    deviceName: string;
    platform: string;
    createdAt: number;
    expiresAt: number;
    approved: boolean;
    lastPollAt: number;
}

export interface PendingSummary {
    code: string;
    deviceName: string;
    platform: string;
    createdAt: number;
    expiresAt: number;
    approved: boolean;
}

export type PollResult =
    | { status: "pending" }
    | { status: "approved" }
    | { status: "expired" };

export class PairError extends Error {
    constructor(public readonly status: number, message: string) {
        super(message);
        this.name = "PairError";
    }
}

export function isValidCode(code: unknown): code is string {
    return typeof code === "string" && CODE_RE.test(code);
}

function sanitizeLabel(v: unknown, fallback: string): string {
    if (typeof v !== "string") return fallback;
    const s = v.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, MAX_NAME_LEN);
    return s || fallback;
}

function secretsEqual(a: string, b: string): boolean {
    const ba = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ba.length !== bb.length) {
        // Still burn a compare so the length branch is not a timing oracle.
        crypto.timingSafeEqual(bb, bb);
        return false;
    }
    return crypto.timingSafeEqual(ba, bb);
}

export class PairingService {
    private readonly pending = new Map<string, PairRequest>();

    constructor(private readonly now: () => number = Date.now) {}

    /** Drop expired entries. Called on every public operation. */
    private sweep(): void {
        const t = this.now();
        for (const [code, req] of this.pending) {
            if (req.expiresAt <= t) this.pending.delete(code);
        }
    }

    private generateCode(): string {
        for (let i = 0; i < 100; i++) {
            // 0..999999, uniform (randomInt is unbiased).
            const code = crypto.randomInt(0, 1_000_000).toString().padStart(PAIR_CODE_LENGTH, "0");
            if (!this.pending.has(code)) return code;
        }
        throw new PairError(503, "Could not allocate a pairing code");
    }

    request(input: { deviceName?: unknown; platform?: unknown }): PairRequest {
        this.sweep();
        if (this.pending.size >= PAIR_MAX_PENDING) {
            throw new PairError(429, "Too many pending pairing requests");
        }
        const t = this.now();
        const req: PairRequest = {
            code: this.generateCode(),
            secret: crypto.randomBytes(32).toString("hex"),
            deviceName: sanitizeLabel(input.deviceName, "Unknown device"),
            platform: sanitizeLabel(input.platform, "unknown"),
            createdAt: t,
            expiresAt: t + PAIR_TTL_MS,
            approved: false,
            lastPollAt: 0,
        };
        this.pending.set(req.code, req);
        return req;
    }

    /**
     * Poll by code+secret. Throws PairError 400 (bad code), 403 (bad
     * secret), 429 (polling faster than PAIR_POLL_MIN_INTERVAL_MS).
     * Returns `approved` exactly once — the entry is deleted on that call.
     */
    poll(code: unknown, secret: unknown): PollResult {
        this.sweep();
        if (!isValidCode(code)) throw new PairError(400, "Invalid code");
        const req = this.pending.get(code);
        if (!req) return { status: "expired" };
        if (typeof secret !== "string" || !secretsEqual(req.secret, secret)) {
            throw new PairError(403, "Invalid secret");
        }
        const t = this.now();
        if (req.lastPollAt && t - req.lastPollAt < PAIR_POLL_MIN_INTERVAL_MS) {
            throw new PairError(429, "Polling too fast");
        }
        req.lastPollAt = t;
        if (req.approved) {
            this.pending.delete(code);
            return { status: "approved" };
        }
        return { status: "pending" };
    }

    /** Mark a code approved. Returns false when the code is unknown/expired. */
    approve(code: unknown): boolean {
        this.sweep();
        if (!isValidCode(code)) return false;
        const req = this.pending.get(code);
        if (!req) return false;
        req.approved = true;
        return true;
    }

    /** Remove a code (deny). */
    deny(code: unknown): boolean {
        this.sweep();
        if (!isValidCode(code)) return false;
        return this.pending.delete(code);
    }

    /** Pending list without secrets — safe to show in UIs. */
    listPending(): PendingSummary[] {
        this.sweep();
        return [...this.pending.values()].map(({ code, deviceName, platform, createdAt, expiresAt, approved }) => ({
            code, deviceName, platform, createdAt, expiresAt, approved,
        }));
    }

    get size(): number {
        this.sweep();
        return this.pending.size;
    }
}
