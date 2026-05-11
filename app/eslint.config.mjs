/**
 * ESLint flat config for the MMO web app.
 *
 * `eslint-config-next` v16 already publishes a flat-config array (see its
 * `dist/index.js`). We import it directly and append our local overrides;
 * going through `@eslint/eslintrc`'s FlatCompat shim creates circular plugin
 * references and crashes ESLint 9.
 */

import nextConfig from "eslint-config-next";

const config = [
    {
        ignores: [
            ".next/**",
            "node_modules/**",
            "drizzle/**",
            "public/**",
            "data/**",
            "next-env.d.ts",
            "src/components/dev-debugger/**",
        ],
    },
    ...nextConfig,
    {
        // Our own overrides. We only touch rules whose plugin is already
        // loaded by `next/core-web-vitals` (eslint-plugin-react +
        // eslint-plugin-react-hooks). Flat-config requires that a rule and
        // its owning plugin live in the same config object, so anything
        // `@typescript-eslint/*`-related belongs in the upstream
        // `next/typescript` block — we don't re-open it here.
        rules: {
            // Heavy UTF-8 RO copy with apostrophes / quotes in JSX text.
            "react/no-unescaped-entities": "off",
            "react-hooks/exhaustive-deps": "warn",
        },
    },
];

export default config;
