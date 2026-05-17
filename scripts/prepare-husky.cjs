// Cross-platform husky bootstrap.
// Runs on `pnpm install`. Failing here would block CI/installer pipelines,
// so any error (no husky on PATH, CI environment, etc.) is swallowed silently.
// The git hooks are a dev-only convenience — production builds never need them.
try {
    if (process.env.CI || process.env.HUSKY === "0") return;
    const cp = require("node:child_process");
    const bin = process.platform === "win32" ? "husky.cmd" : "husky";
    cp.execSync(bin, { stdio: "inherit" });
} catch {
    // best-effort
}
