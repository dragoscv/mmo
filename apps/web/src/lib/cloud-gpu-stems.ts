/**
 * Cloud-GPU stem separation client (Demucs on Cloud Run L4).
 *
 * Required env:
 *   GCP_DEMUCS_URL           — Cloud Run service URL
 *   GCS_BUCKET_GENERATED     — output bucket (default mmo-generated-prod)
 *   GCS_BUCKET_INPUT         — bucket for source uploads (default mmo-generated-prod)
 */
import "server-only";

import { mintGoogleIdToken } from "@/lib/google-id-token";

export interface CloudStemsInput {
    /** gs:// URI of the source mix. Caller is responsible for uploading. */
    inputGs: string;
    /** gs:// prefix where stems are written (no trailing slash needed). */
    outputGsPrefix: string;
    model?: string;
}

export interface CloudStemsResult {
    ok: true;
    /** Stem name → gs:// URI map. Typically vocals/drums/bass/other. */
    stems: Record<string, string>;
    sampleRate: number;
    durationSec: number;
    device: string;
    model: string;
    elapsedSec: number;
}

export interface CloudStemsError {
    ok: false;
    error: string;
    via: "cloud-demucs";
}

export function cloudStemsEnabled(): boolean {
    return !!process.env.GCP_DEMUCS_URL;
}

export function buildStemsOutputPrefix(userId: string, assetId: string): string {
    const bucket = process.env.GCS_BUCKET_GENERATED ?? "mmo-generated-prod";
    return `gs://${bucket}/stems/${userId}/${assetId}`;
}

export function buildInputUploadGs(userId: string, assetId: string, ext = "wav"): string {
    const bucket = process.env.GCS_BUCKET_GENERATED ?? "mmo-generated-prod";
    return `gs://${bucket}/uploads/${userId}/${assetId}/source.${ext}`;
}

async function uploadGcs(uri: string, data: Buffer, contentType = "audio/wav"): Promise<void> {
    const { Storage } = await import("@google-cloud/storage");
    const storage = new Storage({ projectId: process.env.GCP_PROJECT_ID ?? "mmo-mw-prod" });
    const m = uri.match(/^gs:\/\/([^/]+)\/(.+)$/);
    if (!m) throw new Error(`bad gs:// URI: ${uri}`);
    const [, bucket, key] = m as [string, string, string];
    await storage.bucket(bucket).file(key).save(data, { contentType, resumable: false });
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

/** Upload a local audio Buffer + run Demucs in the cloud. Returns the
 *  downloaded stem WAVs ready to be written to the asset dir. */
export async function separateStemsOnCloud(
    userId: string,
    assetId: string,
    sourceWav: Buffer,
    opts: { model?: string } = {},
): Promise<({ ok: true; stems: Record<string, Buffer>; sampleRate: number; durationSec: number; device: string; model: string }) | CloudStemsError> {
    const url = process.env.GCP_DEMUCS_URL;
    if (!url) return { ok: false, error: "GCP_DEMUCS_URL not set", via: "cloud-demucs" };

    const inputGs = buildInputUploadGs(userId, assetId);
    const outputGsPrefix = buildStemsOutputPrefix(userId, assetId);

    try {
        await uploadGcs(inputGs, sourceWav);
    } catch (e) {
        return { ok: false, error: `upload source: ${(e as Error).message}`, via: "cloud-demucs" };
    }

    const audience = new URL(url).origin;
    const token = await mintGoogleIdToken(audience);
    if (!token) return { ok: false, error: "could not mint ID token", via: "cloud-demucs" };

    let resp: Response;
    try {
        resp = await fetch(`${url}/separate`, {
            method: "POST",
            headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ inputGs, outputGsPrefix, model: opts.model }),
            signal: AbortSignal.timeout(900_000),
            cache: "no-store",
        });
    } catch (e) {
        return { ok: false, error: `request: ${(e as Error).message}`, via: "cloud-demucs" };
    }
    if (!resp.ok) {
        let msg = `HTTP ${resp.status}`;
        try { const j = await resp.json() as { error?: string }; if (j?.error) msg += `: ${j.error}`; } catch { /* ignore */ }
        return { ok: false, error: msg, via: "cloud-demucs" };
    }
    const j = await resp.json() as CloudStemsResult;
    if (!j.ok) return { ok: false, error: "service returned ok=false", via: "cloud-demucs" };

    const stems: Record<string, Buffer> = {};
    for (const [name, gs] of Object.entries(j.stems)) {
        try {
            stems[name] = await downloadGcs(gs);
        } catch (e) {
            return { ok: false, error: `download ${name}: ${(e as Error).message}`, via: "cloud-demucs" };
        }
    }

    return {
        ok: true,
        stems,
        sampleRate: j.sampleRate,
        durationSec: j.durationSec,
        device: j.device,
        model: j.model,
    };
}
