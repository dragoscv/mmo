import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

// Tauri expects a fixed port and disables HMR clearing so the dev
// experience matches the bundled webview. The Rust side serves the
// built `dist/` in production (see tauri.conf.json frontendDist).
const host = process.env.TAURI_DEV_HOST;
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
    plugins: [react(), tailwindcss()],
    // Prevent Vite from obscuring Rust panics printed to the terminal.
    clearScreen: false,
    resolve: {
        alias: {
            "@": here("./src"),
            // Shared design system, consumed from source (repo convention).
            "@mmo/design-tokens": here("../../packages/design-tokens/src/index.ts"),
            "@mmo/ui/styles.css": here("../../packages/ui/src/styles.css"),
            "@mmo/ui": here("../../packages/ui/src"),
        },
        // packages/ui has its own node_modules/react — without dedupe hooks
        // throw "Cannot read properties of null (reading 'useState')".
        dedupe: ["react", "react-dom", "motion", "@base-ui/react", "lucide-react"],
    },
    server: {
        port: 14420,
        strictPort: true,
        host: host || false,
        hmr: host
            ? { protocol: "ws", host, port: 14421 }
            : undefined,
        watch: {
            // Don't watch the Rust source tree from the JS dev server.
            ignored: ["**/src-tauri/**"],
        },
    },
    // Produce a build the webview can consume from a file:// origin.
    build: {
        target: "es2022",
        minify: "esbuild",
        sourcemap: false,
        // Skip the gzip pass used only for the size report.
        reportCompressedSize: false,
    },
});
