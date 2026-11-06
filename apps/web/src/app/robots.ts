import type { MetadataRoute } from "next";
import { productOrigin } from "@/lib/host/products";
import { currentHostKind, rootDomain } from "@/lib/host/server";

/**
 * `/robots.txt` per host (WP17-10). Public marketing pages are indexable on the apex; the signed-in apps
 * (tv./music./app.) only expose their entry point; legacy hosts (run.app) are not indexed at all.
 */
export default async function robots(): Promise<MetadataRoute.Robots> {
    const kind = await currentHostKind();
    if (kind === "legacy") return { rules: [{ userAgent: "*", disallow: "/" }] };
    const origin = productOrigin(kind, rootDomain());
    if (kind === "suite" || kind === "dj") {
        return { rules: [{ userAgent: "*", allow: "/", disallow: ["/api/", "/login", "/activate", "/pair"] }], sitemap: `${origin}/sitemap.xml`, host: origin };
    }
    return { rules: [{ userAgent: "*", allow: ["/$", "/privacy"], disallow: "/" }], host: origin };
}
