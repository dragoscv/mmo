/**
 * MixAI product hosts (ADR-0013, WP17-10). Pure: shared by `proxy.ts` (edge), server components and the
 * client link helpers, so every decision about "which host serves this path" lives in one place.
 *
 *   mixai.ro / www   → suite landing + launcher (`/`), plus the public pages (privacy, get, status, login…)
 *   tv.mixai.ro      → MixAI TV: clean URLs, `/browse/movie` is served by the `/media/browse/movie` route
 *   music.mixai.ro   → MixAI Music: `/` = `/media/music`, `/album/x` = `/media/music/album/x`
 *   app.mixai.ro     → MixAI Studio (organizer: library, AI, DJ live, settings, admin)
 *   dj.mixai.ro      → MixAI DJ landing (`/dj`)
 *
 * Any other host (run.app, localhost, LAN, preview) is "legacy": every path works exactly as before, no
 * rewrites and no redirects, so the store builds that point at run.app keep working (D41).
 */

export type Product = "suite" | "tv" | "music" | "studio" | "dj";
export type HostKind = Product | "legacy";

export const ROOT_DOMAIN = "mixai.ro";

/**
 * Host routing is switched on per deploy with `MIXAI_HOST_ROUTING=1`, only once tv./music./app./dj. resolve and
 * have certificates; until then every host behaves as legacy (no redirects to hosts that do not exist yet).
 * Server-side only (proxy, RSC, Auth.js); the client receives the resolved kind via HostProvider.
 */
export function hostRoutingEnabled(): boolean {
    return typeof process !== "undefined" && process.env.MIXAI_HOST_ROUTING === "1";
}

const SUB: Record<string, Product> = { tv: "tv", music: "music", app: "studio", dj: "dj", www: "suite" };
const PRODUCT_SUB: Record<Product, string | null> = { suite: null, tv: "tv", music: "music", studio: "app", dj: "dj" };

/** Strips the port and lowercases (`Tv.MixAI.ro:443` → `tv.mixai.ro`). */
export function normalizeHost(host: string | null | undefined): string {
    return (host ?? "").trim().toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
}

/**
 * Which product a host serves. `rootDomain` is injectable for tests and for a staging root
 * (`MIXAI_ROOT_DOMAIN`, e.g. `staging.mixai.ro`).
 */
export function hostKind(host: string | null | undefined, rootDomain = ROOT_DOMAIN): HostKind {
    const h = normalizeHost(host);
    if (!h) return "legacy";
    if (h === rootDomain) return "suite";
    if (!h.endsWith(`.${rootDomain}`)) return "legacy";
    const sub = h.slice(0, -(rootDomain.length + 1));
    return SUB[sub] ?? "legacy";
}

/** True for the apex and every `*.mixai.ro` host (cookie domain + redirect allow-list). */
export function isProductDomain(host: string | null | undefined, rootDomain = ROOT_DOMAIN): boolean {
    const h = normalizeHost(host);
    return h === rootDomain || h.endsWith(`.${rootDomain}`);
}

export function productOrigin(product: Product, rootDomain = ROOT_DOMAIN): string {
    const sub = PRODUCT_SUB[product];
    return `https://${sub ? `${sub}.` : ""}${rootDomain}`;
}

// ─── Path ownership ──────────────────────────────────────────────────────────────────────────────

/** Routes that render on EVERY product host (auth, legal, offline shell, assets, APIs). */
const SHARED_PREFIXES = [
    "/api", "/login", "/privacy", "/offline", "/activate", "/pair", "/account", "/status", "/get",
    "/_next", "/.well-known", "/fonts", "/__offline", "/together",
];
/** Files at the root of `public/` and framework metadata. */
const SHARED_FILE = /^\/[^/]+\.(?:js|css|png|jpg|jpeg|svg|ico|webmanifest|json|txt|xml|woff2?|map|wasm|html)$/i;

/** Studio-only (organizer) top-level segments. Everything that is not TV, Music, suite or shared. */
const STUDIO_PREFIXES = [
    "/dashboard", "/library", "/playlists", "/analysis", "/drives", "/scanner", "/devices", "/remote", "/settings",
    "/profile", "/profiles", "/generate", "/training", "/lora", "/maestro", "/voice-wizard", "/visualizations", "/live",
    "/dev", "/download", "/learn", "/watch", "/mixer", "/daw", "/editor", "/plugins", "/recordings", "/music",
];

function under(path: string, prefix: string): boolean {
    return path === prefix || path.startsWith(`${prefix}/`);
}

export function isSharedPath(path: string): boolean {
    return SHARED_FILE.test(path) || SHARED_PREFIXES.some((p) => under(path, p)) || path === "/sw.js";
}

/**
 * The product that owns an INTERNAL route path (the Next route tree, i.e. `/media/...`).
 * `null` = shared (renders on any host).
 */
export function ownerOf(internalPath: string): Product | null {
    if (isSharedPath(internalPath)) return null;
    if (under(internalPath, "/media/music")) return "music";
    if (under(internalPath, "/media")) return "tv";
    if (under(internalPath, "/dj")) return "dj";
    if (internalPath === "/" || internalPath === "") return "suite";
    if (STUDIO_PREFIXES.some((p) => under(internalPath, p))) return "studio";
    return "studio";
}

// ─── Public ↔ internal path mapping ──────────────────────────────────────────────────────────────

