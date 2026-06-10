"use client";

import { useRef } from "react";
import { Upload } from "lucide-react";

/** Convert SRT text → WebVTT (browsers only natively render VTT). */
function srtToVtt(srt: string): string {
    return "WEBVTT\n\n" + srt
        .replace(/\r+/g, "")
        .replace(/^\d+\s*$/gm, "")
        .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2")
        .trim();
}

export function SubtitleUploadButton({ onPick }: {
    onPick: (t: { src: string; lang: string; label: string }) => void;
}) {
    const inputRef = useRef<HTMLInputElement>(null);

    return (
        <>
            <input
                ref={inputRef}
                type="file"
                accept=".srt,.vtt,text/vtt,application/x-subrip"
                style={{ display: "none" }}
                onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    const text = await file.text();
                    const isSrt = file.name.toLowerCase().endsWith(".srt") || /\d+\s*\n\d{2}:\d{2}/.test(text.slice(0, 200));
                    const vtt = isSrt ? srtToVtt(text) : text;
                    const blob = new Blob([vtt], { type: "text/vtt" });
                    const url = URL.createObjectURL(blob);
                    onPick({ src: url, lang: "local", label: file.name.replace(/\.(srt|vtt)$/i, "") });
                    if (inputRef.current) inputRef.current.value = "";
                }}
            />
            <button
                type="button"
                onClick={() => inputRef.current?.click()}
                title="Upload local .srt/.vtt"
                style={{
                    background: "rgba(0,0,0,0.6)", border: "1px solid rgba(255,255,255,0.1)",
                    color: "white", borderRadius: 6, padding: "6px 8px", cursor: "pointer",
                    display: "inline-flex", alignItems: "center", gap: 6,
                }}
            >
                <Upload size={14} />
            </button>
        </>
    );
}
