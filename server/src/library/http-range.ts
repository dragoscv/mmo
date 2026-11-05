/**
 * Ranged file responses (RFC 9110 single range): `bytes=a-b`, `bytes=a-`, `bytes=-n`.
 * Multi-range requests are answered with the first range only. Unsatisfiable → 416.
 */

import fs from "node:fs";
import type express from "express";

export function parseRange(header: string | undefined, size: number): { start: number; end: number } | "unsatisfiable" | null {
    if (!header) return null;
    const m = /^bytes=(\d*)-(\d*)/.exec(header.trim());
    if (!m || (m[1] === "" && m[2] === "")) return "unsatisfiable";
    let start: number;
    let end: number;
    if (m[1] === "") {
        const n = Number(m[2]);
        if (n === 0) return "unsatisfiable";
        start = Math.max(0, size - n);
        end = size - 1;
    } else {
        start = Number(m[1]);
        end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= size || start > end) return "unsatisfiable";
    return { start, end };
}

/** Streams `file` honouring `Range`. `extraHeaders` are sent on 200/206 (e.g. Content-Disposition). */
export function sendRangedFile(req: express.Request, res: express.Response, file: string, contentType: string, extraHeaders: Record<string, string> = {}): void {
    let size: number;
    try { size = fs.statSync(file).size; } catch { res.status(404).json({ error: "file missing on disk", code: "file_missing" }); return; }
    const r = parseRange(req.headers.range, size);
    if (r === "unsatisfiable") {
        res.writeHead(416, { "Content-Range": `bytes */${size}` });
        res.end();
        return;
    }
    const base = { "Accept-Ranges": "bytes", "Content-Type": contentType, ...extraHeaders };
    if (r) {
        res.writeHead(206, { ...base, "Content-Range": `bytes ${r.start}-${r.end}/${size}`, "Content-Length": r.end - r.start + 1 });
        if (req.method === "HEAD") { res.end(); return; }
        fs.createReadStream(file, { start: r.start, end: r.end }).pipe(res);
        return;
    }
    res.writeHead(200, { ...base, "Content-Length": size });
    if (req.method === "HEAD") { res.end(); return; }
    fs.createReadStream(file).pipe(res);
}

const CT: Record<string, string> = {
    ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".mkv": "video/x-matroska",
    ".avi": "video/x-msvideo", ".ts": "video/mp2t", ".m2ts": "video/mp2t", ".wmv": "video/x-ms-wmv",
};

export function videoContentType(ext: string): string {
    return CT[ext.toLowerCase()] ?? "application/octet-stream";
}

/** `attachment; filename="..."; filename*=UTF-8''...` with an ASCII fallback. */
export function contentDisposition(name: string): string {
    const ascii = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
    return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
