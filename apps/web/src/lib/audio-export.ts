/**
 * AudioBuffer → WAV (16-bit PCM) encoder + browser download helper.
 *
 * The DAW engine has its own private copy of the WAV writer
 * (`daw-engine.ts → audioBufferToWav`); this module is the public
 * surface for any other component (sound editor, recordings, etc.)
 * that needs to export a buffer the user can keep. Keeping the DAW
 * copy private avoids pulling its module into bundles that don't
 * already need it.
 *
 * Format: little-endian 16-bit PCM, RIFF/WAVE header. Channels are
 * interleaved sample-by-sample. Lossy at the bit-depth conversion
 * (Float32 → Int16) but matches what every CDJ, DAW, and stems tool
 * accepts without resampling.
 */

const HEADER_SIZE = 44;

export function audioBufferToWavBlob(buffer: AudioBuffer): Blob {
    const numChannels = buffer.numberOfChannels;
    const sampleRate = buffer.sampleRate;
    const length = buffer.length;
    const bytesPerSample = 2; // 16-bit
    const blockAlign = numChannels * bytesPerSample;
    const byteRate = sampleRate * blockAlign;
    const dataSize = length * blockAlign;
    const arrayBuffer = new ArrayBuffer(HEADER_SIZE + dataSize);
    const view = new DataView(arrayBuffer);

    const writeString = (offset: number, str: string) => {
        for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    };
    writeString(0, "RIFF");
    view.setUint32(4, 36 + dataSize, true);
    writeString(8, "WAVE");
    writeString(12, "fmt ");
    view.setUint32(16, 16, true);   // PCM chunk size
    view.setUint16(20, 1, true);    // PCM format
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);   // bits per sample
    writeString(36, "data");
    view.setUint32(40, dataSize, true);

    const channels: Float32Array[] = [];
    for (let ch = 0; ch < numChannels; ch++) channels.push(buffer.getChannelData(ch));

    let offset = HEADER_SIZE;
    for (let i = 0; i < length; i++) {
        for (let ch = 0; ch < numChannels; ch++) {
            const sample = Math.max(-1, Math.min(1, channels[ch][i]));
            view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
            offset += 2;
        }
    }

    return new Blob([arrayBuffer], { type: "audio/wav" });
}

/** Trigger a browser download of `blob` with `filename`. SSR-safe (no-op). */
export function downloadBlob(blob: Blob, filename: string): void {
    if (typeof window === "undefined" || typeof document === "undefined") return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Defer revocation a tick so Safari/Firefox commit the download.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Sanitize a string into a safe filename (no path separators, no control chars). */
export function safeFilename(name: string, fallback = "export"): string {
    const cleaned = name
        .replace(/[\x00-\x1f<>:"/\\|?*]/g, "_") // eslint-disable-line no-control-regex
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 200);
    return cleaned.length > 0 ? cleaned : fallback;
}
