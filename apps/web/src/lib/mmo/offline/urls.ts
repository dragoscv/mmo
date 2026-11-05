/**
 * Source URLs for offline downloads. Always the ORIGINAL bytes (never HLS, never a transcode):
 *  - video: `/video/direct/:fileId` (range-capable; the server prefers its pre-remuxed sidecar when present)
 *  - track: Subsonic `stream.view` without `timeOffset` = the original file as-is (`MusicClient.streamUrl`).
 * Credentials ride in `?t=&u=` / `apiKey`; the manager strips them before persisting anything.
 */
import type { ServerConfig } from "../config";

export function offlineVideoUrl(cfg: ServerConfig, serverFileId: string): string {
    const q = new URLSearchParams({ t: cfg.token });
    if (cfg.userId) q.set("u", cfg.userId);
    return `${cfg.baseUrl}/video/direct/${encodeURIComponent(serverFileId)}?${q.toString()}`;
}

/** `music.streamUrl(track)` already signs with `apiKey`; re-exported for symmetry. */
export function offlineTrackUrl(music: { streamUrl(t: { id: string; streamUrlPath: string }): string }, track: { id: string; streamUrlPath: string }): string {
    return music.streamUrl(track);
}
