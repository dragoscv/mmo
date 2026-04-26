/**
 * electron-builder afterPack hook — ad-hoc codesigns the macOS .app
 * bundle using `codesign --sign -` (the dash means "ad-hoc identity").
 *
 * Why: without ANY signature, modern macOS (especially on Apple Silicon
 * arm64) refuses to launch the app at all with errors like "is damaged
 * and can't be opened". With ad-hoc signing the app gets a stable but
 * unverifiable signature; the user still sees the "developer cannot be
 * verified" Gatekeeper warning on first run, but right-click → Open
 * (or `xattr -dr com.apple.quarantine`) lets it run permanently.
 *
 * This is the best we can do without a $99/yr Apple Developer ID.
 *
 * Skipped on non-mac platforms.
 */

const { execFileSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

exports.default = async function afterPack(context) {
    if (context.electronPlatformName !== "darwin") return;

    const appName = `${context.packager.appInfo.productFilename}.app`;
    const appPath = path.join(context.appOutDir, appName);

    if (!fs.existsSync(appPath)) {
        console.warn(`[afterPack] .app not found at ${appPath}, skipping`);
        return;
    }

    console.log(`[afterPack] Ad-hoc signing ${appPath} for ${context.arch}`);
    try {
        execFileSync(
            "codesign",
            [
                "--force",
                "--deep",
                "--sign",
                "-", // "-" = ad-hoc identity
                "--timestamp=none",
                "--options=runtime", // harmless even with hardenedRuntime:false
                appPath,
            ],
            { stdio: "inherit" },
        );
        execFileSync("codesign", ["--verify", "--verbose=2", appPath], {
            stdio: "inherit",
        });
        console.log("[afterPack] Ad-hoc signing complete");
    } catch (err) {
        console.error("[afterPack] codesign failed:", err.message);
        throw err;
    }
};
