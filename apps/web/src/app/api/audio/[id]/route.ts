import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { companionLibrary, getCompanionLink } from "@/lib/companion-library";
import { requireRate } from "@/lib/api-guard";

const MIME_TYPES: Record<string, string> = {
    ".mp3": "audio/mpeg",
    ".flac": "audio/flac",
    ".wav": "audio/wav",
    ".aac": "audio/aac",
    ".m4a": "audio/mp4",
    ".ogg": "audio/ogg",
    ".wma": "audio/x-ms-wma",
    ".aiff": "audio/aiff",
    ".aif": "audio/aiff",
};

// Path-containment allowlist for the local-FS streaming branch.
// `track.filepath` arrives from the user's companion DB, which is user input
// from this server's perspective — without this allowlist an authenticated
// user could point `filepath` at /etc/passwd, ./.env.local, the web app's
// SQLite, mounted secrets, etc. and exfiltrate them via this route (Range
// header lets it be done in chunks, ?download=1 lets it be saved with any
// name). Set MMO_LOCAL_AUDIO_ROOTS to a comma-separated list of absolute
// directories the server is willing to stream from. When unset (the safe
// default for hosted/multi-tenant deployments) we refuse to read the FS at
// all and the client must fall back to /api/audio/device/[id], which proxies
// the bytes through the companion instead.
const ALLOWED_ROOTS: readonly string[] = (() => {
    const raw = process.env.MMO_LOCAL_AUDIO_ROOTS ?? "";
    return raw.split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((r) => {
            try { return fs.realpathSync.native(path.resolve(r)); }
            catch { return ""; }
        })
        .filter(Boolean);
})();

