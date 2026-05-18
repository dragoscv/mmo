#!/usr/bin/env node
/**
 * Download the cloudflared binary for the current platform into
 * assets/cloudflared/cloudflared(.exe) so electron-builder can ship it
 * via the extraResources block. Each CI runner downloads for its own
 * OS — Windows runner gets the .exe, macOS gets the universal binary,
 * Linux gets the x64 binary.
 *
 * Source: latest release from https://github.com/cloudflare/cloudflared
 * Auto-update is disabled at runtime (`--no-autoupdate`) so the version
 * shipped is the version that runs — bump this script's expectation
 * intentionally instead of letting cloudflared self-update under the
 * user.
 */

import { promises as fs } from "node:fs";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "assets", "cloudflared");

const LATEST_API = "https://api.github.com/repos/cloudflare/cloudflared/releases/latest";

function assetNameFor(platform, arch) {
    // Match the file naming used in CF's GitHub releases.
    // https://github.com/cloudflare/cloudflared/releases
    if (platform === "win32") return arch === "x64" ? "cloudflared-windows-amd64.exe" : "cloudflared-windows-386.exe";
    if (platform === "darwin") return arch === "arm64" ? "cloudflared-darwin-arm64.tgz" : "cloudflared-darwin-amd64.tgz";
    if (platform === "linux") return arch === "arm64" ? "cloudflared-linux-arm64" : "cloudflared-linux-amd64";
    throw new Error(`Unsupported platform: ${platform}`);
}

async function main() {
    const platform = process.platform;
    const arch = process.arch;
    const assetName = assetNameFor(platform, arch);
    await fs.mkdir(OUT_DIR, { recursive: true });

    const outFile = path.join(OUT_DIR, platform === "win32" ? "cloudflared.exe" : "cloudflared");
    if (await fs.access(outFile).then(() => true, () => false)) {
        console.log(`[fetch-cloudflared] ${outFile} already exists, skipping`);
        return;
    }

    console.log(`[fetch-cloudflared] querying ${LATEST_API}`);
    // CI runners share an IP and blow through the 60 req/h anonymous
    // limit on api.github.com. Send the auto-injected GITHUB_TOKEN when
    // present to lift the limit to 5000/h.
    const ghHeaders = { "User-Agent": "mmo-companion-build", accept: "application/vnd.github+json" };
    if (process.env.GITHUB_TOKEN) ghHeaders.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    const metaRes = await fetch(LATEST_API, { headers: ghHeaders });
    if (!metaRes.ok) {
        const body = await metaRes.text().catch(() => "");
        throw new Error(`GitHub API ${metaRes.status}: ${body.slice(0, 300)}`);
    }
    const meta = await metaRes.json();
    if (!Array.isArray(meta.assets)) {
        throw new Error(`Unexpected GitHub API response (no assets array): ${JSON.stringify(meta).slice(0, 300)}`);
    }
    const asset = meta.assets.find((a) => a.name === assetName);
    if (!asset) {
        const names = meta.assets.map((a) => a.name).join(", ");
        throw new Error(`Asset ${assetName} not found in ${meta.tag_name ?? "latest"} release. Available: ${names}`);
    }
    const url = asset.browser_download_url;
    console.log(`[fetch-cloudflared] downloading ${url}`);

    const dl = await fetch(url, { headers: { "User-Agent": "mmo-companion-build" } });
    if (!dl.ok || !dl.body) throw new Error(`Download failed: HTTP ${dl.status}`);

    if (assetName.endsWith(".tgz")) {
        // macOS ships as a .tgz containing a single `cloudflared` binary.
        const tmp = path.join(OUT_DIR, "cloudflared.tgz");
        await pipeline(dl.body, createWriteStream(tmp));
        const { execSync } = await import("node:child_process");
        execSync(`tar -xzf "${tmp}" -C "${OUT_DIR}"`);
        await fs.unlink(tmp);
    } else {
        await pipeline(dl.body, createWriteStream(outFile));
        if (platform !== "win32") {
            await fs.chmod(outFile, 0o755);
        }
    }
    console.log(`[fetch-cloudflared] wrote ${outFile}`);
}

main().catch((err) => {
    console.error("[fetch-cloudflared] failed:", err);
    process.exit(1);
});
