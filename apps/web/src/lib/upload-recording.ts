"use client";

/**
 * uploadRecording — POSTs a MediaRecorder blob to /api/recordings/save and
 * fires a sonner toast with a "View" action linking to /recordings.
 *
 * Designed to be called from any engine's stopRecording() handler:
 *
 *   const result = await engine.stopRecordingAsync();
 *   if (result) await uploadRecording({ source: "live", blob: result.blob, durationMs: result.duration });
 */

import { toast } from "sonner";
import type { RecordingSource } from "@/actions/recordings";

interface UploadInput {
    source: RecordingSource;
    blob: Blob;
    durationMs: number;
    name?: string;
    metadata?: Record<string, unknown>;
}

interface SavedRecording {
    id: number;
    name: string;
    durationMs: number;
    sizeBytes: number;
}

interface UploadResponse {
    recording?: SavedRecording;
    error?: string;
}

const SOURCE_LABELS: Record<RecordingSource, string> = {
    live: "Live performance",
    mixer: "Mixer session",
    daw: "DAW session",
    editor: "Editor session",
};

function formatDuration(ms: number): string {
    const totalSec = Math.floor(ms / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    return `${min}:${String(sec).padStart(2, "0")}`;
}

function formatBytes(b: number): string {
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
    return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

export async function uploadRecording(input: UploadInput): Promise<SavedRecording | null> {
    if (!input.blob || input.blob.size === 0) {
        toast.error("Recording is empty — nothing to save.");
        return null;
    }

    const sourceLabel = SOURCE_LABELS[input.source];
    const sizeStr = formatBytes(input.blob.size);
    const durationStr = formatDuration(input.durationMs);

    // Show a loading toast that we'll resolve once the upload completes.
    const toastId = toast.loading(`Saving ${sourceLabel}…`, {
        description: `${durationStr} · ${sizeStr}`,
    });

    try {
        const form = new FormData();
        form.set("file", input.blob, "recording");
        form.set("source", input.source);
        form.set("durationMs", String(Math.round(input.durationMs)));
        if (input.name) form.set("name", input.name);
        if (input.metadata) form.set("metadata", JSON.stringify(input.metadata));

        const res = await fetch("/api/recordings/save", {
            method: "POST",
            body: form,
        });

        const data = (await res.json().catch(() => ({}))) as UploadResponse;

        if (!res.ok || !data.recording) {
            toast.error("Failed to save recording", {
                id: toastId,
                description: data.error ?? `HTTP ${res.status}`,
            });
            return null;
        }

        toast.success(`${sourceLabel} saved`, {
            id: toastId,
            description: `${data.recording.name} · ${durationStr} · ${sizeStr}`,
            duration: 8000,
            action: {
                label: "View",
                onClick: () => {
                    window.location.href = `/recordings#rec-${data.recording!.id}`;
                },
            },
        });

        return data.recording;
    } catch (e) {
        toast.error("Failed to save recording", {
            id: toastId,
            description: e instanceof Error ? e.message : "Network error",
        });
        return null;
    }
}
