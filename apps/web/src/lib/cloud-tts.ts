/**
 * Cloud TTS (Piper) and cloud voice-cloning (RVC + XTTS/F5/Fish) clients.
 *
 * Piper: ready to use. Voice loaded from gs://${GCS_BUCKET_VOICES}/piper/...
 *
 * RVC / voice-cloning: gated on per-user voice model storage in GCS,
 * which is not yet shipped (companion voices live on local disk only).
 * Until the storage layer ships, these helpers return a structured
 * `voice-not-in-cloud-storage` error so callers can degrade gracefully.
 */
import "server-only";

import { mintGoogleIdToken } from "@/lib/google-id-token";

export function cloudPiperEnabled(): boolean {
    return !!process.env.GCP_PIPER_URL;
}

export function cloudRvcEnabled(): boolean {
    return !!process.env.GCP_RVC_URL;
}

export function cloudVoiceTtsEnabled(): boolean {
    return !!process.env.GCP_VOICE_TTS_URL;
}

export interface CloudTtsResult {
    ok: true;
    /** WAV bytes downloaded from GCS output. */
    audio: Buffer;
    outputGs: string;
    sampleRate: number;
    durationSec: number;
    bytes: number;
}
export interface CloudTtsError {
    ok: false;
    error: string;
    via: "cloud-piper" | "cloud-voice-tts" | "cloud-rvc";
}

function buildOutputGs(userId: string, assetId: string, name: string): string {
    const bucket = process.env.GCS_BUCKET_GENERATED ?? "mmo-generated-prod";
    return `gs://${bucket}/voice/${userId}/${assetId}/${name}.wav`;
}

async function downloadGcs(uri: string): Promise<Buffer> {
    const { Storage } = await import("@google-cloud/storage");
    const storage = new Storage({ projectId: process.env.GCP_PROJECT_ID ?? "mmo-mw-prod" });
    const m = uri.match(/^gs:\/\/([^/]+)\/(.+)$/);
    if (!m) throw new Error(`bad gs:// URI: ${uri}`);
    const [, bucket, key] = m as [string, string, string];
    const [buf] = await storage.bucket(bucket).file(key).download();
    return buf;
}

export interface CloudPiperInput {
    userId: string;
    assetId: string;
    voice: string; // gs://... or bundled name
    text: string;
    speed?: number;
}

export async function synthesizeOnCloudPiper(input: CloudPiperInput): Promise<CloudTtsResult | CloudTtsError> {
    const url = process.env.GCP_PIPER_URL;
    if (!url) return { ok: false, error: "GCP_PIPER_URL not set", via: "cloud-piper" };
    const outputGs = buildOutputGs(input.userId, input.assetId, "piper");
    const audience = new URL(url).origin;
    const token = await mintGoogleIdToken(audience);
    if (!token) return { ok: false, error: "could not mint ID token", via: "cloud-piper" };

    let resp: Response;
    try {
        resp = await fetch(`${url}/synthesize`, {
            method: "POST",
            headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({
                voice: input.voice,
                text: input.text,
                outputGs,
                speed: input.speed ?? 1.0,
            }),
            signal: AbortSignal.timeout(120_000),
            cache: "no-store",
        });
    } catch (e) {
        return { ok: false, error: `request: ${(e as Error).message}`, via: "cloud-piper" };
    }
    if (!resp.ok) {
        let msg = `HTTP ${resp.status}`;
        try { const j = await resp.json() as { error?: string }; if (j?.error) msg += `: ${j.error}`; } catch { /* ignore */ }
        return { ok: false, error: msg, via: "cloud-piper" };
    }
    const j = await resp.json() as { ok: boolean; output: string; sampleRate: number; durationSec: number; bytes: number; error?: string };
    if (!j.ok) return { ok: false, error: j.error ?? "service ok=false", via: "cloud-piper" };
    try {
        const audio = await downloadGcs(j.output);
        return { ok: true, audio, outputGs: j.output, sampleRate: j.sampleRate, durationSec: j.durationSec, bytes: j.bytes };
    } catch (e) {
        return { ok: false, error: `download: ${(e as Error).message}`, via: "cloud-piper" };
    }
}

/** RVC voice conversion in the cloud.
 *  TODO: requires per-user RVC model storage in GCS. Until shipped,
 *  returns `voice-not-in-cloud-storage`. */
export async function convertVocalOnCloud(_input: {
    userId: string;
    assetId: string;
    sourceWav: Buffer;
    voiceId: string;
    pitch?: number;
}): Promise<CloudTtsResult | CloudTtsError> {
    if (!cloudRvcEnabled()) {
        return { ok: false, error: "GCP_RVC_URL not set", via: "cloud-rvc" };
    }
    return { ok: false, error: "voice-not-in-cloud-storage: RVC voice models live on the companion only. Cloud voice migration not yet implemented.", via: "cloud-rvc" };
}

/** Cloned-voice TTS (XTTS/F5/Fish) in the cloud.
 *  TODO: requires per-user voice reference/embeds in GCS. */
export async function synthesizeClonedOnCloud(_input: {
    userId: string;
    assetId: string;
    voiceId: string;
    text: string;
    melody?: unknown;
    engine?: "xtts" | "f5" | "fish";
}): Promise<CloudTtsResult | CloudTtsError> {
    if (!cloudVoiceTtsEnabled()) {
        return { ok: false, error: "GCP_VOICE_TTS_URL not set", via: "cloud-voice-tts" };
    }
    return { ok: false, error: "voice-not-in-cloud-storage: cloned voices live on the companion only. Cloud voice migration not yet implemented.", via: "cloud-voice-tts" };
}