function safeResolveAudioPath(raw: unknown): string | null {
    if (typeof raw !== "string" || raw.length === 0 || raw.length > 4096) return null;
    if (raw.includes("\0")) return null; // null-byte truncation guard
    let resolved: string;
    try { resolved = fs.realpathSync.native(path.resolve(raw)); }
    catch { return null; }
    return ALLOWED_ROOTS.some((root) =>
        resolved === root || resolved.startsWith(root + path.sep),
    ) ? resolved : null;
}

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    // Per-IP rate limit: audio streaming is bandwidth-heavy and the local
    // FS branch can also serve large files; cap at 120 requests/minute/IP
    // (~2/sec, well above legitimate seek/restart patterns).
    const blocked = requireRate(request, { bucket: "audio-stream", windowMs: 60_000, max: 120 });
    if (blocked) return blocked;
    const { id } = await params;
    const trackId = parseInt(id);

    if (isNaN(trackId)) {
        return NextResponse.json({ error: "Invalid track ID" }, { status: 400 });
    }

    const link = await getCompanionLink();
    if (!link) {
        return NextResponse.json({ error: "Companion not connected" }, { status: 503 });
    }

    // Refuse to touch the local FS unless the operator opted in via
    // MMO_LOCAL_AUDIO_ROOTS. Hosted/multi-tenant deployments leave this
    // unset; clients must fall back to /api/audio/device/[id], which
    // streams via the companion's HTTP API.
    if (ALLOWED_ROOTS.length === 0) {
        return NextResponse.json(
            { error: "Local audio streaming not configured on this server" },
            { status: 501 },
        );
    }

    const track = await companionLibrary.getTrackById(link, trackId);

    if (!track) {
        return NextResponse.json({ error: "Track not found" }, { status: 404 });
    }

    const filepath = safeResolveAudioPath(track.filepath);
    if (!filepath) {
        // Either invalid string, symlink-escape, or outside every allowed
        // root. Don't leak which by varying status codes.
        return NextResponse.json({ error: "Track path not permitted" }, { status: 403 });
    }

    if (!fs.existsSync(filepath)) {
        return NextResponse.json(
            { error: "Audio file not found on disk" },
            { status: 404 }
        );
    }

    const stat = fs.statSync(filepath);
    const fileSize = stat.size;
    const ext = path.extname(filepath).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";

    // Optional download mode: sets Content-Disposition so the browser
    // saves the file using a friendly "Artist - Title.ext" name.
    const isDownload = request.nextUrl.searchParams.get("download") === "1";
    const downloadHeaders: Record<string, string> = {};
    if (isDownload) {
        const sanitize = (s: string) =>
            s.replace(/[<>:"/\\|?*\x00-\x1F]/g, "").trim();
        const artist = sanitize(track.artist || "");
        const title = sanitize(track.title || "");
        const base =
            artist && title
                ? `${artist} - ${title}`
                : sanitize(track.filename || path.basename(filepath, ext)) ||
                `track-${track.id}`;
        const safeName = `${base}${ext}`.slice(0, 200);
        // RFC 5987 encoding for non-ASCII filenames
        const asciiFallback = safeName.replace(/[^\x20-\x7E]/g, "_");
        downloadHeaders["Content-Disposition"] =
            `attachment; filename="${asciiFallback.replace(/"/g, "")}"; ` +
            `filename*=UTF-8''${encodeURIComponent(safeName)}`;
    }

    const rangeHeader = request.headers.get("range");

    if (rangeHeader) {
        // Strict bytes=<start>-<end> | bytes=<start>- | bytes=-<suffix> parser.
        // Returns 416 with `Content-Range: bytes */<size>` for any malformed
        // or unsatisfiable range so we never stream garbage with a wrong
        // Content-Length (e.g. NaN start + parseInt("") suffix).
        const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
        if (!m) {
            return new Response(null, {
                status: 416,
                headers: { "Content-Range": `bytes */${fileSize}` },
            });
        }
        const startStr = m[1] ?? "";
        const endStr = m[2] ?? "";
        let start: number;
        let end: number;
        if (startStr === "" && endStr === "") {
            return new Response(null, {
                status: 416,
                headers: { "Content-Range": `bytes */${fileSize}` },
            });
        } else if (startStr === "") {
            // Suffix range: last N bytes.
            const suffix = parseInt(endStr, 10);
            if (!Number.isFinite(suffix) || suffix <= 0) {
                return new Response(null, {
                    status: 416,
                    headers: { "Content-Range": `bytes */${fileSize}` },
                });
            }
            start = Math.max(0, fileSize - suffix);
            end = fileSize - 1;
        } else {
            start = parseInt(startStr, 10);
            end = endStr === "" ? fileSize - 1 : parseInt(endStr, 10);
        }
        if (
            !Number.isFinite(start) || !Number.isFinite(end) ||
            start < 0 || start >= fileSize || end < start
        ) {
            return new Response(null, {
                status: 416,
                headers: { "Content-Range": `bytes */${fileSize}` },
            });
        }
        end = Math.min(end, fileSize - 1);
        const chunkSize = end - start + 1;

        const stream = fs.createReadStream(filepath, { start, end });
        const readable = new ReadableStream({
            start(controller) {
                stream.on("data", (chunk: Buffer | string) => {
                    controller.enqueue(new Uint8Array(Buffer.from(chunk)));
                });
                stream.on("end", () => controller.close());
                stream.on("error", (err) => controller.error(err));
            },
            cancel() {
                stream.destroy();
            },
        });

        return new Response(readable, {
            status: 206,
            headers: {
                "Content-Range": `bytes ${start}-${end}/${fileSize}`,
                "Accept-Ranges": "bytes",
                "Content-Length": String(chunkSize),
                "Content-Type": contentType,
                ...downloadHeaders,
            },
        });
    }

    // Full file response
    const stream = fs.createReadStream(filepath);
    const readable = new ReadableStream({
        start(controller) {
            stream.on("data", (chunk: Buffer | string) => {
                controller.enqueue(new Uint8Array(Buffer.from(chunk)));
            });
            stream.on("end", () => controller.close());
            stream.on("error", (err) => controller.error(err));
        },
        cancel() {
            stream.destroy();
        },
    });

    return new Response(readable, {
        status: 200,
        headers: {
            "Content-Length": String(fileSize),
            "Content-Type": contentType,
            "Accept-Ranges": "bytes",
            ...downloadHeaders,
        },
    });
}
