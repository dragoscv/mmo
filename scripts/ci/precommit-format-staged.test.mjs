import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
    FORMATTABLE,
    batches,
    cleanEnv,
    collectEntries,
    extensionFilter,
    formatCommand,
    prettierCommand,
    resolveBase,
    runFormatter,
    runPrettier,
    selectChanged,
    stagedPaths,
} from "./precommit-format-staged.mjs";

/** A throwaway repository whose commits do not depend on the machine's git config. */
function tmpRepo() {
    const dir = mkdtempSync(join(tmpdir(), "pfs-"));
    const env = {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.invalid",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.invalid",
    };
    const g = (...args) => {
        const r = spawnSync(
            "git",
            ["-c", "core.autocrlf=false", "-c", "init.defaultBranch=main", ...args],
            {
                cwd: dir,
                encoding: "utf8",
                env,
            },
        );
        assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
        return (r.stdout ?? "").trim();
    };
    g("init", "-q");
    g("config", "core.hooksPath", join(dir, ".no-hooks"));
    mkdirSync(join(dir, ".no-hooks"), { recursive: true });
    return { dir, g, env };
}

test("a file only main moved on is NOT formatted (the regression this replaces)", () => {
    const { dir, g, env } = tmpRepo();
    writeFileSync(join(dir, "mine.ts"), "const a = 1;\n");
    writeFileSync(join(dir, "theirs.ts"), "const b = 1;\n");
    g("add", ".");
    g("commit", "-qm", "c1");
    const c1 = g("rev-parse", "HEAD");

    // main moves on: theirs.ts changes alone.
    writeFileSync(join(dir, "theirs.ts"), "const b = 2;\n");
    g("add", "theirs.ts");
    g("commit", "-qm", "c2");
    g("update-ref", "refs/remotes/origin/main", "HEAD");

    // This worktree is based at c1 with the index already carrying main's content.
    g("reset", "--soft", c1);
    // …and this commit changes mine.ts only.
    writeFileSync(join(dir, "mine.ts"), "const a = 2;\n");
    g("add", "mine.ts");

    const git = (args) => {
        const r = spawnSync("git", ["-c", "core.autocrlf=false", ...args], {
            cwd: dir,
            encoding: "utf8",
            env,
        });
        return { status: r.status ?? 1, stdout: (r.stdout ?? "").trim() };
    };

    // Both files are "staged vs HEAD" -- that is exactly why the old step reformatted upstream work.
    assert.deepEqual(stagedPaths(git).sort(), ["mine.ts", "theirs.ts"]);
    const selected = selectChanged(collectEntries(git, "origin/main", stagedPaths(git)));
    assert.deepEqual(selected, ["mine.ts"]);
});

test("a new file counts as changed; an unchanged one does not", () => {
    const entries = [
        { path: "new.ts", indexBlob: "aaa", baseBlob: null },
        { path: "same.ts", indexBlob: "bbb", baseBlob: "bbb" },
        { path: "gone.ts", indexBlob: null, baseBlob: "ccc" },
    ];
    assert.deepEqual(selectChanged(entries), ["new.ts"]);
});

test("non-formattable extensions drop out even when changed", () => {
    const entries = [
        { path: "a.png", indexBlob: "x", baseBlob: null },
        { path: "b.rs", indexBlob: "x", baseBlob: null },
        { path: "c.tsx", indexBlob: "x", baseBlob: null },
    ];
    assert.deepEqual(selectChanged(entries), ["c.tsx"]);
});

test("the default set is the extensions this repo formats, minus Kotlin and markdown", () => {
    // What prettier owns here: the TS/JS sources, the JSON configs, the CSS and the YAML.
    for (const p of [
        "a.ts",
        "a.tsx",
        "a.js",
        "a.jsx",
        "a.mjs",
        "a.cjs",
        "a.json",
        "a.css",
        "a.yaml",
        "a.yml",
    ]) {
        assert.ok(FORMATTABLE.test(p), `${p} should be formattable`);
    }
    // .kt has no prettier parser (including it would fail every Kotlin commit); .md is gate-owned.
    for (const p of ["a.kt", "a.md", "a.mdx", "a.scss", "a.rs", "a.png"]) {
        assert.ok(!FORMATTABLE.test(p), `${p} should NOT be formattable`);
    }
});

test("a changed Kotlin file is never handed to prettier, a changed YAML file is", () => {
    const entries = [
        { path: "apps/phone-android/src/Main.kt", indexBlob: "x", baseBlob: null },
        { path: "server/openapi.yaml", indexBlob: "x", baseBlob: null },
        { path: "docs/mixai-design-tracker.md", indexBlob: "x", baseBlob: null },
    ];
    assert.deepEqual(selectChanged(entries), ["server/openapi.yaml"]);
});

test("resolveBase prefers the upstream branch, then origin/main, and honours an explicit ref", () => {
    const calls = [];
    const git = (args) => {
        const key = args.join(" ");
        calls.push(key);
        if (key === "rev-parse --verify --quiet origin/main^{commit}")
            return { status: 0, stdout: "abc123" };
        return { status: 1, stdout: "" };
    };
    assert.equal(resolveBase(git), "origin/main");
    assert.equal(calls.length, 2, "stops probing after the first hit");
    assert.equal(resolveBase(git, "HEAD~3"), "HEAD~3", "an explicit ref is used as given");
});

