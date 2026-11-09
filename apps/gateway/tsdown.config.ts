import { defineConfig } from "tsdown";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
    entry: ["src/server.ts"],
    format: ["esm"],
    target: "node24",
    platform: "node",
    clean: true,
    // Keep dist/server.js (tsdown defaults to .mjs on platform node) — the
    // Dockerfile CMD and the "start" script run that exact file.
    fixedExtension: false,
    // Apps ship no declarations.
    dts: false,
    // Single-entry server bundle, no minify (readable stack traces on Cloud
    // Run), sourcemaps only outside production.
    minify: false,
    treeshake: true,
    sourcemap: process.env.NODE_ENV !== "production",
    // Resolve the @mmo/db path alias to the shared package source so it
    // bundles in (the monorepo package is not in the Docker build context).
    alias: {
        "@mmo/db/schema": resolve(here, "../../packages/db/src/schema.ts"),
        "@mmo/db/schema-training": resolve(here, "../../packages/db/src/schema-training.ts"),
        "@mmo/db": resolve(here, "../../packages/db/src/index.ts"),
    },
    // Runtime deps (ws/postgres use dynamic require + native bindings; hono,
    // drizzle-orm, zod) stay external — package.json dependencies (and their
    // subpaths) are external by default. The Cloud Run image ships them via
    // `pnpm install --prod`.
});
