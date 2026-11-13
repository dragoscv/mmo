"use client";

/**
 * Signed-in `mixai.ro` (WP17-12): product tiles (last used first), a continue-watching strip and "always open X".
 * Choosing a tile morphs it to full screen (FLIP: transform + border-radius only) before navigating to the product
 * host, so the jump to tv./music./app.mixai.ro reads as one motion. Reduced motion navigates at once.
 */
import { useEffect, useRef, useState, useSyncExternalStore, type MouseEvent } from "react";
import { useTranslations } from "next-intl";
import { useReducedMotion } from "motion/react";
import { Server } from "lucide-react";
import { BrandMark, Button, EmptyState, Skeleton, Switch } from "@mmo/ui";
import { useThemePrefs } from "@mmo/ui/theme";
import Link, { useHref } from "@/components/host/host-context";
import { getLauncherContinue } from "@/actions/media";
import { tmdbImg } from "@/lib/media/normalize";
import type { TitleCard } from "@/lib/media/types";
import { orderByLastUsed, SUITE_PRODUCTS, type SuiteProduct, type SuiteProductKey } from "./products";

const RECENT_KEY = "mixai:suite:recent";
const DEFAULT_KEY = "mixai:suite:default";
const KEYS = new Set<SuiteProductKey>(SUITE_PRODUCTS.map((p) => p.key));

function readRecent(): SuiteProductKey[] {
    try {
        const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as unknown;
        return Array.isArray(v) ? v.filter((k): k is SuiteProductKey => KEYS.has(k as SuiteProductKey)).slice(0, 5) : [];
    } catch { return []; }
}
function pushRecent(k: SuiteProductKey) {
    try { localStorage.setItem(RECENT_KEY, JSON.stringify([k, ...readRecent().filter((x) => x !== k)].slice(0, 5))); } catch { /* private mode */ }
}
function readDefault(): SuiteProductKey | null {
    try { const v = localStorage.getItem(DEFAULT_KEY) as SuiteProductKey | null; return v && KEYS.has(v) ? v : null; } catch { return null; }
}

/** Tiny store over localStorage so render reads prefs without setState-in-effect (and SSR sees none). */
const listeners = new Set<() => void>();
let snap: { recent: SuiteProductKey[]; def: SuiteProductKey | null } | null = null;
const EMPTY = { recent: [] as SuiteProductKey[], def: null as SuiteProductKey | null };
function prefsSnapshot() {
    if (!snap) snap = { recent: readRecent(), def: readDefault() };
    return snap;
}
function prefsChanged() { snap = null; listeners.forEach((l) => l()); }
function subscribePrefs(l: () => void) {
    listeners.add(l);
    const onStorage = (e: StorageEvent) => { if (e.key === RECENT_KEY || e.key === DEFAULT_KEY) prefsChanged(); };
    window.addEventListener("storage", onStorage);
    return () => { listeners.delete(l); window.removeEventListener("storage", onStorage); };
}

type ContinueState = { state: "loading" | "ok" | "empty" | "error" | "noServer"; items: TitleCard[] };

