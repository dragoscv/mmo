/**
 * POST /api/recordings/save
 *
 * Multipart upload from the browser MediaRecorder. Saves the blob to the
 * configured recordings folder and creates a DB row.
 *
 * FormData fields:
 *   file:        Blob (audio/webm or similar)
 *   source:      "live" | "mixer" | "daw" | "editor"
 *   durationMs:  string (number)
 *   name:        string (optional)
 *   metadata:    string JSON (optional)
 */

import { NextRequest, NextResponse } from "next/server";
import { saveRecording, type RecordingSource } from "@/actions/recordings";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_BYTES = 1024 * 1024 * 1024; // 1 GB hard cap
const VALID_SOURCES: RecordingSource[] = ["live", "mixer", "daw", "editor"];

export async function POST(req: NextRequest) {
    try {
        const form = await req.formData();
        const file = form.get("file");
        const source = String(form.get("source") ?? "");
        const durationMs = Number(form.get("durationMs") ?? 0);
        const name = form.get("name") ? String(form.get("name")) : undefined;
        const metadataRaw = form.get("metadata");

        if (!(file instanceof Blob)) {
            return NextResponse.json({ error: "Missing 'file' (Blob)" }, { status: 400 });
        }
        if (!VALID_SOURCES.includes(source as RecordingSource)) {
            return NextResponse.json({ error: `Invalid source. Expected one of ${VALID_SOURCES.join(", ")}` }, { status: 400 });
        }
        if (file.size === 0) {
            return NextResponse.json({ error: "Empty file" }, { status: 400 });
        }
        if (file.size > MAX_BYTES) {
            return NextResponse.json({ error: `File too large (${file.size} > ${MAX_BYTES})` }, { status: 413 });
        }

        let metadata: Record<string, unknown> | undefined;
        if (typeof metadataRaw === "string" && metadataRaw.trim()) {
            try { metadata = JSON.parse(metadataRaw) as Record<string, unknown>; }
            catch { /* ignore malformed metadata */ }
        }

        const result = await saveRecording({
            source: source as RecordingSource,
            arrayBuffer: await file.arrayBuffer(),
            mimeType: file.type || "audio/webm",
            durationMs,
            name,
            metadata,
        });

        if (!result.success) {
            return NextResponse.json({ error: result.error }, { status: 500 });
        }
        return NextResponse.json({ recording: result.recording });
    } catch (e) {
        return NextResponse.json({
            error: e instanceof Error ? e.message : "Upload failed",
        }, { status: 500 });
    }
}
