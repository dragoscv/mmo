"use client";

/**
 * Host-aware navigation (WP17-10). Pages keep linking to INTERNAL routes (`/media/browse/movie`); on a product
 * host these helpers turn them into clean public URLs (`/browse/movie` on tv.mixai.ro) or absolute URLs on the
 * owning product's host. On legacy hosts (run.app, localhost) every href is unchanged.
 */
import NextLink from "next/link";
import { usePathname as useNextPathname, useRouter as useNextRouter } from "next/navigation";
import { createContext, forwardRef, useCallback, useContext, useMemo, type ComponentProps, type ReactNode } from "react";
import { hrefFor, internalPathname, ROOT_DOMAIN, type HostKind } from "@/lib/host/products";

interface HostCtx { kind: HostKind; root: string }
const Ctx = createContext<HostCtx>({ kind: "legacy", root: ROOT_DOMAIN });

export function HostProvider({ kind, root, children }: { kind: HostKind; root: string; children: ReactNode }) {
    const value = useMemo(() => ({ kind, root }), [kind, root]);
    return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useHost(): HostCtx {
    return useContext(Ctx);
}

/** Maps an internal href for the current host. */
export function useHref(): (internalHref: string) => string {
    const { kind, root } = useHost();
    return useCallback((href: string) => hrefFor(href, kind, root), [kind, root]);
}

type LinkProps = ComponentProps<typeof NextLink>;

/** Drop-in for `next/link`: string hrefs are mapped through `hrefFor`; cross-host links render as plain anchors. */
const Link = forwardRef<HTMLAnchorElement, LinkProps>(function ProductLink({ href, ...rest }, ref) {
    const map = useHref();
    if (typeof href !== "string") return <NextLink ref={ref} href={href} {...rest} />;
    const mapped = map(href);
    if (/^https?:\/\//.test(mapped) && mapped !== href) {
        const { prefetch: _p, replace: _r, scroll: _s, shallow: _sh, passHref: _ph, legacyBehavior: _lb, locale: _l, onNavigate: _n, ...anchor } = rest as LinkProps & Record<string, unknown>;
        return <a ref={ref} href={mapped} {...(anchor as ComponentProps<"a">)} />;
    }
    return <NextLink ref={ref} href={mapped} {...rest} />;
});
export default Link;

/** Drop-in for `useRouter` from `next/navigation`: push/replace/prefetch take internal hrefs. */
export function useRouter() {
    const router = useNextRouter();
    const map = useHref();
    return useMemo(() => {
        const go = (fn: (h: string, o?: { scroll?: boolean }) => void) => (href: string, opts?: { scroll?: boolean }) => {
            const mapped = map(href);
            if (/^https?:\/\//.test(mapped) && mapped !== href) { window.location.assign(mapped); return; }
            if (opts === undefined) fn(mapped); else fn(mapped, opts);
        };
        return {
            ...router,
            push: go(router.push),
            replace: go(router.replace),
            prefetch: (href: string) => { const m = map(href); if (!/^https?:\/\//.test(m)) router.prefetch(m); },
        };
    }, [router, map]);
}

/** Drop-in for `usePathname`: always returns the INTERNAL pathname (`/media/browse/tv`), on any host. */
export function usePathname(): string {
    const p = useNextPathname();
    const { kind } = useHost();
    return internalPathname(p ?? "/", kind);
}
