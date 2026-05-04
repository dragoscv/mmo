import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { companionLibrary, getCompanionLink } from "@/lib/companion-library";

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

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
    const trackId = parseInt(id);

    if (isNaN(trackId)) {
        return NextResponse.json({ error: "Invalid track ID" }, { status: 400 });
    }

    const link = await getCompanionLink();
    if (!link) {
        return NextResponse.json({ error: "Companion not connected" }, { status: 503 });
    }
    const track = await companionLibrary.getTrackById(link, trackId);

    if (!track) {
        return NextResponse.json({ error: "Track not found" }, { status: 404 });
    }

    const filepath = track.filepath;

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
        // Handle range request for seeking
        const parts = rangeHeader.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
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
