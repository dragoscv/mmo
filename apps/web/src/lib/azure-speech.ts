import "server-only";

/**
 * Azure Speech (TTS + STT) helper.
 *
 * Uses the pay-as-you-go S0 resource `speech-mmo` (rg-mmo / westeurope).
 * Auth = subscription key only — no token-exchange dance needed for the
 * REST API. Costs: $15 per 1M characters for Neural TTS.
 *
 * Why direct REST instead of the official `microsoft-cognitiveservices-
 * speech-sdk` package: the SDK is ~1 MB and pulls a WASM blob that
 * conflicts with Next.js edge runtime detection. The REST endpoint is
 * tiny, returns audio bytes directly, and works in Node 22 with
 * undici.fetch.
 *
 * Spoken intros/outros are a great Maestro feature for music videos
 * and podcasts — "Hello and welcome back to the show…" in the user’s
 * preferred Romanian or English voice. Singing is NOT supported by
 * Azure (their Custom Neural Voice singing add-on is enterprise-only
 * and approval-gated; that pillar stays on F5-TTS / XTTS via the
 * companion).
 */

export interface AzureTtsOptions {
    text: string;
    /** Full Neural voice id, e.g. `ro-RO-AlinaNeural` or `en-US-JennyNeural`. */
    voice?: string;
    /** SSML <prosody rate>. Number 0.5-2.0 OR string like "+10%" / "-20%". */
    rate?: number | string;
    /** SSML <prosody pitch>. Number = semitones (-12..12) OR string like "+5%". */
    pitch?: number | string;
    /**
     * Optional Azure speaking-style for multi-style voices.
     * e.g. `cheerful`, `sad`, `angry`, `newscast`, `customerservice`.
     * Only a subset of voices support styles — invalid combos are silently ignored
     * by Azure (they fall back to the default style).
     */
    style?: string;
    /**
     * Output format from the REST API. `audio-24khz-160kbitrate-mono-mp3`
     * is a good default for web playback at low cost. Use `riff-48khz-16bit-mono-pcm`
     * for direct DAW import.
     */
    outputFormat?: string;
}

export interface AzureTtsResult {
    /** Audio bytes — encoding matches `outputFormat`. */
    audio: Buffer;
    /** MIME type derived from `outputFormat`. */
    contentType: string;
    /** Characters billed (approximate; SSML markup is counted). */
    billedChars: number;
}

const DEFAULT_VOICE = "ro-RO-AlinaNeural";
const DEFAULT_FORMAT = "audio-24khz-160kbitrate-mono-mp3";

function formatToMime(fmt: string): string {
    if (fmt.endsWith("mp3")) return "audio/mpeg";
    if (fmt.startsWith("riff")) return "audio/wav";
    if (fmt.endsWith("ogg")) return "audio/ogg";
    if (fmt.endsWith("opus")) return "audio/opus";
    return "application/octet-stream";
}

function escapeXml(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

function buildSsml(opts: AzureTtsOptions): string {
    const voice = opts.voice ?? DEFAULT_VOICE;
    // Locale is the first two segments of the voice id, e.g. "ro-RO".
    const locale = voice.split("-").slice(0, 2).join("-");

    let inner = escapeXml(opts.text);

    const rateStr = typeof opts.rate === "number" ? `${opts.rate.toFixed(2)}` : opts.rate;
    const pitchStr =
        typeof opts.pitch === "number" ? `${opts.pitch >= 0 ? "+" : ""}${opts.pitch}st` : opts.pitch;
    if (rateStr || pitchStr) {
        const attrs: string[] = [];
        if (rateStr) attrs.push(`rate="${rateStr}"`);
        if (pitchStr) attrs.push(`pitch="${pitchStr}"`);
        inner = `<prosody ${attrs.join(" ")}>${inner}</prosody>`;
    }

    if (opts.style) {
        inner = `<mstts:express-as style="${escapeXml(opts.style)}">${inner}</mstts:express-as>`;
    }

    return `<speak version="1.0" xml:lang="${locale}" xmlns:mstts="https://www.w3.org/2001/mstts">` +
        `<voice name="${voice}">${inner}</voice></speak>`;
}

export async function synthesizeAzureTts(opts: AzureTtsOptions): Promise<AzureTtsResult> {
    const key = process.env.AZURE_SPEECH_KEY;
    const region = process.env.AZURE_SPEECH_REGION ?? "westeurope";
    if (!key) {
        throw new Error("AZURE_SPEECH_KEY is not set on the server.");
    }
    const outputFormat = opts.outputFormat ?? DEFAULT_FORMAT;
    const endpoint = `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`;
    const ssml = buildSsml(opts);

    const res = await fetch(endpoint, {
        method: "POST",
        headers: {
            "Ocp-Apim-Subscription-Key": key,
            "Content-Type": "application/ssml+xml",
            "X-Microsoft-OutputFormat": outputFormat,
            "User-Agent": "mmo-maestro/1.0",
        },
        body: ssml,
    });

    if (!res.ok) {
        const body = await res.text().catch(() => "<unreadable>");
        throw new Error(`Azure TTS ${res.status} ${res.statusText}: ${body.slice(0, 300)}`);
    }

    const arr = await res.arrayBuffer();
    return {
        audio: Buffer.from(arr),
        contentType: formatToMime(outputFormat),
        billedChars: ssml.length,
    };
}

/**
 * Curated voice catalog for the Maestro UI. Not exhaustive — Azure exposes
 * 500+ voices; these are the ones that make sense for Romanian-music users
 * and English-narration podcasts.
 */
export const AZURE_VOICES = [
    // Romanian
    { id: "ro-RO-AlinaNeural", label: "Alina (Romanian, female)", locale: "ro-RO" },
    { id: "ro-RO-EmilNeural", label: "Emil (Romanian, male)", locale: "ro-RO" },
    // English
    { id: "en-US-JennyNeural", label: "Jenny (US English, female, multistyle)", locale: "en-US" },
    { id: "en-US-GuyNeural", label: "Guy (US English, male)", locale: "en-US" },
    { id: "en-GB-RyanNeural", label: "Ryan (UK English, male)", locale: "en-GB" },
    // Spanish (large LatAm club music scene)
    { id: "es-ES-AlvaroNeural", label: "Álvaro (Spanish, male)", locale: "es-ES" },
] as const;
