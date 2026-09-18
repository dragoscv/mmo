import { fileURLToPath } from "node:url";
import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const serverNodeModules = path.resolve(here, "../node_modules");

/**
 * Companion renderer — loaded by Electron via `loadFile("../ui/dist/index.html")`,
 * so every asset URL must be relative (`base: "./"`).
 *
 * `@mmo/ui` / `@mmo/design-tokens` are consumed as SOURCE (repo convention,
 * see packages/README.md). packages/ui has its own node_modules/react, so
 * every package that carries React state must be deduped to server/node_modules
 * — otherwise hooks fail with "Cannot read properties of null (reading 'useState')".
 */
export default defineConfig({
    root: here,
    base: "./",
    plugins: [react(), tailwindcss()],
    resolve: {
        alias: [
            { find: /^@mmo\/ui$/, replacement: path.resolve(repo, "packages/ui/src/index.ts") },
            { find: /^@mmo\/ui\/(.*)$/, replacement: path.resolve(repo, "packages/ui/src") + "/$1" },
            { find: /^@mmo\/design-tokens$/, replacement: path.resolve(repo, "packages/design-tokens/src/index.ts") },
            { find: /^react$/, replacement: path.join(serverNodeModules, "react") },
            { find: /^react-dom$/, replacement: path.join(serverNodeModules, "react-dom") },
            { find: /^react\/jsx-runtime$/, replacement: path.join(serverNodeModules, "react/jsx-runtime") },
            { find: /^react\/jsx-dev-runtime$/, replacement: path.join(serverNodeModules, "react/jsx-dev-runtime") },
        ],
        dedupe: ["react", "react-dom", "motion", "@base-ui/react", "lucide-react"],
    },
    server: {
        fs: { allow: [repo] },
    },
    build: {
        outDir: path.resolve(here, "dist"),
        emptyOutDir: true,
        target: "chrome132", // Electron 34
        sourcemap: false,
        rolldownOptions: {
            output: {
                // rolldown ≥1.x: `codeSplitting.groups` (advancedChunks is deprecated).
                // One stable vendor chunk for the framework so app chunks stay small and cacheable.
                codeSplitting: {
                    groups: [
                        {
                            name: "vendor",
                            test: /[\\/]node_modules[\\/](react|react-dom|scheduler|motion|framer-motion|@base-ui[\\/]react|lucide-react)[\\/]/,
                            priority: 10,
                        },
                    ],
                },
            },
        },
    },
});
