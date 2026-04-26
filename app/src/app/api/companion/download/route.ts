/**
 * /api/companion/download
 *
 * Resolves the latest MMO Companion release on GitHub and 302-redirects
 * the browser to the appropriate installer for its detected OS.
 *
 * Query params:
 *   ?os=auto|win|mac|linux   (default: auto, sniffed from User-Agent)
 *   ?arch=x64|arm64           (default: x64, mac auto-prefers arm64 if UA hints Apple Silicon)
 *
 * The companion is built and uploaded by the
 * `.github/workflows/companion-release.yml` workflow on tag pushes
 * (companion-v*). This route reads `releases/latest` filtered by
 * tag prefix `companion-v` so it doesn't get confused by other release
 * tags in the same repo.
 *
 * Caching: GitHub's API is rate-limited per IP (60/h unauth). We cache
 * the resolved release URLs for 5 minutes in-memory. This still gives
 * good freshness (release just dropped → users get it within 5 min)
 * without hammering the API.
 */

import { NextRequest, NextResponse } from "next/server";

const REPO_OWNER = process.env.COMPANION_REPO_OWNER ?? "dragoscv";
const REPO_NAME = process.env.COMPANION_REPO_NAME ?? "rekordbox-mwrty";
// electron-builder creates releases tagged with the bare version ("v0.3.0")
// based on package.json#version, ignoring any custom git tag we push. So we
// match the simple "v" prefix; no other release tags exist on this repo.
const TAG_PREFIX = "v";

interface GhReleaseAsset {
    name: string;
    browser_download_url: string;
    size: number;
    content_type: string;
}
interface GhRelease {
    tag_name: string;
    name: string;
    html_url: string;
    assets: GhReleaseAsset[];
    published_at: string;
    prerelease: boolean;
    draft: boolean;
}

type Os = "win" | "mac" | "linux";
type Arch = "x64" | "arm64";

interface ResolvedAsset {
    os: Os;
    arch: Arch;
    name: string;
    url: string;
    size: number;
    version: string;
    releaseUrl: string;
}

// ── Tiny in-memory cache (per-server-process) ─────────────────────────────
let cachedAt = 0;
let cachedRelease: GhRelease | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000;

