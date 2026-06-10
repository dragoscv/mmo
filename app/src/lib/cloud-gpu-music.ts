/**
 * Cloud-GPU music generation client.
 *
 * Calls the `mmo-ace-step` Cloud Run GPU service when the local companion
 * is offline or unavailable. The service expects:
 *
 *   • Bearer ID token (audience = service URL) — see `mintGoogleIdToken`.
 *   • gs:// output path inside the user's generated bucket.
 *
 * Result: WAV uploaded to GCS, then downloaded back here as a Buffer so
 * the caller (server action) writes it to the same local asset dir as
 * the companion path. Symmetric with `generateSongOnCompanion` so the
 * rest of the generation pipeline (Demucs split, mastering) is unchanged.
 *
 * Required env:
 *   GCP_ACESTEP_URL          — Cloud Run service URL (set after deploy.ps1)
 *   GCS_BUCKET_GENERATED     — bucket for output WAVs (default mmo-generated-prod)
 *   GCP_PROJECT_ID           — GCP project (default mmo-mw-prod)
 *
 * Optional env:
 *   GCP_ACESTEP_DEMUCS_URL   — Cloud Run Demucs URL (not yet built; falls
 *                              back to web-side Demucs/no-stems when unset)
 */

import "server-only";

import { mintGoogleIdToken } from "@/lib/google-id-token";

export interface CloudSongGenerateInput {
    prompt: string;
    lyrics?: string;
    durationSec?: number;
    inferStep?: number;
    guidanceScale?: number;
    seeds?: number[];
    /** gs:// path to a LoRA .ckpt on the training bucket. */
    loraGs?: string;
    loraWeight?: number;
    /** Where to write the song in GCS. Must be a gs:// URI inside a bucket
     *  the ace-step SA can write to (e.g. `gs://mmo-generated-prod/...`). */
    outputGs: string;
}

export interface CloudSongGenerateResult {
    ok: true;
    /** Raw WAV bytes downloaded from the GCS output. */
    songWav: Buffer;
    outputGs: string;
    sampleRate: number;
    durationSec: number;
    device: string;
    model: string;
    sizeBytes: number;
}

export interface CloudSongGenerateError {
    ok: false;
    error: string;
    via: "cloud-ace-step";
}

/** Returns true when GCP_ACESTEP_URL is configured (i.e. cloud fallback usable). */
export function cloudMusicEnabled(): boolean {
    return !!process.env.GCP_ACESTEP_URL;
}

/** Build a stable gs:// output path for a generated asset. */
export function buildSongOutputGs(userId: string, assetId: string): string {
    const bucket = process.env.GCS_BUCKET_GENERATED ?? "mmo-generated-prod";
    return `gs://${bucket}/songs/${encodeURIComponent(userId)}/${encodeURIComponent(assetId)}/song.wav`;
}

export async function generateSongOnCloud(
    input: CloudSongGenerateInput,
): Promise<CloudSongGenerateResult | CloudSongGenerateError> {
    const url = process.env.GCP_ACESTEP_URL;
    if (!url) return { ok: false, error: "GCP_ACESTEP_URL not configured", via: "cloud-ace-step" };
    if (!input.outputGs.startsWith("gs://")) {
        return { ok: false, error: "outputGs must be a gs:// URI", via: "cloud-ace-step" };
    }

    const token = await mintGoogleIdToken(url);
    if (!token) return { ok: false, error: "could not mint Google ID token", via: "cloud-ace-step" };

    const body = {
        prompt: input.prompt,
        lyrics: input.lyrics ?? "",
        durationSec: input.durationSec ?? 30,
        inferStep: input.inferStep ?? 60,
        guidanceScale: input.guidanceScale ?? 15,
        seeds: input.seeds ?? null,
        loraGs: input.loraGs ?? null,
        loraWeight: input.loraWeight ?? 1.0,
        output: input.outputGs,
    };

    // Cold start can take 90s while ACE-Step weights download into the
    // Cloud Run instance. Warm calls return in ~40s for a 30s song.
    // Generous timeout matches the 900s server-side cap.
    let res: Response;
    try {
        res = await fetch(`${url.replace(/\/$/, "")}/generate`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(900_000),
        });
    } catch (e) {
        return { ok: false, error: `cloud request failed: ${(e as Error).message}`, via: "cloud-ace-step" };
    }
    if (!res.ok) {
        const text = await res.text().catch(() => "");
        return {
            ok: false,
            error: `cloud /generate ${res.status}: ${text.slice(0, 300)}`,
            via: "cloud-ace-step",
        };
    }
    const j = (await res.json().catch(() => null)) as
        | { ok?: boolean; output?: string; sampleRate?: number; durationSec?: number; device?: string; model?: string; sizeBytes?: number; error?: string }
        | null;
    if (!j || j.ok !== true || !j.output) {
        return { ok: false, error: j?.error ?? "cloud /generate returned no output", via: "cloud-ace-step" };
    }

    // Download the WAV back so the caller writes it into the user's local
    // asset dir, identical to the companion path.
    const songBuf = await downloadGcs(j.output);
    if (!songBuf) {
        return { ok: false, error: `failed to download ${j.output}`, via: "cloud-ace-step" };
    }
    return {
        ok: true,
        songWav: songBuf,
        outputGs: j.output,
        sampleRate: j.sampleRate ?? 48000,
        durationSec: j.durationSec ?? input.durationSec ?? 30,
        device: j.device ?? "cloud-l4",
        model: j.model ?? "ace-step-v1.5",
        sizeBytes: j.sizeBytes ?? songBuf.byteLength,
    };
}

async function downloadGcs(gsUri: string): Promise<Buffer | null> {
    try {
        const u = new URL(gsUri);
        if (u.protocol !== "gs:") return null;
        const bucket = u.hostname;
        const objectPath = u.pathname.replace(/^\//, "");
        const mod = await import("@google-cloud/storage").catch(() => null);
        if (!mod) return null;
        const { Storage } = mod;
        const client = new Storage({ projectId: process.env.GCP_PROJECT_ID });
        const [data] = await client.bucket(bucket).file(objectPath).download();
        return data;
    } catch {
        return null;
    }
}
