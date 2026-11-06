import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import tizenPkg from "../tv-tizen/package.json" with { type: "json" };
import pkg from "./package.json" with { type: "json" };

/**
 * MixAI TV desktop (WP17-25): the UI is apps/tv-tizen/src (one TV-web codebase, D46). Tauri serves it from
 * `http(s)://tauri.localhost` / `tauri://`, so modern ES modules work — no plugin-legacy, modern target.
 * Shared deps (react, hls.js, qrcode) resolve from apps/tv-tizen/node_modules; `dedupe` keeps one React.
 */
const tizen = fileURLToPath(new URL("../tv-tizen/", import.meta.url));

export default defineConfig({
    define: { __APP_VERSION__: JSON.stringify(`${pkg.version} (ui ${tizenPkg.version})`) },
    plugins: [react()],
    base: "./",
    publicDir: `${tizen}public`,
    resolve: {
        dedupe: ["react", "react-dom", "hls.js", "qrcode"],
        alias: {
            react: `${tizen}node_modules/react`,
            "react-dom": `${tizen}node_modules/react-dom`,
            "hls.js": `${tizen}node_modules/hls.js`,
            qrcode: `${tizen}node_modules/qrcode`,
        },
    },
    clearScreen: false,
    server: { port: 13795, strictPort: true, fs: { allow: [tizen, fileURLToPath(new URL(".", import.meta.url))] } },
    build: {
        outDir: "dist",
        emptyOutDir: true,
        target: ["es2022", "chrome110", "safari16"],
        sourcemap: false,
        reportCompressedSize: false,
    },
});