export function SuiteLauncher({ name }: { name: string | null }) {
    const t = useTranslations("mx.suite");
    const map = useHref();
    const reduced = useReducedMotion();
    const { prefs } = useThemePrefs();
    const animate = !reduced && prefs.motion === "full";
    const { recent, def } = useSyncExternalStore(subscribePrefs, prefsSnapshot, () => EMPTY);
    const [forwarding, setForwarding] = useState<SuiteProduct | null>(null);
    const [cont, setCont] = useState<ContinueState>({ state: "loading", items: [] });
    const [morph, setMorph] = useState<{ p: SuiteProduct; rect: DOMRect } | null>(null);
    const morphRef = useRef<HTMLDivElement>(null);
    const fwdTimer = useRef<number | null>(null);
    const order = orderByLastUsed(recent);
    const lastUsed = recent[0] ?? null;

    useEffect(() => {
        let alive = true;
        void getLauncherContinue()
            .catch(() => ({ state: "error" as const, items: [] as TitleCard[] }))
            .then((r) => { if (alive) setCont(r); });
        return () => { alive = false; };
    }, []);

    useEffect(() => {
        // "Always open X": forward after a short, cancellable beat (no surprise redirect loop).
        const d = readDefault();
        if (!d) return;
        const p = SUITE_PRODUCTS.find((x) => x.key === d)!;
        const show = window.setTimeout(() => setForwarding(p), 0);
        fwdTimer.current = window.setTimeout(() => window.location.assign(map(p.internal)), 1600);
        return () => { window.clearTimeout(show); if (fwdTimer.current) window.clearTimeout(fwdTimer.current); };
    }, [map]);

    const open = (p: SuiteProduct, el: HTMLElement | null) => {
        pushRecent(p.key);
        prefsChanged();
        const href = map(p.internal);
        if (!animate || !el) { window.location.assign(href); return; }
        setMorph({ p, rect: el.getBoundingClientRect() });
        // Let the overlay paint at the tile's rect, then expand; navigate when the expansion is mostly done.
        requestAnimationFrame(() => requestAnimationFrame(() => {
            const m = morphRef.current;
            if (m) {
                m.style.transition = "inset 420ms cubic-bezier(.16,1,.3,1), border-radius 420ms cubic-bezier(.16,1,.3,1)";
                m.style.inset = "0px";
                m.style.borderRadius = "0px";
            }
            window.setTimeout(() => window.location.assign(href), 380);
        }));
    };

    const onTile = (p: SuiteProduct) => (e: MouseEvent<HTMLAnchorElement>) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) { pushRecent(p.key); return; }
        e.preventDefault();
        open(p, e.currentTarget);
    };

    const setRemember = (k: SuiteProductKey, on: boolean) => {
        try { if (on) localStorage.setItem(DEFAULT_KEY, k); else localStorage.removeItem(DEFAULT_KEY); } catch { /* ignore */ }
        prefsChanged();
    };
    const rememberTarget = def ? SUITE_PRODUCTS.find((p) => p.key === def)! : (SUITE_PRODUCTS.find((p) => p.key === lastUsed) ?? SUITE_PRODUCTS[0]!);

    return (
        <section className="sx-wrap lx" aria-labelledby="lx-title">
            <div className="lx-head sx-rise">
                <h1 id="lx-title">{name ? t("launcher.greeting", { name }) : t("launcher.greetingAnon")}</h1>
                <p>{t("launcher.subtitle")}</p>
            </div>

            <nav aria-label={t("launcher.appsLabel")}>
                <ul className="lx-grid">
                    {order.map((p, i) => {
                        return (
                            <li key={p.key} className="sx-rise" style={{ ["--i" as string]: i + 1 }}>
                                <a href={map(p.internal)} onClick={onTile(p)} className="lx-tile" style={{ ["--c" as string]: p.accent }}>
                                    {p.key === lastUsed ? <span className="lx-badge">{t("launcher.lastUsed")}</span> : null}
                                    <span className="sx-card-icon"><BrandMark product={p.brand} size={24} decorative /></span>
                                    <strong>{t(`products.${p.key}.name`)}</strong>
                                    <span className="lx-sub">{t(`products.${p.key}.tagline`)}</span>
                                </a>
                            </li>
                        );
                    })}
                </ul>
            </nav>

            <label className="lx-remember">
                <Switch checked={def !== null} onCheckedChange={(on) => setRemember(rememberTarget.key, on)} />
                <span>{def ? t("launcher.remember", { name: t(`products.${def}.name`) }) : t("launcher.remember", { name: t(`products.${rememberTarget.key}.name`) })}</span>
            </label>

            <ContinueStrip state={cont} />

            {forwarding ? (
                <div className="lx-forward" role="status">
                    <div className="lx-forward-in">
                        <span>{t("launcher.forwarding", { name: t(`products.${forwarding.key}.name`) })}</span>
                        <Button size="sm" variant="ghost" onClick={() => { if (fwdTimer.current) window.clearTimeout(fwdTimer.current); setForwarding(null); }}>
                            {t("launcher.cancel")}
                        </Button>
                    </div>
                </div>
            ) : null}

            {morph ? (
                <div
                    ref={morphRef}
                    className="lx-morph"
                    aria-hidden
                    style={{
                        ["--c" as string]: morph.p.accent,
                        inset: `${morph.rect.top}px ${window.innerWidth - morph.rect.right}px ${window.innerHeight - morph.rect.bottom}px ${morph.rect.left}px`,
                    }}
                >
                    <div className="lx-morph-label">
                        <span className="sx-card-icon" style={{ ["--c" as string]: morph.p.accent }}><BrandMark product={morph.p.brand} size={24} decorative /></span>
                        {t(`products.${morph.p.key}.name`)}
                    </div>
                </div>
            ) : null}
        </section>
    );
}

function ContinueStrip({ state }: { state: ContinueState }) {
    const t = useTranslations("mx.suite");
    return (
        <section className="lx-continue" aria-labelledby="lx-continue" aria-busy={state.state === "loading" || undefined}>
            <h2 id="lx-continue">{t("launcher.continue")}</h2>
            {state.state === "loading" ? (
                <div className="lx-strip">
                    {Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="aspect-video w-full rounded-xl" />)}
                </div>
            ) : state.state === "noServer" ? (
                <EmptyState
                    icon={<Server aria-hidden />}
                    title={t("launcher.noServerTitle")}
                    description={t("launcher.noServerBody")}
                    actions={<Button render={<Link href="/get#companion" />}>{t("launcher.noServerCta")}</Button>}
                />
            ) : state.state === "error" ? (
                <p className="text-muted-foreground" role="status">{t("launcher.continueError")}</p>
            ) : state.state === "empty" ? (
                <p className="text-muted-foreground">{t("launcher.continueEmpty")}</p>
            ) : (
                <ul className="lx-strip">
                    {state.items.map((it) => {
                        const img = tmdbImg(it.backdrop ?? it.poster, "w780");
                        return (
                            <li key={`${it.kind}:${it.tmdbId}`}>
                                <Link href={`/media/${it.kind}/${it.tmdbId}`} className="lx-still">
                                    {/* eslint-disable-next-line @next/next/no-img-element */}
                                    {img ? <img src={img} alt="" loading="lazy" decoding="async" /> : null}
                                    <span className="lx-still-title">{it.title}</span>
                                    {it.progress ? <span className="lx-progress" aria-hidden><i style={{ width: `${Math.round(it.progress * 100)}%` }} /></span> : null}
                                </Link>
                            </li>
                        );
                    })}
                </ul>
            )}
        </section>
    );
}
