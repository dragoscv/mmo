"use client";

import { useEffect, useRef } from "react";

/**
 * Lazy ASS/SSA subtitle renderer using JASSUB.
 *
 * JASSUB is a libass WebAssembly port that renders into a `<canvas>`
 * overlaid on top of the `<video>` element. Required only when the
 * subtitle source is ASS/SSA — for WebVTT and SRT, use the native
 * `<track>` element instead (cheaper and fully GPU-accelerated).
 *
 * Worker + WASM are loaded dynamically. Bundle stays clean for users
 * who never trigger ASS subs.
 *
 * Note: place `jassub-worker.js` and `jassub-worker.wasm` in
 * `app/public/jassub/` (copy from `node_modules/jassub/dist/`) for
 * the worker to be reachable at runtime.
 */
export function AssSubtitleRenderer({ videoRef, assUrl, fonts }: {
    videoRef: React.RefObject<HTMLVideoElement | null>;
    assUrl: string | null;
    fonts?: string[];
}) {
    const instanceRef = useRef<unknown>(null);

    useEffect(() => {
        if (!assUrl) return;
        const v = videoRef.current;
        if (!v) return;
        let cancelled = false;

        (async () => {
            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-expect-error — JASSUB has no first-party TS types.
            const { default: JASSUB } = await import("jassub").catch(() => ({ default: null }));
            if (cancelled || !JASSUB) return;
            instanceRef.current = new JASSUB({
                video: v,
                subUrl: assUrl,
                workerUrl: "/jassub/jassub-worker.js",
                wasmUrl: "/jassub/jassub-worker.wasm",
                fonts: fonts ?? [],
                fallbackFont: "Arial",
                availableFonts: { arial: "/jassub/fonts/Arial.ttf" },
                offscreenRender: true,
            });
        })();

        return () => {
            cancelled = true;
            const inst = instanceRef.current as { destroy?: () => void } | null;
            inst?.destroy?.();
            instanceRef.current = null;
        };
    }, [assUrl, videoRef, fonts]);

    return null;
}
