/**
 * Overview waveform of a library track for the preview column: one SVG path built once per
 * track from the cached overview bins (`loadTrackPreview`). Nothing is drawn per frame, and
 * only rows that are on screen mount this component, so only visible tracks are fetched.
 */
import { memo, useEffect, useState } from "react";
import { PREVIEW_BINS, loadTrackPreview } from "@/state/wave-store";
import { previewPath } from "./track-view.ts";

const VIEW_H = 32;
const PATH_CACHE_MAX = 600;
/**
 * A row asks for its overview only after it stayed on screen this long: wheel-scrolling past
 * hundreds of rows must not fire one request per row passed.
 */
const PREVIEW_DELAY_MS = 150;
const paths = new Map<number, string>();

function remember(trackId: number, path: string): void {
    paths.set(trackId, path);
    if (paths.size > PATH_CACHE_MAX) {
        const oldest = paths.keys().next().value;
        if (oldest !== undefined) paths.delete(oldest);
    }
}

export const PreviewWave = memo(function PreviewWave({ trackId, emptyLabel }: { trackId: number; emptyLabel: string }) {
    // undefined = still loading, null = the track has no peaks yet.
    const [path, setPath] = useState<string | null | undefined>(() => paths.get(trackId));

    useEffect(() => {
        const hit = paths.get(trackId);
        if (hit !== undefined) {
            setPath(hit);
            return;
        }
        let live = true;
        const timer = setTimeout(() => {
            void loadTrackPreview(trackId).then(
                (bins) => {
                    const next = (bins && previewPath(bins, VIEW_H)) || null;
                    if (next) remember(trackId, next);
                    if (live) setPath(next);
                },
                () => {
                    if (live) setPath(null);
                },
            );
        }, PREVIEW_DELAY_MS);
        return () => {
            live = false;
            clearTimeout(timer);
        };
    }, [trackId]);

    if (path) {
        return (
            <svg className="lib-preview" viewBox={`0 0 ${PREVIEW_BINS} ${VIEW_H}`} preserveAspectRatio="none" aria-hidden focusable="false">
                <path d={path} fill="currentColor" />
            </svg>
        );
    }
    if (path === null) return <span className="lib-preview-none" role="img" aria-label={emptyLabel} title={emptyLabel} />;
    return <span aria-hidden />;
});
