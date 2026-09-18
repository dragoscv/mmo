import { useEffect, useState } from "react";

const ok = new Set<string>();
const bad = new Set<string>();

/**
 * Preloads an image used as a CSS `background-image` (which has no onError) and
 * returns the URL only once it has loaded; `null` while pending or on error
 * (the server answers 503 for sprites until ffmpeg is available).
 */
export function useStill(url: string | null): string | null {
    const [ready, setReady] = useState<string | null>(() => (url && ok.has(url) ? url : null));
    useEffect(() => {
        if (!url || bad.has(url)) { setReady(null); return; }
        if (ok.has(url)) { setReady(url); return; }
        let alive = true;
        const img = new Image();
        img.onload = () => { ok.add(url); if (alive) setReady(url); };
        img.onerror = () => { bad.add(url); if (alive) setReady(null); };
        img.src = url;
        return () => { alive = false; img.onload = null; img.onerror = null; };
    }, [url]);
    return ready;
}
