import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
    test: {
        // Per-pattern environments: tsx component tests need jsdom for
        // a real DOM (Testing Library queries, user-event), but the .ts
        // suite (sync-apply, camelot, organizer…) is pure node logic
        // and runs ~10× faster without the DOM startup tax.
        environmentMatchGlobs: [
            ["src/**/*.test.tsx", "jsdom"],
            ["src/**/*.test.ts", "node"],
        ],
        include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
        setupFiles: ["./vitest.setup.ts"],
        coverage: {
            provider: "v8",
            reporter: ["text", "html"],
            include: ["src/lib/**", "src/app/api/**", "src/components/**"],
            exclude: ["**/*.test.ts", "**/*.test.tsx", "**/*.d.ts"],
        },
    },
    resolve: {
        alias: {
            "@": path.resolve(__dirname, "src"),
            // Shared schema/sync package (consumed via tsconfig path alias).
            "@mmo/db/schema-projects-normalized": path.resolve(__dirname, "../../packages/db/src/schema-projects-normalized.ts"),
            "@mmo/db/schema-projects": path.resolve(__dirname, "../../packages/db/src/schema-projects.ts"),
            "@mmo/db/schema-ai": path.resolve(__dirname, "../../packages/db/src/schema-ai.ts"),
            "@mmo/db/schema": path.resolve(__dirname, "../../packages/db/src/schema.ts"),
            "@mmo/db": path.resolve(__dirname, "../../packages/db/src/index.ts"),
            // `server-only` is a Next.js sentinel package that throws if
            // imported into a client bundle. Vitest doesn't ship it; alias
            // to a no-op so server-side modules with `import "server-only"`
            // can be unit-tested.
            "server-only": path.resolve(__dirname, "vitest.server-only-shim.ts"),
        },
    },
});
