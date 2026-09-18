// Conventional Commits for the MixAI monorepo (WP13-04). Hook: .husky/commit-msg.
// Scopes are a WARNING, not an error — new surfaces appear faster than this list is edited.
export default {
    extends: ["@commitlint/config-conventional"],
    rules: {
        "header-max-length": [2, "always", 120],
        "body-max-line-length": [1, "always", 200],
        "subject-case": [0],
        "scope-enum": [
            1,
            "always",
            [
                "web",
                "server",
                "mixai",
                "native",
                "extension",
                "tv-android",
                "tv-tizen",
                "gateway",
                "ui",
                "tokens",
                "sdk",
                "ai",
                "db",
                "docs",
                "ci",
                "agents",
                "gates",
                "tracker",
                "video",
                "media",
                "deps",
                "release",
            ],
        ],
    },
    ignores: [
        // Merge / revert / changeset-generated commits.
        (msg) => /^(Merge|Revert|Version Packages)/.test(msg),
    ],
};
