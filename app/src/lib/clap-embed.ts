/**
 * CLAP audio embedding client.
 *
 * Tries the companion's CLAP engine first (offline, free, GPU-accelerated if
 * the user has CUDA). Falls back to the Cloud Run mmo-clap service when the
 * companion is offline or has no CLAP venv installed.
 *
 * Both paths use the same model — `laion/larger_clap_music_and_speech`
 * (512-d, L2-normalized) — so embeddings produced by either path are
 * directly comparable in pgvector for cosine similarity search.
 *
 * Cloud Run authentication: signed by minting a Google ID token with
 * audience=GCP_CLAP_URL via google-auth-library. The Next.js server has
 * Application Default Credentials when running on Vercel via OIDC, or
 * the GOOGLE_APPLICATION_CREDENTIALS env var locally.
 */

import "server-only";

import { promises as fsp } from "node:fs";
import { getCompanionLink } from "@/lib/companion-library";

export interface ClapEmbedResult {
    ok: true;
    embedding: number[];
    model: string;
    dim: number;
    via: "companion" | "cloud-run";
}

export interface ClapEmbedError {
    ok: false;
    error: string;
    via?: "companion" | "cloud-run" | "none";
}

export type ClapEmbedResponse = ClapEmbedResult | ClapEmbedError;

/** Embed an audio file. Caller supplies an absolute local filesystem path
 *  (the companion runs on the same machine, so it can read directly; the
 *  Cloud Run fallback uploads the bytes). */
export async function embedAudio(absPath: string): Promise<ClapEmbedResponse> {
    // 1. Try companion first
    const viaCompanion = await tryCompanion(absPath);
    if (viaCompanion) return viaCompanion;

    // 2. Fall back to Cloud Run
    const viaCloudRun = await tryCloudRun(absPath);
    if (viaCloudRun) return viaCloudRun;

    return { ok: false, error: "no-clap-backend-available", via: "none" };
}

async function tryCompanion(absPath: string): Promise<ClapEmbedResponse | null> {
    const link = await getCompanionLink();
    if (!link) return null;
    try {
        const res = await fetch(`${link.apiUrl}/voice/engines/clap/embed`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Device-Token": link.token,
                "X-User-Id": link.userId,
            },
            body: JSON.stringify({ inputPath: absPath }),
            signal: AbortSignal.timeout(120_000),
            cache: "no-store",
        });
        if (!res.ok) return null; // 404 = endpoint not installed; fall through to Cloud Run
        const j = (await res.json()) as { ok?: boolean; embedding?: number[]; model?: string; dim?: number; error?: string };
        if (!j.ok || !Array.isArray(j.embedding)) return null;
        return {
            ok: true,
            embedding: j.embedding,
            model: j.model ?? "laion/larger_clap_music_and_speech",
            dim: j.dim ?? j.embedding.length,
            via: "companion",
        };
    } catch {
        return null;
    }
}

async function tryCloudRun(absPath: string): Promise<ClapEmbedResponse | null> {
    const url = process.env.GCP_CLAP_URL;
    if (!url) return null;

    let bytes: Buffer;
    try {
        bytes = await fsp.readFile(absPath);
    } catch {
        return { ok: false, error: `file-not-readable: ${absPath}`, via: "cloud-run" };
    }

    let token: string | null = null;
    try {
        token = await mintGoogleIdToken(url);
    } catch (e) {
        return { ok: false, error: `auth-failed: ${(e as Error).message}`, via: "cloud-run" };
    }

    try {
        const form = new FormData();
        form.append("file", new Blob([new Uint8Array(bytes)]), "in.wav");
        const res = await fetch(`${url}/embed`, {
            method: "POST",
            headers: token ? { Authorization: `Bearer ${token}` } : {},
            body: form,
            signal: AbortSignal.timeout(120_000),
            cache: "no-store",
        });
        if (!res.ok) {
            const txt = await res.text().catch(() => "");
            return { ok: false, error: `cloud-run-${res.status}: ${txt.slice(0, 200)}`, via: "cloud-run" };
        }
        const j = (await res.json()) as { ok?: boolean; embedding?: number[]; model?: string; dim?: number };
        if (!j.ok || !Array.isArray(j.embedding)) {
            return { ok: false, error: "cloud-run-bad-response", via: "cloud-run" };
        }
        return {
            ok: true,
            embedding: j.embedding,
            model: j.model ?? "laion/larger_clap_music_and_speech",
            dim: j.dim ?? j.embedding.length,
            via: "cloud-run",
        };
    } catch (e) {
        return { ok: false, error: (e as Error).message, via: "cloud-run" };
    }
}

/** Mint a Google-signed ID token for the given audience URL.
 *  Uses the metadata server on Cloud Run / GCE, or ADC locally.
 *  @deprecated Use `mintGoogleIdToken` from `@/lib/google-id-token` instead. */
async function mintGoogleIdToken(audience: string): Promise<string | null> {
    const mod = await import("@/lib/google-id-token");
    return mod.mintGoogleIdToken(audience);
}
