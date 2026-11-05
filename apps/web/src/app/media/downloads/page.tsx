import { DownloadsView } from "./downloads-view";

/**
 * `/media/downloads` (WP16-42) — offline downloads of the active profile. Client-rendered from IndexedDB +
 * Cache Storage. With the network down the service worker answers this URL with the static shell
 * `public/offline/downloads.html` instead (the `/media` layout needs auth + server data and per-user HTML
 * is never cached).
 */
export default function DownloadsPage() {
    return <DownloadsView />;
}
