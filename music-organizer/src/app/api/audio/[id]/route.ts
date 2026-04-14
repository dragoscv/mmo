import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { tracks } from "@/db/schema";
import { eq } from "drizzle-orm";
import fs from "node:fs";
import path from "node:path";

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

    const track = db
        .select()
        .from(tracks)
        .where(eq(tracks.id, trackId))
        .get();

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
        },
    });
}
