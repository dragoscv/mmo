/**
 * ESLint 10 flat config for the MMO web app (WP20-08).
 *
 * Hand-built instead of `eslint-config-next`: that preset pulls eslint-plugin-react,
 * jsx-a11y and import, none of which support ESLint 10 yet. The equivalent coverage:
 *   - @next/eslint-plugin-next core-web-vitals (same rules the preset enabled)
 *   - eslint-plugin-react-hooks recommended (React Compiler rules included)
 *   - typescript-eslint recommended (syntax-only, like the preset's TS parser setup)
 *   - @eslint-react recommended-typescript (replaces eslint-plugin-react)
 * The fast type-aware gate is oxlint (`pnpm lint:ox`, .oxlintrc.json).
 */

import js from "@eslint/js";
import nextPlugin from "@next/eslint-plugin-next";
import eslintReact from "@eslint-react/eslint-plugin";
import reactHooks from "eslint-plugin-react-hooks";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
    globalIgnores([
        ".next/**",
        "node_modules/**",
        "drizzle/**",
        "public/**",
        "data/**",
        "coverage/**",
        "playwright-report/**",
        "test-results/**",
        ".lighthouseci/**",
        "next-env.d.ts",
        "src/components/dev-debugger/**",
    ]),
    {
        files: ["**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}"],
        extends: [
            js.configs.recommended,
            tseslint.configs.recommended,
            eslintReact.configs["recommended-typescript"],
            reactHooks.configs.flat["recommended-latest"] ?? reactHooks.configs["recommended-latest"],
            nextPlugin.configs["core-web-vitals"],
        ],
        languageOptions: {
            globals: { ...globals.browser, ...globals.node },
        },
        linterOptions: {
            // Disable comments for rules of plugins we no longer load (react/*, jsx-a11y/*,
            // import/*) would otherwise error out as "rule not found".
            reportUnusedDisableDirectives: "warn",
        },
        rules: {
            "react-hooks/exhaustive-deps": "warn",
            // eslint-plugin-react-hooks already reports these; avoid double-counting in the baseline.
            "@eslint-react/rules-of-hooks": "off",
            // New in ESLint 10 recommended / @eslint-react: surfaced as warnings first, promote to
            // errors once the existing findings are fixed (tracked in WP20-08).
            "no-useless-assignment": "warn",
            "preserve-caught-error": "warn",
            "@eslint-react/static-components": "warn",
            "@eslint-react/no-nested-component-definitions": "warn",
            // Pulled in by js/typescript-eslint recommended; eslint-config-next did not enable them,
            // so the existing code base was never held to them. Warnings until cleaned up (WP20-08).
            "@typescript-eslint/no-explicit-any": "warn",
            "@typescript-eslint/no-unused-expressions": "warn",
            "no-control-regex": "warn",
            "no-useless-escape": "warn",
            "no-empty": "warn",
            "no-case-declarations": "warn",
            "prefer-const": "warn",
            // Same intent as before: the preset kept these off for a TS + Next codebase.
            "no-undef": "off",
            "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
        },
    },
    {
        files: ["**/*.{js,cjs,mjs}"],
        rules: { "@typescript-eslint/no-require-imports": "off" },
    },
);