async function fetchLatestCompanionRelease(): Promise<GhRelease | null> {
    if (cachedRelease && Date.now() - cachedAt < CACHE_TTL_MS) {
        return cachedRelease;
    }

    // GitHub's `/releases/latest` returns the most-recent NON-prerelease
    // release across the entire repo, which can include unrelated tags.
    // We instead list releases and pick the newest one whose tag starts
    // with `companion-v`. Up to 30 fits in one page, plenty for our cadence.
    const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases?per_page=30`;
    const headers: HeadersInit = {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    };
    if (process.env.GITHUB_TOKEN) {
        headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    }

    let res: Response;
    try {
        res = await fetch(url, { headers, cache: "no-store" });
    } catch (err) {
        console.error("[companion/download] GitHub fetch failed", err);
        return cachedRelease; // serve stale on network error
    }
    if (!res.ok) {
        console.error("[companion/download] GitHub responded", res.status, await res.text().catch(() => ""));
        return cachedRelease;
    }

    const list = (await res.json()) as GhRelease[];
    const found = list
        .filter(
            (r) =>
                !r.draft &&
                !r.prerelease &&
                r.tag_name.startsWith(TAG_PREFIX) &&
                // exclude unrelated tags (e.g. internal release tags from
                // other components) by requiring at least one expected asset.
                r.assets.some((a) =>
                    /\.(exe|dmg|appimage|deb)$/i.test(a.name),
                ),
        )
        .sort((a, b) => b.published_at.localeCompare(a.published_at))[0];

    if (found) {
        cachedRelease = found;
        cachedAt = Date.now();
    }
    return found ?? null;
}

function detectOsFromUA(ua: string): Os {
    const u = ua.toLowerCase();
    if (u.includes("mac os x") || u.includes("macintosh") || u.includes("darwin")) return "mac";
    if (u.includes("linux") && !u.includes("android")) return "linux";
    return "win"; // default: Windows (most common)
}

function detectArchFromUA(ua: string, os: Os): Arch {
    if (os !== "mac") return "x64";
    // Apple Silicon UA strings still report "Intel Mac OS X" for backwards
    // compatibility, so this is heuristic at best. UA-Client-Hints expose the
    // real arch but only over HTTPS+secure context; we fall back to x64
    // (Intel + Rosetta) which works on Apple Silicon too.
    if (/apple\s?silicon|arm64/i.test(ua)) return "arm64";
    return "x64";
}

function pickAsset(release: GhRelease, os: Os, arch: Arch): ResolvedAsset | null {
    const version = release.tag_name.replace(/^v/, "");

    // Filename heuristics for our electron-builder config:
    //   MMO-Companion-Setup-X.Y.Z.exe          (Windows NSIS, x64)
    //   MMO-Companion-X.Y.Z-x64.dmg            (macOS Intel)
    //   MMO-Companion-X.Y.Z-arm64.dmg          (macOS Apple Silicon)
    //   MMO-Companion-X.Y.Z-x64.zip            (macOS Intel auto-update)
    //   MMO-Companion-X.Y.Z-arm64.zip          (macOS Apple Silicon auto-update)
    //   MMO-Companion-X.Y.Z.AppImage           (Linux)
    //   mmo-companion_X.Y.Z_amd64.deb          (Linux .deb)
    const matchers: Record<Os, (name: string) => boolean> = {
        win: (n) => n.toLowerCase().endsWith(".exe"),
        mac: (n) => {
            if (!n.toLowerCase().endsWith(".dmg")) return false;
            const isArm = /arm64/i.test(n);
            const isX64 = /(?<![a-z])x64(?![a-z])/i.test(n);
            if (arch === "arm64") return isArm;
            // For Intel: prefer files explicitly tagged x64; fall back to
            // anything not arm64 (handles older builds without arch suffix).
            return isX64 || !isArm;
        },
        linux: (n) => /\.(appimage|deb)$/i.test(n),
    };

    const matcher = matchers[os];
    let asset = release.assets.find((a) => matcher(a.name));
    if (!asset && os === "mac") {
        // Final fallback: any .dmg in the release.
        asset = release.assets.find((a) => /\.dmg$/i.test(a.name));
    }
    if (!asset) return null;

    return {
        os,
        arch,
        name: asset.name,
        url: asset.browser_download_url,
        size: asset.size,
        version,
        releaseUrl: release.html_url,
    };
}

export async function GET(req: NextRequest) {
    const sp = req.nextUrl.searchParams;
    const ua = req.headers.get("user-agent") ?? "";
    const osParam = (sp.get("os") ?? "auto").toLowerCase();
    const archParam = (sp.get("arch") ?? "auto").toLowerCase();
    const wantInfo = sp.get("info") === "1";

    const os: Os =
        osParam === "win" || osParam === "mac" || osParam === "linux"
            ? osParam
            : detectOsFromUA(ua);

    const arch: Arch =
        archParam === "x64" || archParam === "arm64"
            ? (archParam as Arch)
            : detectArchFromUA(ua, os);

    const release = await fetchLatestCompanionRelease();
    if (!release) {
        return NextResponse.json(
            { error: "No companion release available yet." },
            { status: 503 },
        );
    }

    const resolved = pickAsset(release, os, arch);
    if (!resolved) {
        return NextResponse.json(
            {
                error: `No installer available for os=${os} arch=${arch}.`,
                releaseUrl: release.html_url,
                version: release.tag_name.replace(/^v/, ""),
            },
            { status: 404 },
        );
    }

    if (wantInfo) {
        // JSON metadata mode — used by the sidebar component to render the
        // version + size before the user clicks.
        return NextResponse.json(resolved, {
            headers: { "Cache-Control": "public, max-age=300" },
        });
    }

    // 302 redirect to the GitHub asset CDN URL.
    return NextResponse.redirect(resolved.url, { status: 302 });
}
