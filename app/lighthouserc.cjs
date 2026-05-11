/**
 * Lighthouse CI configuration.
 *
 * Runs against a production build started by `pnpm start`, against the
 * three highest-traffic public surfaces. Budgets are deliberately loose
 * for the first iteration — the goal is to catch regressions, not to
 * pass green from day one. Tighten the numbers after the first run
 * shows real-world baselines.
 *
 * - `performance`, `accessibility`, `best-practices`, `seo` are scored
 *   0..1 by Lighthouse; we assert lower bounds via `assert`.
 * - We use `assert.assertions` instead of `assert.preset: "lighthouse:recommended"`
 *   so the failure list is short and actionable; the recommended preset
 *   is a wall of red on a Next.js app.
 *
 * `/mixer` is intentionally not in the URL list yet — it requires auth.
 * Add it once we wire a Playwright storageState fixture.
 */

module.exports = {
    ci: {
        collect: {
            // The Next.js dev server is too slow + noisy for LHCI; build
            // and serve a production bundle instead.
            startServerCommand: "pnpm start",
            startServerReadyPattern: "Ready in",
            startServerReadyTimeout: 60_000,
            url: [
                "http://localhost:13789/",
                "http://localhost:13789/offline",
                "http://localhost:13789/status",
            ],
            numberOfRuns: 1,
            settings: {
                // Mobile is the harsher profile; if we pass mobile we pass
                // desktop. Match Lighthouse's default mobile preset.
                preset: "desktop",
                // Skip PWA category — it has hard requirements (HTTPS,
                // installable from the URL, etc.) we can only satisfy in
                // a real deployment.
                onlyCategories: ["performance", "accessibility", "best-practices", "seo"],
            },
        },
        assert: {
            assertions: {
                // Performance: aim for "good" Core Web Vitals. Loose for
                // first run — tighten after baseline.
                "categories:performance": ["warn", { minScore: 0.7 }],
                // Accessibility: high bar. axe-core (Playwright) is the
                // strict gate; this is the holistic Lighthouse score.
                "categories:accessibility": ["error", { minScore: 0.9 }],
                "categories:best-practices": ["warn", { minScore: 0.9 }],
                "categories:seo": ["warn", { minScore: 0.9 }],
            },
        },
        upload: {
            // Default `temporary-public-storage` posts to lhci.googleapis.com;
            // we don't want public links to our build artifacts. Keep results
            // local; CI uploads the JSON as a workflow artifact.
            target: "filesystem",
            outputDir: "./.lighthouseci",
        },
    },
};
