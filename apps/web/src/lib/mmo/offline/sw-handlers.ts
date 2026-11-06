/**
 * Service-worker side of offline downloads (WP16-42), imported by `app/sw.ts`.
 *
 *  - `/__offline/<key>` → stitched from the parts in `mixai-offline-v1` (200 full / 206 Range / 416).
 *  - `/__offline/<key>/poster` → stored poster.
 *  - Offline navigation to `/media/downloads*` (and the shell files) → the static, user-agnostic shell
 *    `public/offline/downloads.html` from `mixai-offline-shell-v1`. Online it is plain network: per-user HTML
 *    is still never cached.
 * Pure except for `caches` / `fetch` / `indexedDB` globals (available in both window and worker scope).
 */
import {
    DOWNLOADS_ROUTE, IDB_NAME, OFFLINE_CACHE, SHELL_ASSETS, SHELL_CACHE, SHELL_DEPS, SHELL_PAGE, manifestUrl, parseOfflinePath, partUrl,
    posterUrl,
} from "./keys";
import { contentRange, parseRange, planSlices } from "./range";
import type { OfflineManifest } from "./types";

export function isOfflinePath(pathname: string): boolean {
    return parseOfflinePath(pathname) !== null;
}

/** Builds the response for one offline request from already-loaded part blobs. Pure (testable). */
export function sliceResponse(manifest: OfflineManifest, partBlobs: readonly Blob[], rangeHeader: string | null): Response {
    const { size, type } = manifest;
    const base = { "Accept-Ranges": "bytes", "Content-Type": type || "application/octet-stream", "Cache-Control": "no-store" };
    const r = parseRange(rangeHeader, size);
    if (r === "unsatisfiable") return new Response(null, { status: 416, headers: { ...base, "Content-Range": `bytes */${size}` } });
    const win = r ?? { start: 0, end: size - 1 };
    const pieces: Blob[] = [];
    for (const s of planSlices(manifest.parts, win.start, win.end)) {
        const b = partBlobs[s.index];
        if (!b) return new Response(null, { status: 404 });
        pieces.push(b.slice(s.from, s.to + 1));
    }
    const body = new Blob(pieces, { type: base["Content-Type"] });
    const len = size === 0 ? 0 : win.end - win.start + 1;
    if (!r) return new Response(body, { status: 200, headers: { ...base, "Content-Length": String(len) } });
    return new Response(body, { status: 206, headers: { ...base, "Content-Length": String(len), "Content-Range": contentRange(win, size) } });
}

export async function handleOfflineRequest({ request, url }: { request: Request; url: URL }): Promise<Response> {
    const parsed = parseOfflinePath(url.pathname);
    if (!parsed) return new Response(null, { status: 404 });
    const cache = await caches.open(OFFLINE_CACHE);
    if (parsed.sub === "poster") return (await cache.match(posterUrl(parsed.key))) ?? new Response(null, { status: 404 });
    const mres = await cache.match(manifestUrl(parsed.key));
    if (!mres) return new Response(null, { status: 404 });
    const manifest = (await mres.json()) as OfflineManifest;
    const range = parseRange(request.headers.get("Range"), manifest.size);
    const win = range && range !== "unsatisfiable" ? range : { start: 0, end: manifest.size - 1 };
    // Load only the parts the window touches (blobs are disk-backed; slicing does not read them).
    const blobs: Blob[] = [];
    if (range !== "unsatisfiable") {
        for (const s of planSlices(manifest.parts, win.start, win.end)) {
            const p = await cache.match(partUrl(parsed.key, s.index));
            if (!p) return new Response(null, { status: 404 });
            blobs[s.index] = await p.blob();
        }
    }
    return sliceResponse(manifest, blobs, request.headers.get("Range"));
}

/** Navigations that the static offline shell may answer when the network is down. */
export function isShellRequest(url: URL, request: Request): boolean {
    if (SHELL_ASSETS.includes(url.pathname)) return true;
    // `/downloads` = the clean URL on tv.mixai.ro (rewritten to DOWNLOADS_ROUTE by proxy.ts while online).
    const isDownloads = (p: string): boolean => p === DOWNLOADS_ROUTE || p.startsWith(`${DOWNLOADS_ROUTE}/`) || p === "/downloads"
        || p.startsWith("/downloads/") || p.startsWith("/offline/");
    if (request.mode === "navigate") return isDownloads(url.pathname);
    // Tokens CSS / theme script requested BY a downloads document: everywhere else they keep `defaultCache`.
    if (!SHELL_DEPS.includes(url.pathname) || !request.referrer) return false;
    try {
        const ref = new URL(request.referrer);
        return ref.origin === url.origin && isDownloads(ref.pathname);
    } catch {
        return false;
    }
}

/** Network first; offline → the cached static shell (never a per-user page). */
export async function handleShellRequest({ request, url }: { request: Request; url: URL }): Promise<Response> {
    try {
        return await fetch(request);
    } catch {
        const cache = await caches.open(SHELL_CACHE);
        const asset = SHELL_ASSETS.includes(url.pathname) || SHELL_DEPS.includes(url.pathname) ? url.pathname : SHELL_PAGE;
        const hit = await cache.match(asset);
        if (hit) return hit;
        // Shell never cached (no download started yet): the precached static `/offline` page.
        if (request.mode === "navigate") {
            const fallback = await caches.match("/offline", { ignoreSearch: true });
            if (fallback) return fallback;
        }
        return Response.error();
    }
}

/** Sign-out: the download records are per user too. */
export function deleteOfflineDb(): Promise<void> {
    return new Promise((resolve) => {
        try {
            const r = indexedDB.deleteDatabase(IDB_NAME);
            r.onsuccess = r.onerror = r.onblocked = () => resolve();
        } catch {
            resolve();
        }
    });
}
