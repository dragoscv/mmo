import type { NextConfig } from "next";

const nextConfig: NextConfig = {
    serverExternalPackages: ["postgres", "music-metadata"],

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
                ],
            },
        ];
    },
};

export default nextConfig;
