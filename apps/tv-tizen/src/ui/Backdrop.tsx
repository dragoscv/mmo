/**
 * Full-bleed backdrop layer under the app (one per app, mounted by App).
 *   const bd = useBackdrop(); bd.show(url | null); bd.clear();
 * Two stacked <img> crossfade (300 ms opacity; instant when motion is reduced). Scrims are partial gradient
 * bands (left 70 % + bottom 55 %) over ONE opaque base — no full-screen translucent stacks (TV GPU fill rate).
 * `will-change: opacity` is applied only while a fade runs.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { preloadOne } from "../lib/image";
import { motionReduced } from "../lib/prefs";

export interface BackdropApi {
    /** Crossfade to `url` (null = hide image, keep base). Debounced so fast D-pad scrolling doesn't thrash. */
    show(url: string | null): void;
    clear(): void;
    /** Current URL (or null). */
    readonly url: string | null;
}

const Ctx = createContext<BackdropApi>({ show: () => undefined, clear: () => undefined, url: null });

export function useBackdrop(): BackdropApi { return useContext(Ctx); }

export const BACKDROP_FADE_MS = 300;
const DEBOUNCE_MS = 120;

interface Layer { url: string | null; on: boolean }

export function BackdropProvider({ children }: { children: ReactNode }) {
    const [layers, setLayers] = useState<[Layer, Layer]>([{ url: null, on: false }, { url: null, on: false }]);
    const [fading, setFading] = useState(false);
    const front = useRef(0);
    const want = useRef<string | null>(null);
    const cur = useRef<string | null>(null);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const fadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const apply = useCallback((url: string | null) => {
        if (url === cur.current) return;
        cur.current = url;
        const next = front.current === 0 ? 1 : 0;
        front.current = next;
        setLayers((ls) => {
            const out: [Layer, Layer] = [{ ...ls[0] }, { ...ls[1] }];
            out[next] = { url, on: url !== null };
            out[next === 0 ? 1 : 0] = { ...out[next === 0 ? 1 : 0], on: false };
            return out;
        });
        if (!motionReduced()) {
            setFading(true);
            if (fadeTimer.current) clearTimeout(fadeTimer.current);
            fadeTimer.current = setTimeout(() => setFading(false), BACKDROP_FADE_MS + 50);
        }
    }, []);

    const show = useCallback((url: string | null) => {
        want.current = url;
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => {
            const u = want.current;
            if (!u) { apply(null); return; }
            // Swap only once decoded → no half-painted frame during the fade.
            void preloadOne(u).then(() => { if (want.current === u) apply(u); });
        }, DEBOUNCE_MS);
    }, [apply]);

    const clear = useCallback(() => show(null), [show]);

    useEffect(() => () => {
        if (timer.current) clearTimeout(timer.current);
        if (fadeTimer.current) clearTimeout(fadeTimer.current);
    }, []);

    const api = useMemo<BackdropApi>(() => ({ show, clear, get url() { return cur.current; } }), [show, clear]);
    const any = layers[0].on || layers[1].on;

    return (
        <Ctx.Provider value={api}>
            <div className={`backdrop${fading ? " is-fading" : ""}${any ? " has-image" : ""}`} aria-hidden="true">
                {layers.map((l, i) => l.url ? (
                    <img key={i} className={`backdrop-img${l.on ? " on" : ""}`} src={l.url} alt="" decoding="async" />
                ) : null)}
                <div className="backdrop-scrim-left" />
                <div className="backdrop-scrim-bottom" />
            </div>
            {children}
        </Ctx.Provider>
    );
}
