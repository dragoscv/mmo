import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import { companionLibrary, getCompanionLink } from "@/lib/companion-library";

const execFileAsync = promisify(execFile);

/** Per-bar RGB data: [r, g, b] each 0-1, plus amplitude 0-1 */
export interface RGBPeak {
    r: number;
    g: number;
    b: number;
    amp: number;
}

const rgbCache = new Map<number, RGBPeak[]>();
const PEAK_COUNT = 200;

/**
 * Generate RGB waveform peaks like rekordbox:
 * - Decode audio with ffmpeg to stereo 16-bit PCM at 22050 Hz
 * - For each chunk, compute spectral energy in 3 bands (bass, mid, treble)
 * - Map to RGB: bass → red/warm, mid → green, treble → blue/cyan
 */
async function generateRGBPeaks(filepath: string): Promise<RGBPeak[]> {
    const tmpFile = path.join(os.tmpdir(), `waveform-rgb-${Date.now()}.raw`);

    try {
        // Higher sample rate for better frequency resolution
        const sampleRate = 22050;
        await execFileAsync("ffmpeg", [
            "-i", filepath,
            "-ac", "1",
            "-ar", String(sampleRate),
            "-f", "s16le",
            "-y",
            tmpFile,
        ], { timeout: 30000 });

        const raw = fs.readFileSync(tmpFile);
        const samples = new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
        const chunkSize = Math.max(1, Math.floor(samples.length / PEAK_COUNT));
        const peaks: RGBPeak[] = [];

        for (let i = 0; i < PEAK_COUNT; i++) {
            const start = i * chunkSize;
            const end = Math.min(start + chunkSize, samples.length);
            const len = end - start;

            // Simple spectral analysis via zero-crossing rate and energy bands
            // We'll use a basic DFT on small windows to get frequency bands
            let totalEnergy = 0;
            let bassEnergy = 0;  // 20-250 Hz
            let midEnergy = 0;   // 250-4000 Hz
            let trebleEnergy = 0; // 4000-11025 Hz

            // Use overlapping sub-windows for better frequency resolution
            const fftSize = 512;
            const numWindows = Math.max(1, Math.floor(len / fftSize));

            for (let w = 0; w < numWindows; w++) {
                const wStart = start + w * fftSize;
                const wEnd = Math.min(wStart + fftSize, end);
                const windowLen = wEnd - wStart;

                // Compute energy in frequency bands using Goertzel-like approach
                // Bass bins: frequencies 20-250 Hz → bins ~0.5-5.8 at 22050/512
                // Mid bins: 250-4000 Hz → bins ~5.8-93
                // Treble bins: 4000-11025 Hz → bins ~93-256
                const binSize = sampleRate / fftSize;

                // Simple energy computation per band using bandpass approximation
                let bE = 0, mE = 0, tE = 0;
                for (let j = 0; j < windowLen; j++) {
                    const v = samples[wStart + j] / 32768;
                    totalEnergy += v * v;
                }

                // Compute a few DFT bins for each band
                const bassBins = [2, 3, 4, 5];        // ~86-215 Hz
                const midBins = [8, 12, 18, 25, 35, 50]; // ~344-2153 Hz
                const trebleBins = [70, 100, 140, 180];  // ~3013-7747 Hz

                for (const k of bassBins) {
                    let re = 0, im = 0;
                    for (let j = 0; j < windowLen; j++) {
                        const v = samples[wStart + j] / 32768;
                        const angle = (2 * Math.PI * k * j) / windowLen;
                        re += v * Math.cos(angle);
                        im -= v * Math.sin(angle);
                    }
                    bE += (re * re + im * im) / windowLen;
                }
                for (const k of midBins) {
                    let re = 0, im = 0;
                    for (let j = 0; j < windowLen; j++) {
                        const v = samples[wStart + j] / 32768;
                        const angle = (2 * Math.PI * k * j) / windowLen;
                        re += v * Math.cos(angle);
                        im -= v * Math.sin(angle);
                    }
                    mE += (re * re + im * im) / windowLen;
                }
                for (const k of trebleBins) {
                    if (k >= windowLen / 2) continue;
                    let re = 0, im = 0;
                    for (let j = 0; j < windowLen; j++) {
                        const v = samples[wStart + j] / 32768;
                        const angle = (2 * Math.PI * k * j) / windowLen;
                        re += v * Math.cos(angle);
                        im -= v * Math.sin(angle);
                    }
                    tE += (re * re + im * im) / windowLen;
                }

                bassEnergy += bE / bassBins.length;
                midEnergy += mE / midBins.length;
                trebleEnergy += tE / trebleBins.length;
            }

            // Normalize per window count
            if (numWindows > 0) {
                bassEnergy /= numWindows;
                midEnergy /= numWindows;
                trebleEnergy /= numWindows;
                totalEnergy /= len;
            }

            const amp = Math.sqrt(totalEnergy);
            peaks.push({
                r: Math.sqrt(bassEnergy),
                g: Math.sqrt(midEnergy),
                b: Math.sqrt(trebleEnergy),
                amp,
            });
        }

        // Normalize all channels to 0-1
        const maxR = Math.max(...peaks.map(p => p.r), 0.001);
        const maxG = Math.max(...peaks.map(p => p.g), 0.001);
        const maxB = Math.max(...peaks.map(p => p.b), 0.001);
        const maxAmp = Math.max(...peaks.map(p => p.amp), 0.001);

        return peaks.map(p => ({
            r: p.r / maxR,
            g: p.g / maxG,
            b: p.b / maxB,
            amp: p.amp / maxAmp,
        }));
    } finally {
        try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    }
}

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
    const trackId = parseInt(id);

    if (isNaN(trackId)) {
        return NextResponse.json({ error: "Invalid track ID" }, { status: 400 });
    }

    if (rgbCache.has(trackId)) {
        return NextResponse.json(
            { peaks: rgbCache.get(trackId) },
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
        const peaks = await generateRGBPeaks(track.filepath);
        rgbCache.set(trackId, peaks);

        if (rgbCache.size > 500) {
            const firstKey = rgbCache.keys().next().value;
            if (firstKey !== undefined) rgbCache.delete(firstKey);
        }

        return NextResponse.json(
            { peaks },
            { headers: { "Cache-Control": "public, max-age=86400" } }
        );
    } catch {
        return NextResponse.json(
            { error: "Failed to generate RGB waveform" },
            { status: 500 }
        );
    }
}
