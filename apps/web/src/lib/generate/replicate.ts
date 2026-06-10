/**
 * Minimal Replicate API wrapper for tier T1 generation.
 *
 * Uses the `Prefer: wait=<seconds>` header so we can keep the
 * server action synchronous for short generations (≤60s). Longer
 * jobs will return `status: "processing"` and the caller can poll.
 *
 * Auth: REPLICATE_API_TOKEN env var. We never log it.
 */

const REPLICATE_BASE = "https://api.replicate.com/v1";

export interface ReplicatePrediction {
    id: string;
    status: "starting" | "processing" | "succeeded" | "failed" | "canceled";
    /** URL(s) to the generated artifact, when succeeded. */
    output: string | string[] | null;
    error: string | null;
}

export class ReplicateError extends Error {
    constructor(message: string, public readonly status?: number) {
        super(message);
        this.name = "ReplicateError";
    }
}

function token(): string {
    const t = process.env.REPLICATE_API_TOKEN;
    if (!t) throw new ReplicateError("REPLICATE_API_TOKEN env var is not set", 500);
    return t;
}

/** Create a prediction; with `waitSec` server holds the connection up to that long. */
export async function createPrediction(input: {
    model: string; // e.g. "meta/musicgen"
    input: Record<string, unknown>;
    waitSec?: number;
}): Promise<ReplicatePrediction> {
    const headers: Record<string, string> = {
        "Authorization": `Bearer ${token()}`,
        "Content-Type": "application/json",
    };
    if (input.waitSec) headers["Prefer"] = `wait=${Math.min(60, input.waitSec)}`;

    const res = await fetch(`${REPLICATE_BASE}/models/${input.model}/predictions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ input: input.input }),
    });

    if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new ReplicateError(`Replicate create failed (${res.status}): ${text.slice(0, 500)}`, res.status);
    }
    return (await res.json()) as ReplicatePrediction;
}

export async function getPrediction(id: string): Promise<ReplicatePrediction> {
    const res = await fetch(`${REPLICATE_BASE}/predictions/${encodeURIComponent(id)}`, {
        headers: { "Authorization": `Bearer ${token()}` },
    });
    if (!res.ok) {
        throw new ReplicateError(`Replicate get failed (${res.status})`, res.status);
    }
    return (await res.json()) as ReplicatePrediction;
}

/** Stream-download the output URL to a local buffer (capped at 200 MB). */
export async function downloadOutput(url: string, maxBytes = 200 * 1024 * 1024): Promise<Buffer> {
    const res = await fetch(url);
    if (!res.ok) throw new ReplicateError(`Output fetch failed (${res.status})`);
    const len = Number(res.headers.get("content-length") ?? "0");
    if (len > maxBytes) throw new ReplicateError(`Output too large: ${len} > ${maxBytes}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > maxBytes) throw new ReplicateError("Output too large after download");
    return buf;
}
