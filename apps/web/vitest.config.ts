import { defineConfig } from "vitest/config";
import path from "node:path";

const alias = {
    "@": path.resolve(__dirname, "src"),
    // Shared packages (consumed via tsconfig path alias).
    "@mmo/db/schema-projects-normalized": path.resolve(__dirname, "../../packages/db/src/schema-projects-normalized.ts"),
    "@mmo/db/schema-projects": path.resolve(__dirname, "../../packages/db/src/schema-projects.ts"),
    "@mmo/db/schema-training": path.resolve(__dirname, "../../packages/db/src/schema-training.ts"),
    "@mmo/db/schema-ai": path.resolve(__dirname, "../../packages/db/src/schema-ai.ts"),
    "@mmo/db/schema": path.resolve(__dirname, "../../packages/db/src/schema.ts"),
    "@mmo/db": path.resolve(__dirname, "../../packages/db/src/index.ts"),
    "@mmo/ui": path.resolve(__dirname, "../../packages/ui/src/index.ts"),
    "@mmo/design-tokens": path.resolve(__dirname, "../../packages/design-tokens/src/index.ts"),
    // `server-only` is a Next.js sentinel package that throws if
    // imported into a client bundle. Vitest doesn't ship it; alias
    // to a no-op so server-side modules with `import "server-only"`
    // can be unit-tested.
    "server-only": path.resolve(__dirname, "vitest.server-only-shim.ts"),
};

export default defineConfig({
    resolve: {
        alias,
        // packages/ui is consumed via path alias, so its own node_modules would
        // otherwise supply a second React copy ("Cannot read properties of null
        // (reading 'useState')"). Force a single instance from apps/web.
        dedupe: ["react", "react-dom", "motion", "@base-ui/react", "lucide-react"],
    },
    test: {
        // Per-pattern environments (vitest 5 `projects` replaces the removed
        // `environmentMatchGlobs`): tsx component tests need jsdom for a real
        // DOM, the .ts suite is pure node logic and runs ~10× faster without it.
        projects: [
            {
                extends: true,
                test: {
                    name: "dom",
                    environment: "jsdom",
                    include: ["src/**/*.test.tsx"],
                    setupFiles: ["./vitest.setup.ts"],
                },
            },
            {
                extends: true,
                test: {
                    name: "node",
                    environment: "node",
                    include: ["src/**/*.test.ts"],
                    setupFiles: ["./vitest.setup.ts"],
                },
            },
        ],
        coverage: {
            provider: "v8",
            reporter: ["text", "html"],
            include: ["src/lib/**", "src/app/api/**", "src/components/**"],
            exclude: ["**/*.test.ts", "**/*.test.tsx", "**/*.d.ts"],
        },
    },
});
