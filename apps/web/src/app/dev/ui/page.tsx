import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { UiCatalog } from "./ui-catalog";

export const metadata: Metadata = { title: "UI catalog · MixAI dev", robots: { index: false, follow: false } };

/**
 * WP9-01 — dev-only `@mmo/ui` catalog for cheap visual regression.
 * 404 in production unless `MIXAI_DEV_UI=1` is set on the server.
 */
export default function DevUiPage() {
    if (process.env.NODE_ENV === "production" && process.env.MIXAI_DEV_UI !== "1") notFound();
    return <UiCatalog />;
}
