// @ts-check
/**
 * Serwist "configurator mode" (WP9-05) — the bundler-agnostic integration
 * that works with Turbopack (the webpack `withSerwist` wrapper does not hook
 * into `next build`, which is Turbopack here). `next build && serwist build`
 * bundles `src/app/sw.ts` → `public/sw.js` after prerendering.
 *
 * https://serwist.pages.dev/docs/next/config
 */
import { spawnSync } from "node:child_process";
import { serwist } from "@serwist/next/config";

// Versions the precached /offline page so a redeploy invalidates it.
const revision =
    spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf-8" }).stdout?.trim() || crypto.randomUUID();

export default serwist({
    swSrc: "src/app/sw.ts",
    swDest: "public/sw.js",
    // Never precache prerendered HTML — pages behind auth are per-user and the
    // cache is shared across sign-ins on one browser (PII). The only document
    // in the cache is the static /offline fallback below.
    precachePrerendered: false,
    // Only the truly public shell assets (old SW: `/offline` + manifest).
    // `public/**` is deliberately NOT globbed: it holds MBs of audio samples.
    globPatterns: ["public/manifest.webmanifest", "public/icon-192.png", "public/icon-512.png"],
    additionalPrecacheEntries: [{ url: "/offline", revision }],
});
