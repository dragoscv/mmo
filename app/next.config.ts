import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";
import bundleAnalyzer from "@next/bundle-analyzer";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");
const withBundleAnalyzer = bundleAnalyzer({
    enabled: process.env.ANALYZE === "true",
    openAnalyzer: false,
});

const nextConfig: NextConfig = {
    serverExternalPackages: ["postgres", "music-metadata", "systeminformation"],

    // Keep large local-only assets out of every serverless function bundle.
    // The recordings/import actions use dynamic path.join() which causes
    // Next's tracer to pull in the entire project (data/, public/samples/,
    // .db files) — pushing function size past Vercel's 300MB limit.
    outputFileTracingExcludes: {
        "*": [
            "data/**",
            "public/samples/**",
            "public/worklets/**",
            "drizzle/**",
            "scripts/**",
            "**/*.db",
            "**/*.db-journal",
            "**/*.wav",
            "**/*.mp3",
            "**/*.flac",
            "**/*.ogg",
            "**/*.m4a",
            "**/*.aac",
            "**/*.aiff",
            "**/*.webm",
        ],
    },

    // React Compiler (stable in Next.js 16) — automatic memoization for the
    // entire app. Eliminates most need for manual useMemo/useCallback and
    // removes wasted re-renders. Free perf win.
    reactCompiler: true,

    // Strip non-critical console.* in production builds. Keeps error/warn so
    // real problems still surface. The MIDI/analysis/mixer engines are noisy
    // in dev for diagnostics.
    compiler: {
        removeConsole: {
            exclude: ["error", "warn"],
        },
    },

    experimental: {
        serverActions: {
            allowedOrigins: [
                "localhost:3000",
                "*.devtunnels.ms",
                "qgst0zss-3000.euw.devtunnels.ms",
            ],
        },
        // NOTE: `turbopackFileSystemCacheForDev` was enabled here for faster
        // cold restarts but caused `ChunkLoadError` / `chunk.reason.enqueueModel
        // is not a function` during client navigation in Next.js 16.2.x — the
        // persisted manifest references chunk hashes that no longer exist on
        // disk after edits. Disabled until upstream stabilises it.
        // turbopackFileSystemCacheForDev: true,
    },

    // Cross-origin / security headers applied globally. Auth.js, Server
    // Actions and the WebRTC remote bridge all benefit from a tight default.
    async headers() {
        // Allowlist for the strict CSP. Keep tight and additive — anything
        // we forget surfaces as a console violation in dev so we can extend
        // it before shipping. `'unsafe-inline'` for styles is required by
        // Next.js' inline critical-CSS extraction; we accept it because the
        // dynamic-style attack surface in this app is tiny (no untrusted
        // content rendered into a `style` attribute).
        const csp = [
            "default-src 'self'",
            // Next.js needs `'unsafe-eval'` for the dev runtime (HMR + RSC
            // bootstrap chunks). React Compiler builds also emit `eval` for
            // the inline component cache. Stripe Checkout/Connect needs its
            // own origins. Service worker (`/sw.js`) is same-origin.
            "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://js.stripe.com https://accounts.google.com",
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
            "font-src 'self' data: https://fonts.gstatic.com",
            // Artwork / oEmbed thumbnails come from many CDNs; HTTPS-only.
            "img-src 'self' data: blob: https:",
            "media-src 'self' blob: https:",
            // SSE relay, devices, sync, Auth.js callbacks, Stripe webhooks.
            "connect-src 'self' http://localhost:* https: wss: ws:",
            // Stripe Elements + Auth.js Google one-tap iframes.
            "frame-src 'self' https://js.stripe.com https://accounts.google.com https://hooks.stripe.com",
            "frame-ancestors 'self'",
            "object-src 'none'",
            "base-uri 'self'",
            "form-action 'self' https://accounts.google.com",
            // Service worker scope.
            "worker-src 'self' blob:",
            "manifest-src 'self'",
        ].join("; ");

        return [
            {
                source: "/:path*",
                headers: [
                    { key: "X-Content-Type-Options", value: "nosniff" },
                    { key: "X-Frame-Options", value: "SAMEORIGIN" },
                    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
                    { key: "X-DNS-Prefetch-Control", value: "on" },
                    {
                        key: "Permissions-Policy",
                        // Allow features the app actually uses (mic for live/voice,
                        // midi for DDJ/Circuit), deny the rest by default.
                        value: "microphone=(self), midi=(self), camera=(), geolocation=(), interest-cohort=()",
                    },
                    {
                        key: "Strict-Transport-Security",
                        // `preload` requires submission to the HSTS preload
                        // list (https://hstspreload.org). Safe to ship the
                        // directive once the domain is live and known to be
                        // HTTPS-only — browsers ignore it on hostnames not
                        // on the list.
                        value: "max-age=63072000; includeSubDomains; preload",
                    },
                    // Cross-Origin-Opener-Policy isolates the top-level
                    // window so cross-origin popups (Stripe checkout,
                    // Google OAuth) can't read window.opener references and
                    // probe internal state. `same-origin-allow-popups`
                    // keeps OAuth + Stripe popups working while still
                    // breaking the Spectre-class window-reference leaks.
                    { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
                    // Cross-Origin-Resource-Policy: refuse loading our
                    // own static assets into other origins. Defence in
                    // depth against XS-Leaks (size-based oracle attacks
                    // on logged-in artwork / per-user JSON).
                    { key: "Cross-Origin-Resource-Policy", value: "same-site" },
                    { key: "Content-Security-Policy", value: csp },
                ],
            },
        ];
    },
};

export default withBundleAnalyzer(withNextIntl(nextConfig));
