"use client";

/**
 * Full-bleed backdrop that follows hover/focus (D25). Two stacked <img> layers cross-fade
 * (opacity only → compositor). Screens call `useBackdrop().set(path)` from card focus/hover.
 * The layer is `position:absolute` in the isolated `.mx-shell` with a sticky viewport-tall stage: a
 * `fixed; z-index:-1` layer painted under AppShell's opaque background and was never visible.
 * The hero's muted trailer (`trailer(key)`) plays in the same stage, above the stills.
 */
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { tmdbImg } from "@/lib/media/normalize";

interface BackdropApi { set(path: string | null | undefined): void; trailer(key: string | null): void }
const Ctx = createContext<BackdropApi>({ set: () => undefined, trailer: () => undefined });

export function BackdropProvider({ children }: { children: ReactNode }) {
    const [layers, setLayers] = useState<[string | null, string | null]>([null, null]);
    const [front, setFront] = useState<0 | 1>(0);
    const [trailerKey, setTrailerKey] = useState<string | null>(null);
    const cur = useRef<string | null>(null);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const set = useCallback((path: string | null | undefined) => {
        const url = tmdbImg(path ?? null, "w1280");
        if (!url || url === cur.current) return;
        if (timer.current) clearTimeout(timer.current);
        // Debounce fast arrow-key scans: only settle on what the user rests on.
        timer.current = setTimeout(() => {
            cur.current = url;
            const img = new Image();
            img.decoding = "async";
            img.src = url;
            const swap = () => {
                setFront((f) => {
                    const next = f === 0 ? 1 : 0;
                    setLayers((l) => (next === 0 ? [url, l[1]] : [l[0], url]));
                    return next;
                });
            };
            if (img.decode) img.decode().then(swap, swap); else img.onload = swap;
        }, 140);
    }, []);

    const api = useMemo(() => ({ set, trailer: setTrailerKey }), [set]);
    return (
        <Ctx.Provider value={api}>
            <div className="mx-backdrop" aria-hidden>
                <div className="mx-backdrop-stage">
                    {layers.map((src, i) => (src
                        // eslint-disable-next-line @next/next/no-img-element -- decorative, already decoded off-thread
                        ? <img key={i} src={src} alt="" className="mx-backdrop-img" data-on={front === i || undefined} />
                        : null))}
                    {trailerKey ? (
                        <iframe
                            title="trailer"
                            className="mx-hero-trailer"
                            data-on
                            tabIndex={-1}
                            allow="autoplay; encrypted-media"
                            src={`https://www.youtube-nocookie.com/embed/${trailerKey}?autoplay=1&mute=1&controls=0&loop=1&playlist=${trailerKey}&modestbranding=1&playsinline=1&rel=0`}
                        />
                    ) : null}
                </div>
            </div>
            {children}
        </Ctx.Provider>
    );
}

export function useBackdrop(): BackdropApi { return useContext(Ctx); }