/** Internal route prefix that a product host mounts at its `/`. */
const MOUNT: Partial<Record<Product, string>> = { tv: "/media", music: "/media/music", dj: "/dj" };
/** First path segments that exist under each mount (the Next route tree). Anything else is foreign. */
const MOUNT_SEGMENTS: Partial<Record<Product, ReadonlySet<string>>> = {
    tv: new Set(["movie", "tv", "browse", "collections", "downloads", "list", "live", "play", "search", "stats"]),
    music: new Set(["album", "artist", "genre", "now-playing", "playlist", "search"]),
    dj: new Set<string>(),
};

function firstSegment(path: string): string {
    return path.split("/")[1] ?? "";
}

/**
 * Public path on `product`'s host → internal route path (what `proxy.ts` rewrites to).
 * Returns `null` for shared paths, paths already under the mount and segments the mount does not have.
 */
export function toInternal(product: Product, publicPath: string): string | null {
    const mount = MOUNT[product];
    if (!mount || isSharedPath(publicPath)) return null;
    if (under(publicPath, mount)) return null;
    if (publicPath === "/" || publicPath === "") return mount;
    if (!MOUNT_SEGMENTS[product]?.has(firstSegment(publicPath))) return null;
    return `${mount}${publicPath}`;
}

/** Internal route path → public path on its owner's host (inverse of `toInternal`). */
export function toPublic(product: Product, internalPath: string): string {
    const mount = MOUNT[product];
    if (!mount || !under(internalPath, mount)) return internalPath;
    const rest = internalPath.slice(mount.length);
    return rest === "" ? "/" : rest;
}

/**
 * Href for a link to an internal route, as seen from a page served on `current`:
 *  - legacy hosts → the internal path unchanged (run.app keeps `/media/...`);
 *  - same product → clean public path;
 *  - other product → absolute URL on that product's host.
 */
export function hrefFor(internalHref: string, current: HostKind, rootDomain = ROOT_DOMAIN): string {
    if (current === "legacy" || !internalHref.startsWith("/") || internalHref.startsWith("//")) return internalHref;
    const [pathAndQuery, hash = ""] = internalHref.split("#", 2) as [string, string?];
    const qi = pathAndQuery.indexOf("?");
    const path = qi < 0 ? pathAndQuery : pathAndQuery.slice(0, qi);
    const query = qi < 0 ? "" : pathAndQuery.slice(qi);
    const tail = `${query}${hash ? `#${hash}` : ""}`;
    const owner = ownerOf(path);
    if (owner === null) return internalHref;
    const pub = toPublic(owner, path);
    if (owner === current) return `${pub}${tail}`;
    return `${productOrigin(owner, rootDomain)}${pub}${tail}`;
}

/** Reverse of `hrefFor` for the current host: public pathname → internal pathname (for `usePathname`). */
export function internalPathname(publicPath: string, current: HostKind): string {
    if (current === "studio" && publicPath === "/") return STUDIO_HOME;
    if (current === "legacy" || current === "suite" || current === "studio") return publicPath;
    return toInternal(current, publicPath) ?? publicPath;
}

/** What `app.mixai.ro/` renders (the launcher lives on the apex). */
export const STUDIO_HOME = "/dashboard";

// ─── Request routing (proxy.ts) ──────────────────────────────────────────────────────────────────

export type RouteDecision =
    | { type: "next" }
    | { type: "rewrite"; path: string }
    | { type: "redirect"; url: string; status: 308 };

/**
 * Decides what `proxy.ts` does for one request. `search` is the raw `?a=b` (kept on redirects).
 *  - legacy host or shared path → next (unchanged behaviour);
 *  - an internal path on any product host (`mixai.ro/media/x`, `tv.mixai.ro/media/x`) → 308 to the owner's
 *    clean URL (`tv.mixai.ro/x`);
 *  - a clean path of this host's mount → rewrite to the internal route;
 *  - `tv.mixai.ro/music/...` → 308 to `music.mixai.ro/...` (Music is its own product, D47);
 *  - any other path owned by another product → 308 to that host; unknown paths → next (404 here).
 */
export function routeRequest(host: string | null | undefined, pathname: string, search = "", rootDomain = ROOT_DOMAIN): RouteDecision {
    const kind = hostKind(host, rootDomain);
    if (kind === "legacy" || isSharedPath(pathname)) return { type: "next" };
    const go = (owner: Product, internal: string): RouteDecision =>
        ({ type: "redirect", url: `${productOrigin(owner, rootDomain)}${toPublic(owner, internal)}${search}`, status: 308 });

    // Internal mount paths are never public on product hosts: canonicalise to the clean URL.
    if (under(pathname, "/media") || under(pathname, "/dj")) {
        const owner = ownerOf(pathname);
        if (owner) return go(owner, pathname);
    }

    if (kind === "studio" && pathname === "/") return { type: "rewrite", path: STUDIO_HOME };

    const internal = toInternal(kind, pathname);
    if (internal) return { type: "rewrite", path: internal };

    if (kind === "tv" && under(pathname, "/music")) return go("music", `/media${pathname}`);

    const mounted = MOUNT[kind] !== undefined;
    const owner = ownerOf(pathname);
    if (owner && owner !== kind) {
        // `/` on a mounted host was rewritten above; foreign suite paths do not exist there.
        if (owner === "suite" && mounted) return { type: "next" };
        return go(owner, pathname);
    }
    return { type: "next" };
}
