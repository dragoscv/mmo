/**
 * /api/downloads/manifest
 *
 * Single endpoint that the Download Hub UI calls to render the modal:
 * everything that can be installed alongside the web app, grouped by
 * channel and platform, with direct download URLs.
 *
 * Sources:
 *   - Companion: latest GitHub release whose tag starts with `v` and that
 *     ships .exe/.dmg/.AppImage/.deb/.rpm assets.
 *   - Browser extension: latest release whose tag starts with `extension-v`.
 *   - Native shells: latest release whose tag starts with `native-v`.
 *   - Extension store URLs: static (no API call needed).
 *
 * Caching: 5 min in-memory across all release lookups. The same GH-token
 * env var the companion endpoint uses is honored here so authenticated
 * builds get the higher rate limit.
 */

import { NextResponse } from "next/server";

const REPO_OWNER = process.env.COMPANION_REPO_OWNER ?? "dragoscv";
const REPO_NAME = process.env.COMPANION_REPO_NAME ?? "mmo";
const CACHE_TTL_MS = 5 * 60 * 1000;

export const dynamic = "force-dynamic";

interface GhAsset {
    name: string;
    browser_download_url: string;
    size: number;
}
interface GhRelease {
    tag_name: string;
    html_url: string;
    assets: GhAsset[];
    published_at: string;
    prerelease: boolean;
    draft: boolean;
}

interface CachedReleases {
    at: number;
    list: GhRelease[];
}
let cache: CachedReleases | null = null;

