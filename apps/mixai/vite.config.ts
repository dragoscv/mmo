import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

// Tauri expects a fixed port and disables HMR clearing so the dev
// experience matches the bundled webview. The Rust side serves the
// built `dist/` in production (see tauri.conf.json frontendDist).
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
    plugins: [react()],
    // Prevent Vite from obscuring Rust panics printed to the terminal.
    clearScreen: false,
    resolve: {
        alias: {
            "@": fileURLToPath(new URL("./src", import.meta.url)),
        },
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
    },
});