test("resolveBase falls back to HEAD when nothing else resolves", () => {
    assert.equal(
        resolveBase(() => ({ status: 1, stdout: "" })),
        "HEAD",
    );
});

test("the formatter never inherits GIT_* from the caller", () => {
    const cleaned = cleanEnv({
        PATH: "/x",
        GIT_DIR: "/tmp/evil",
        GIT_INDEX_FILE: "/tmp/idx",
        GIT_WORK_TREE: "/y",
    });
    assert.deepEqual(Object.keys(cleaned), ["PATH"]);
});

test("runPrettier writes in batches and passes a cleaned env to the child", () => {
    const seen = [];
    const spawn = (cmd, args, opts) => {
        seen.push({ cmd, args, opts });
        return { status: 0 };
    };
    const env = { PATH: "/x", GIT_DIR: "/tmp/evil" };
    const code = runPrettier(["a.ts", "b.ts"], {
        root: "/repo",
        spawn,
        env: cleanEnv(env),
        platform: "linux",
    });
    assert.equal(code, 0);
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0].args.slice(-2), ["a.ts", "b.ts"]);
    assert.ok(seen[0].args.includes("--write"));
    assert.equal(seen[0].opts.env.GIT_DIR, undefined);
    assert.equal(seen[0].opts.env.PATH, "/x");
});

test("runPrettier surfaces a non-zero prettier exit code", () => {
    const code = runPrettier(["a.ts"], {
        root: "/repo",
        spawn: () => ({ status: 2 }),
        env: {},
        platform: "linux",
    });
    assert.equal(code, 2);
});

test("the pinned prettier binary is preferred, pnpm is only the fallback", () => {
    assert.deepEqual(
        prettierCommand("/repo", "linux", () => false),
        {
            cmd: "pnpm",
            prefix: ["exec", "prettier"],
            shell: false,
        },
    );
    assert.deepEqual(
        prettierCommand("/repo", "win32", () => true),
        {
            cmd: join("/repo", "node_modules", ".bin", "prettier.cmd"),
            prefix: [],
            shell: true,
        },
    );
});

test("batches respect the 60-argument cap", () => {
    const many = Array.from({ length: 130 }, (_, i) => `f${i}.ts`);
    assert.deepEqual(
        batches(many).map((b) => b.length),
        [60, 60, 10],
    );
    assert.deepEqual(batches([], 60), []);
});

test("extensionFilter accepts a dot list, with or without the leading dot", () => {
    const rs = extensionFilter(".rs, toml");
    assert.ok(rs.test("a.rs"));
    assert.ok(rs.test("a.toml"));
    assert.ok(!rs.test("a.ts"));
    assert.equal(extensionFilter(".rs").source, "\\.(?:rs)$");
    assert.equal(
        extensionFilter("  ").source,
        FORMATTABLE.source,
        "an empty list keeps the default",
    );
    assert.ok(!extensionFilter(".r+").test("arrs"), "a metacharacter in the list stays literal");
});

test("a custom extension filter narrows the selection", () => {
    const entries = [
        { path: "a.rs", indexBlob: "x", baseBlob: null },
        { path: "b.ts", indexBlob: "x", baseBlob: null },
    ];
    assert.deepEqual(selectChanged(entries, { formattable: extensionFilter(".rs") }), ["a.rs"]);
});

test("formatCommand prefers the runner, and falls back to the pinned prettier", () => {
    assert.deepEqual(formatCommand("/repo", { runner: "eslint --fix" }), {
        cmd: "eslint --fix",
        prefix: [],
        shell: true,
    });
    assert.deepEqual(formatCommand("/repo", { platform: "linux", exists: () => false }), {
        cmd: "pnpm",
        prefix: ["exec", "prettier"],
        shell: false,
    });
});

test("runFormatter spawns the runner through a shell with quoted paths", () => {
    const seen = [];
    const spawn = (cmd, args, opts) => {
        seen.push({ cmd, args, opts });
        return { status: 0 };
    };
    const code = runFormatter(["a b.ts", "c.ts"], {
        root: "/repo",
        runner: "eslint --fix",
        spawn,
        env: {},
    });
    assert.equal(code, 0);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].cmd, "eslint --fix");
    assert.deepEqual(seen[0].args, ['"a b.ts"', "c.ts"]);
    assert.equal(seen[0].opts.shell, true);
});

test("runFormatter delegates to prettier when no runner is given", () => {
    const seen = [];
    const spawn = (cmd, args, opts) => {
        seen.push({ cmd, args, opts });
        return { status: 0 };
    };
    assert.equal(runFormatter(["a.ts"], { root: "/repo", spawn, env: {}, platform: "linux" }), 0);
    assert.equal(seen[0].cmd, "pnpm");
    assert.deepEqual(seen[0].args, ["exec", "prettier", "--write", "--log-level", "warn", "a.ts"]);
});

test("runFormatter surfaces a runner failure and skips an empty selection", () => {
    assert.equal(
        runFormatter(["a.ts"], {
            root: "/repo",
            runner: "eslint --fix",
            spawn: () => ({ status: 3 }),
        }),
        3,
    );
    assert.equal(runFormatter([], { root: "/repo", runner: "eslint --fix" }), 0);
});
