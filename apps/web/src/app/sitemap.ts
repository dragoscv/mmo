import type { MetadataRoute } from "next";
import { productOrigin } from "@/lib/host/products";
import { rootDomain } from "@/lib/host/server";

/** `/sitemap.xml` (WP17-10): the public suite pages plus each product's entry point. */
export default function sitemap(): MetadataRoute.Sitemap {
    const root = rootDomain();
    const apex = productOrigin("suite", root);
    const now = new Date();
    return [
        { url: `${apex}/`, lastModified: now, changeFrequency: "weekly", priority: 1 },
        { url: `${apex}/get`, lastModified: now, changeFrequency: "monthly", priority: 0.8 },
        { url: `${apex}/privacy`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
        { url: `${apex}/status`, lastModified: now, changeFrequency: "daily", priority: 0.3 },
        { url: `${productOrigin("dj", root)}/`, lastModified: now, changeFrequency: "monthly", priority: 0.7 },
        { url: `${productOrigin("tv", root)}/`, lastModified: now, changeFrequency: "monthly", priority: 0.6 },
        { url: `${productOrigin("music", root)}/`, lastModified: now, changeFrequency: "monthly", priority: 0.6 },
        { url: `${productOrigin("studio", root)}/`, lastModified: now, changeFrequency: "monthly", priority: 0.5 },
    ];
}
