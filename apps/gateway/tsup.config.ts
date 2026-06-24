import { defineConfig } from "tsup";

export default defineConfig({
    entry: ["src/server.ts"],
    format: ["esm"],
    target: "node20",
    platform: "node",
    clean: true,
    sourcemap: true,
    // Keep runtime deps external (ws/postgres use dynamic require + native
    // bindings that don't survive ESM bundling). The Cloud Run image ships
    // node_modules via `pnpm install --prod`.
    external: ["postgres", "ws", "hono", "@hono/node-server"],
});
