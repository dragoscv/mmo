#!/usr/bin/env node
// Prettier on ONLY the files THIS COMMIT changes.
//
// Replaces a `prettier --write` step over every staged file that differs from HEAD. In a worktree
// whose HEAD trails upstream that set is not "my changes" -- it is every file main moved on since
// the worktree's base, so a one-line commit reformats and re-stages another agent's work, and the
// diff reviewer then sees a hundred files nobody touched.
//
// "Changed by this commit" is decided by the INDEX, not the working tree: a path whose index blob
// differs from the blob at the UPSTREAM ref (`@{u}`, else `origin/main`, else HEAD). A path that
// does not exist upstream is new here and counts as changed.
//
// Ported from the same script in metu/codai (kept in step on purpose: one behaviour, three repos).
//
// Usage: node scripts/ci/precommit-format-staged.mjs [--base <ref>] [--dry-run] [--json] [--all]
//        [--runner "<cmd>"]   run this instead of prettier (`eslint --fix`, `rustfmt --edition 2024`)
//        [--ext ".rs,.toml"]  restrict the selection to these extensions (default: the formattable set)

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Extensions this repo formats.
 *
 * Kotlin is deliberately absent: prettier has no Kotlin parser, so including it would fail every
 * commit that touches a .kt file (the Kotlin sources are covered by the read-only hex gate).
 * Markdown is deliberately absent too -- the docs are gate-owned (scripts/tracker-drift.mjs parses
 * docs/mixai-design-tracker.md) and prettier's prose reflow would churn hand-written docs.
 */
export const FORMATTABLE = /\.(?:ts|tsx|js|jsx|mjs|cjs|json|css|yaml|yml)$/u;

/** Windows CreateProcess caps a command line at ~32 KB; the old hook batched by 60. */
export const BATCH_SIZE = 60;

/**
 * A git caller bound to `root`. `run` is injectable so the selection logic can be tested
 * without a repository and without spawning anything.
 */
export function makeGit(root, run = spawnSync) {
    return (args) => {
        const r = run("git", args, { cwd: root, encoding: "utf8" });
        return { status: r.status ?? 1, stdout: (r.stdout ?? "").trim() };
    };
}

/** The ref a commit is compared against: explicit flag, else upstream, else origin/main, else HEAD. */
export function resolveBase(git, explicit) {
    if (explicit) return explicit;
    for (const candidate of ["@{u}", "origin/main", "main", "HEAD"]) {
        const { status, stdout } = git([
            "rev-parse",
            "--verify",
            "--quiet",
            `${candidate}^{commit}`,
        ]);
        if (status === 0 && stdout) return candidate;
    }
    return "HEAD";
}

/** Staged paths of any kind a formatter can rewrite (added, copied, modified, renamed). */
export function stagedPaths(git) {
    const { status, stdout } = git(["diff", "--cached", "--name-only", "--diff-filter=ACMR"]);
    if (status !== 0) return [];
    return stdout.split(/\r?\n/u).filter(Boolean);
}

/** The blob currently recorded in the index for `path` (null when the path is not in the index). */
export function indexBlob(git, path) {
    const { status, stdout } = git(["ls-files", "-s", "--", path]);
    if (status !== 0 || !stdout) return null;
    const first = stdout.split(/\r?\n/u)[0];
    const fields = first.split(/\s+/u);
    return fields[1] ?? null;
}

/** The blob `path` has at `base` (null when the path is absent there -- a new file). */
export function baseBlob(git, base, path) {
    const { status, stdout } = git(["rev-parse", "--verify", "--quiet", `${base}:${path}`]);
    return status === 0 && stdout ? stdout : null;
}

/**
 * Pure selection: what a commit against `base` actually changes, restricted to formattable
 * extensions. Entries are `{ path, indexBlob, baseBlob }`; an entry with no index blob is not
 * staged and drops out, and an equal pair is a file main moved on, not one this commit touches.
 */
export function selectChanged(entries, { formattable = FORMATTABLE } = {}) {
    return entries
        .filter((e) => Boolean(e.indexBlob) && e.indexBlob !== e.baseBlob)
        .filter((e) => formattable.test(e.path))
        .map((e) => e.path);
}

/** A formatter must not inherit GIT_* from the caller: GIT_INDEX_FILE/GIT_DIR would point it at another tree. */
export function cleanEnv(env = process.env) {
    const out = {};
    for (const [k, v] of Object.entries(env)) if (!k.startsWith("GIT_")) out[k] = v;
    return out;
}

