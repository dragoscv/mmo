import { defineConfig } from "tsup";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
    entry: ["src/server.ts"],
    format: ["esm"],
    target: "node20",
    platform: "node",
    clean: true,
    sourcemap: true,
    // Resolve the @mmo/db path alias (tsup/esbuild doesn't read tsconfig
    // paths) to the shared package source so it bundles in.
    esbuildOptions(options) {
        options.alias = {
            ...(options.alias ?? {}),
            "@mmo/db/schema": resolve(here, "../../packages/db/src/schema.ts"),
            "@mmo/db": resolve(here, "../../packages/db/src/index.ts"),
        };
    },
    // Keep runtime deps external (ws/postgres use dynamic require + native
    // bindings that don't survive ESM bundling). The Cloud Run image ships
    // node_modules via `pnpm install --prod`.
    external: ["postgres", "ws", "hono", "@hono/node-server"],
});
