import { defineConfig } from "vitest/config";

// Pure helpers only (protocol reducer, param maths, routing hints, i18n parity): node environment.
export default defineConfig({
    test: {
        environment: "node",
        include: ["src/**/*.test.ts"],
    },
});
