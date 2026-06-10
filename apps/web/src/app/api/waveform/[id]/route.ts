import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import { companionLibrary, getCompanionLink } from "@/lib/companion-library";
import { requireRate } from "@/lib/api-guard";

const execFileAsync = promisify(execFile);

// In-memory cache for waveform data (trackId -> peaks)
const waveformCache = new Map<number, number[]>();

const PEAK_COUNT = 200;

/**
 * Generate waveform peaks using ffmpeg to decode audio to raw PCM,
 * then compute RMS peaks per chunk.
 */
async function generatePeaks(filepath: string): Promise<number[]> {
    const tmpFile = path.join(os.tmpdir(), `waveform-${Date.now()}.raw`);

    try {
        // Decode to mono 8kHz 16-bit PCM (small & fast)
        await execFileAsync("ffmpeg", [
            "-i", filepath,
            "-ac", "1",
            "-ar", "8000",
            "-f", "s16le",
            "-y",
            tmpFile,
        ], { timeout: 30000 });

        const raw = fs.readFileSync(tmpFile);
        const samples = new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);

        const chunkSize = Math.max(1, Math.floor(samples.length / PEAK_COUNT));
        const peaks: number[] = [];

        for (let i = 0; i < PEAK_COUNT; i++) {
            const start = i * chunkSize;
            const end = Math.min(start + chunkSize, samples.length);
            let sum = 0;
            for (let j = start; j < end; j++) {
                const v = samples[j] / 32768;
                sum += v * v;
            }
            const rms = Math.sqrt(sum / (end - start));
            peaks.push(rms);
        }

        // Normalize to 0-1
        const max = Math.max(...peaks, 0.001);
        return peaks.map((p) => p / max);
    } finally {
        try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    }
}

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    // Waveform generation spawns ffmpeg + reads the full PCM; without a
    // limit a hostile client can saturate CPU. 60/min/IP is plenty for
    // typical browsing patterns (cache hits don't reach the spawn).
    const blocked = requireRate(request, { bucket: "waveform", windowMs: 60_000, max: 60 });
    if (blocked) return blocked;
    const { id } = await params;
    const trackId = parseInt(id);

    if (isNaN(trackId)) {
        return NextResponse.json({ error: "Invalid track ID" }, { status: 400 });
    }

    // Check cache first
    if (waveformCache.has(trackId)) {
        return NextResponse.json(
            { peaks: waveformCache.get(trackId) },
            { headers: { "Cache-Control": "public, max-age=86400" } }
        );
    }

    const link = await getCompanionLink();
    if (!link) return NextResponse.json({ error: "Companion not connected" }, { status: 503 });
    const track = await companionLibrary.getTrackById(link, trackId);
    if (!track) {
        return NextResponse.json({ error: "Track not found" }, { status: 404 });
    }

    if (!fs.existsSync(track.filepath)) {
        return NextResponse.json({ error: "File not found" }, { status: 404 });
    }

    try {
        const peaks = await generatePeaks(track.filepath);
        waveformCache.set(trackId, peaks);

        // Cap cache size
        if (waveformCache.size > 500) {
            const firstKey = waveformCache.keys().next().value;
            if (firstKey !== undefined) waveformCache.delete(firstKey);
        }

        return NextResponse.json(
            { peaks },
            { headers: { "Cache-Control": "public, max-age=86400" } }
        );
    } catch (err) {
        return NextResponse.json(
            { error: "Failed to generate waveform" },
            { status: 500 }
        );
    }
}