async function fetchReleases(): Promise<GhRelease[]> {
    if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.list;

    const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases?per_page=50`;
    const headers: HeadersInit = {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    };
    if (process.env.GITHUB_TOKEN)
        headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

    try {
        const res = await fetch(url, { headers, cache: "no-store" });
        if (!res.ok) return cache?.list ?? [];
        const list = (await res.json()) as GhRelease[];
        cache = { at: Date.now(), list };
        return list;
    } catch {
        return cache?.list ?? [];
    }
}

interface PlatformAsset {
    os: "win" | "mac" | "linux" | "android" | "ios";
    arch?: "x64" | "arm64" | "universal";
    label: string;
    filename: string;
    url: string;
    sizeBytes: number;
    format: string;
}
interface Channel {
    id: "companion" | "native" | "extension";
    name: string;
    version: string | null;
    releaseUrl: string | null;
    publishedAt: string | null;
    assets: PlatformAsset[];
}

function classifyAsset(name: string): PlatformAsset | null {
    const lower = name.toLowerCase();
    const fmt = (ext: string) => ext;

    // Native Tauri
    if (lower.endsWith(".msi"))
        return platform("win", "x64", "Windows installer", name, fmt("msi"));
    if (lower.endsWith(".exe"))
        return platform(
            "win",
            "x64",
            "Windows installer (NSIS)",
            name,
            fmt("exe")
        );
    if (lower.endsWith(".dmg")) {
        const arch = /arm64/i.test(name) ? "arm64" : "x64";
        return platform(
            "mac",
            arch,
            arch === "arm64" ? "macOS (Apple Silicon)" : "macOS (Intel)",
            name,
            fmt("dmg")
        );
    }
    if (lower.endsWith(".app.tar.gz"))
        return platform("mac", undefined, "macOS portable", name, fmt("tar.gz"));
    if (lower.endsWith(".appimage"))
        return platform("linux", "x64", "Linux AppImage", name, fmt("AppImage"));
    if (lower.endsWith(".deb"))
        return platform("linux", "x64", "Linux .deb", name, fmt("deb"));
    if (lower.endsWith(".rpm"))
        return platform("linux", "x64", "Linux .rpm", name, fmt("rpm"));
    if (lower.endsWith(".apk"))
        return platform("android", undefined, "Android APK", name, fmt("apk"));
    if (lower.endsWith(".aab"))
        return platform(
            "android",
            undefined,
            "Android App Bundle",
            name,
            fmt("aab")
        );
    if (lower.endsWith(".ipa"))
        return platform("ios", undefined, "iOS IPA", name, fmt("ipa"));
    if (lower.endsWith(".zip") && /mac|darwin/i.test(name)) {
        const arch = /arm64/i.test(name) ? "arm64" : "x64";
        return platform(
            "mac",
            arch,
            `macOS auto-update (${arch})`,
            name,
            fmt("zip")
        );
    }
    return null;
}

function platform(
    os: PlatformAsset["os"],
    arch: PlatformAsset["arch"] | undefined,
    label: string,
    name: string,
    format: string
): PlatformAsset {
    return {
        os,
        arch,
        label,
        filename: name,
        url: "", // filled in by caller
        sizeBytes: 0,
        format,
    };
}

function buildChannel(
    id: Channel["id"],
    name: string,
    releases: GhRelease[],
    tagPattern: RegExp,
    assetGuard?: (asset: GhAsset) => boolean
): Channel {
    const found = releases
        .filter(
            (r) =>
                !r.draft &&
                !r.prerelease &&
                tagPattern.test(r.tag_name) &&
                (!assetGuard || r.assets.some(assetGuard))
        )
        .sort((a, b) => b.published_at.localeCompare(a.published_at))[0];

    if (!found)
        return {
            id,
            name,
            version: null,
            releaseUrl: null,
            publishedAt: null,
            assets: [],
        };

    const assets: PlatformAsset[] = [];
    for (const a of found.assets) {
        const meta = classifyAsset(a.name);
        if (!meta) continue;
        assets.push({
            ...meta,
            url: a.browser_download_url,
            sizeBytes: a.size,
        });
    }

    return {
        id,
        name,
        version: found.tag_name.replace(/^(companion-|native-|extension-)?v/, ""),
        releaseUrl: found.html_url,
        publishedAt: found.published_at,
        assets,
    };
}

export async function GET() {
    const releases = await fetchReleases();

    // Companion: bare `v0.9.12`-style tags (electron-builder convention),
    // and we require at least one electron-style installer asset so we
    // don't grab a tag that belongs to a different component.
    const companion = buildChannel(
        "companion",
        "MMO Companion (local audio server)",
        releases,
        /^v\d/,
        (a) => /\.(exe|dmg|appimage|deb|rpm)$/i.test(a.name)
    );

    const native = buildChannel(
        "native",
        "MMO Native (desktop + mobile)",
        releases,
        /^native-v/
    );

    const extension = buildChannel(
        "extension",
        "MMO Browser Extension",
        releases,
        /^extension-v/
    );

    // Web-store URLs are stable; we expose them even when there's no
    // GitHub release for the extension yet so the modal always has
    // somewhere to send users.
    const extensionStores = {
        chrome:
            process.env.NEXT_PUBLIC_CHROME_EXTENSION_URL ||
            "https://chromewebstore.google.com/search/mmo%20muzicai",
        firefox:
            process.env.NEXT_PUBLIC_FIREFOX_EXTENSION_URL ||
            "https://addons.mozilla.org/firefox/search/?q=mmo+muzicai",
        edge:
            process.env.NEXT_PUBLIC_EDGE_EXTENSION_URL ||
            "https://microsoftedge.microsoft.com/addons/search/mmo%20muzicai",
    };

    const mobileStores = {
        appStore:
            process.env.NEXT_PUBLIC_APP_STORE_URL ||
            null,
        playStore:
            process.env.NEXT_PUBLIC_PLAY_STORE_URL ||
            null,
        testFlight:
            process.env.NEXT_PUBLIC_TESTFLIGHT_URL ||
            null,
    };

    return NextResponse.json(
        {
            channels: { companion, native, extension },
            extensionStores,
            mobileStores,
            generatedAt: new Date().toISOString(),
        },
        {
            headers: {
                "cache-control":
                    "public, max-age=60, stale-while-revalidate=300",
            },
        }
    );
}