/** The repo's pinned prettier first; `pnpm exec prettier` only as a fallback. */
export function prettierCommand(root, platform = process.platform, exists = existsSync) {
    const bin = join(
        root,
        "node_modules",
        ".bin",
        platform === "win32" ? "prettier.cmd" : "prettier",
    );
    if (exists(bin)) return { cmd: bin, prefix: [], shell: platform === "win32" };
    return { cmd: "pnpm", prefix: ["exec", "prettier"], shell: platform === "win32" };
}

/**
 * The extension filter for `--ext`: a comma list with or without the leading dot. Anything that is
 * not alphanumeric is escaped, so a value can never turn into an unintended pattern.
 */
export function extensionFilter(list) {
    const parts = String(list)
        .split(",")
        .map((s) => s.trim().replace(/^\./u, ""))
        .filter(Boolean)
        .map((s) => s.replace(/[^A-Za-z0-9]/gu, "\\$&"));
    return parts.length ? new RegExp(`\\.(?:${parts.join("|")})$`, "u") : FORMATTABLE;
}

/** Quote an argument for the shell only when it needs it (a path with a space would split). */
export function quoteArg(arg) {
    return /[\s"]/u.test(arg) ? `"${arg.replace(/"/gu, '\\"')}"` : arg;
}

/**
 * The command that writes formatting: an explicit `--runner` (spawned through a shell, because it is
 * a full command line such as `eslint --fix`), otherwise the repo's pinned prettier.
 */
export function formatCommand(
    root,
    { runner, platform = process.platform, exists = existsSync } = {},
) {
    if (runner) return { cmd: runner, prefix: [], shell: true };
    return prettierCommand(root, platform, exists);
}

export function batches(items, size = BATCH_SIZE) {
    const out = [];
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
    return out;
}

/** Run prettier --write over the selection. Returns an exit code. */
export function runPrettier(
    paths,
    { root, spawn = spawnSync, env = cleanEnv(), platform = process.platform } = {},
) {
    if (!paths.length) return 0;
    const { cmd, prefix, shell } = prettierCommand(root, platform);
    for (const batch of batches(paths)) {
        const args = [...prefix, "--write", "--log-level", "warn", ...batch];
        const r = spawn(cmd, args, { cwd: root, stdio: "inherit", env, shell });
        const code = r.status ?? 1;
        if (code !== 0) return code;
    }
    return 0;
}

/**
 * Run the writer over the selection: `--runner` when given, else prettier. Returns an exit code.
 * The runner is a command line, so paths are quoted by hand before they reach the shell.
 */
export function runFormatter(
    paths,
    { root, spawn = spawnSync, env = cleanEnv(), platform = process.platform, runner } = {},
) {
    if (!paths.length) return 0;
    if (!runner) return runPrettier(paths, { root, spawn, env, platform });
    const { cmd, shell } = formatCommand(root, { runner, platform });
    for (const batch of batches(paths)) {
        const r = spawn(cmd, batch.map(quoteArg), { cwd: root, stdio: "inherit", env, shell });
        const code = r.status ?? 1;
        if (code !== 0) return code;
    }
    return 0;
}

export function collectEntries(git, base, paths) {
    return paths.map((path) => ({
        path,
        indexBlob: indexBlob(git, path),
        baseBlob: baseBlob(git, base, path),
    }));
}

function main(argv = process.argv.slice(2), root = process.cwd()) {
    const flag = (name) => {
        const i = argv.indexOf(name);
        return i >= 0 ? argv[i + 1] : undefined;
    };
    const dryRun = argv.includes("--dry-run");
    const json = argv.includes("--json");
    const all = argv.includes("--all");
    const runner = flag("--runner");
    const ext = flag("--ext") ? extensionFilter(flag("--ext")) : FORMATTABLE;

    const git = makeGit(root);
    // --all keeps the pre-fix semantics (compare against HEAD only); everything else uses upstream.
    const base = all ? "HEAD" : resolveBase(git, flag("--base"));
    const staged = stagedPaths(git);
    const selected = selectChanged(collectEntries(git, base, staged), { formattable: ext });

    if (json) {
        console.log(JSON.stringify({ base, staged: staged.length, selected }, null, 2));
    } else {
        console.log(
            `→ precommit-format-staged: ${selected.length} of ${staged.length} staged file(s) change vs ${base}`,
        );
        for (const p of selected.slice(0, 30)) console.log(`   ${p}`);
        if (selected.length > 30) console.log(`   … and ${selected.length - 30} more`);
        if (runner) console.log(`   runner: ${runner}`);
    }

    if (dryRun || !selected.length) return 0;

    const code = runFormatter(selected, { root, runner });
    if (code !== 0) return code;

    for (const batch of batches(selected)) {
        const r = spawnSync("git", ["add", "--", ...batch], { cwd: root, stdio: "inherit" });
        if ((r.status ?? 1) !== 0) return r.status ?? 1;
    }
    return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    process.exit(main());
}
