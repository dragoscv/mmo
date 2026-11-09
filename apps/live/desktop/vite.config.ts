import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

// Same shape as apps/mixai (Tauri expects a fixed dev port; the Rust side serves `dist/` in production).
const host = process.env.TAURI_DEV_HOST;
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
    plugins: [react(), tailwindcss()],
    clearScreen: false,
    base: "./",
    resolve: {
        alias: [
            { find: "@", replacement: here("./src") },
            // Shared design system, consumed from source (repo convention).
            { find: "@mmo/design-tokens", replacement: here("../../../packages/design-tokens/src/index.ts") },
            // Must come before the `@mmo/ui` directory alias.
            { find: "@mmo/ui/styles.css", replacement: here("../../../packages/ui/src/styles.css") },
            { find: "@mmo/ui", replacement: here("../../../packages/ui/src") },
            // packages/ui has its own node_modules/react: pin every import to this app's copy, otherwise hooks
            // throw "Cannot read properties of null (reading 'useState')".
            { find: /^react$/, replacement: here("./node_modules/react/index.js") },
            { find: /^react\/jsx-runtime$/, replacement: here("./node_modules/react/jsx-runtime.js") },
            { find: /^react\/jsx-dev-runtime$/, replacement: here("./node_modules/react/jsx-dev-runtime.js") },
            { find: /^react-dom$/, replacement: here("./node_modules/react-dom/index.js") },
            { find: /^react-dom\/client$/, replacement: here("./node_modules/react-dom/client.js") },
        ],
        dedupe: ["react", "react-dom", "motion", "@base-ui/react", "lucide-react"],
    },
    server: {
        port: 14430,
        strictPort: true,
        host: host || false,
        hmr: host ? { protocol: "ws", host, port: 14431 } : undefined,
        watch: { ignored: ["**/src-tauri/**"] },
    },
    build: {
        target: "es2022",
        minify: "oxc",
        sourcemap: false,
        reportCompressedSize: false,
        // Loaded from the local app bundle (no network); React + Motion + Base UI + i18next ≈ 615 kB.
        chunkSizeWarningLimit: 700,
        rolldownOptions: {
            output: {
                codeSplitting: {
                    groups: [
                        {
                            name: "vendor",
                            test: /[\\/]node_modules[\\/](react|react-dom|scheduler|motion|framer-motion|@base-ui|lucide-react|i18next|react-i18next|zustand)[\\/]/,
                            priority: 10,
                        },
                    ],
                },
            },
        },
    },
});
