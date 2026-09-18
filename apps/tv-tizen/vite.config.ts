import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import legacy from "@vitejs/plugin-legacy";

// Tizen 6–8 ship Chromium ~76–94 → es2017 output. `base: './'` because the
// widget is served from file:// inside the .wgt — and on file:// Chromium
// refuses `<script type="module">` (null-origin CORS), so plugin-legacy emits
// classic SystemJS scripts only (renderModernChunks=false). Dynamic imports
// (hls.js) still stay in their own lazily-loaded chunk.
export default defineConfig({
    plugins: [
        react(),
        legacy({
            targets: ["chrome >= 76"],
            renderModernChunks: false,
            modernPolyfills: false,
            // Chrome 76 has everything es2017 needs; skip the 100 kB core-js bundle.
            polyfills: false,
        }),
    ],
    base: "./",
    build: {
        outDir: "dist",
        emptyOutDir: true,
        cssTarget: "chrome76",
        modulePreload: { polyfill: false },
        sourcemap: false,
        // Skip the gzip pass used only for the size report.
        reportCompressedSize: false,
        rollupOptions: {
            output: {
                // Vite 8 (rolldown) only accepts the function form.
                manualChunks: (id: string) => (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id) ? "react" : undefined),
            },
        },
    },
    server: { port: 13791 },
});
