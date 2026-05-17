/**
 * Companion-side cache for TMDB images.
 *
 * Saves remote TMDB images (image.tmdb.org/t/p/<size>/<path>) to local
 * disk so the web app can pull them via the companion for offline use
 * and to avoid hammering TMDB on every page load.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { app } from "electron";

const TMDB_BASE = "https://image.tmdb.org/t/p";
const VALID_SIZES = new Set([
    "w92", "w154", "w185", "w300", "w342", "w500", "w780", "w1280", "original",
]);

function cacheRoot(): string {
    try {
        return path.join(app.getPath("userData"), "tmdb-cache");
    } catch {
        return path.join(process.cwd(), ".tmdb-cache");
    }
}

function safePathSegment(p: string): string {
    return p.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export async function getCachedTmdbImage(size: string, imagePath: string): Promise<{ filePath: string; contentType: string }> {
    if (!VALID_SIZES.has(size)) throw new Error("invalid size");
    if (!/^\/[a-zA-Z0-9._-]+\.(jpg|png|webp)$/.test(imagePath)) throw new Error("invalid path");
    const dir = path.join(cacheRoot(), size);
    await fsp.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, safePathSegment(imagePath));
    const contentType = imagePath.endsWith(".png") ? "image/png" : imagePath.endsWith(".webp") ? "image/webp" : "image/jpeg";
    if (fs.existsSync(filePath) && (await fsp.stat(filePath)).size > 0) {
        return { filePath, contentType };
    }
    const url = `${TMDB_BASE}/${size}${imagePath}`;
    await downloadTo(url, filePath);
    return { filePath, contentType };
}

function downloadTo(url: string, dest: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const lib = url.startsWith("https:") ? https : http;
        lib.get(url, (res) => {
            if ((res.statusCode ?? 0) >= 300 && (res.statusCode ?? 0) < 400 && res.headers.location) {
                downloadTo(res.headers.location, dest).then(resolve, reject);
                return;
            }
            if ((res.statusCode ?? 0) !== 200) {
                reject(new Error(`TMDB cache: HTTP ${res.statusCode}`));
                return;
            }
            const ws = fs.createWriteStream(dest);
            res.pipe(ws);
            ws.on("finish", () => ws.close(() => resolve()));
            ws.on("error", reject);
        }).on("error", reject);
    });
}
