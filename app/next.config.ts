import type { NextConfig } from "next";

const nextConfig: NextConfig = {
    serverExternalPackages: ["better-sqlite3", "music-metadata"],
    experimental: {
        serverActions: {
            allowedOrigins: [
                "localhost:3000",
                "*.devtunnels.ms",
                "qgst0zss-3000.euw.devtunnels.ms",
            ],
        },
    },
};

export default nextConfig;
