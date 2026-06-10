"use client";

/**
 * Download Hub — single button in the sidebar that opens a modal showing
 * every way to get MMO on the user's machine / phone / browser:
 *
 *   - MMO Companion (Win/Mac/Linux installers; local audio server)
 *   - MMO Native desktop (Win/Mac/Linux Tauri shell)
 *   - MMO Native mobile (iOS / Android Capacitor shell)
 *   - MMO Browser Extension (Chrome / Firefox / Edge)
 *
 * Detection layers (best-effort, fall back gracefully):
 *   - OS         → User-Agent + UA-Client-Hints when available.
 *   - Browser    → User-Agent string.
 *   - Companion  → loopback probe via `discoverCompanion()`.
 *   - Extension  → looks for a `<meta name="mmo-extension">` tag the
 *                  content script injects on muzicai.ro pages.
 *
 * Recommended-for-you highlight: green ring + "Recommended" badge on
 * the row that best matches the detected platform.
 */

import { useEffect, useMemo, useState } from "react";
import {
    Download,
    Loader2,
    Apple,
    Smartphone,
    Globe,
    Cpu,
    Package,
    CheckCircle2,
    ExternalLink,
    AlertCircle,
} from "lucide-react";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useCompanionStatus } from "@/components/companion/companion-status-provider";

// ── Types mirroring /api/downloads/manifest ────────────────────────────
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
interface Manifest {
    channels: {
        companion: Channel;
        native: Channel;
        extension: Channel;
    };
    extensionStores: {
        chrome: string;
        firefox: string;
        edge: string;
    };
    mobileStores: {
        appStore: string | null;
        playStore: string | null;
        testFlight: string | null;
    };
}

type OsId = "win" | "mac" | "linux" | "android" | "ios";
type BrowserId = "chrome" | "firefox" | "edge" | "safari" | "other";

interface Env {
    os: OsId;
    arch: "x64" | "arm64" | "unknown";
    browser: BrowserId;
    isMobile: boolean;
}

function detectEnv(): Env {
    if (typeof navigator === "undefined") {
        return { os: "win", arch: "x64", browser: "other", isMobile: false };
    }
    const ua = navigator.userAgent;
    const l = ua.toLowerCase();
    let os: OsId;
    let isMobile = false;
    if (/android/i.test(ua)) {
        os = "android";
        isMobile = true;
    } else if (/iphone|ipad|ipod/i.test(ua)) {
        os = "ios";
        isMobile = true;
    } else if (/mac/i.test(ua) && !/iphone|ipad/i.test(ua)) {
        os = "mac";
    } else if (/linux/i.test(ua)) {
        os = "linux";
    } else {
        os = "win";
    }

    let arch: Env["arch"] = "unknown";
    if (os === "win" || os === "linux") arch = "x64";
    if (os === "mac")
        arch = /arm64|apple\s?silicon/i.test(ua) ? "arm64" : "x64";

    let browser: BrowserId = "other";
    if (l.includes("edg/") || l.includes("edge/")) browser = "edge";
    else if (l.includes("firefox") || l.includes("fxios")) browser = "firefox";
    else if (l.includes("chrome") || l.includes("crios")) browser = "chrome";
    else if (l.includes("safari")) browser = "safari";

    return { os, arch, browser, isMobile };
}

function osLabel(os: OsId): string {
    switch (os) {
        case "win":
            return "Windows";
        case "mac":
            return "macOS";
        case "linux":
            return "Linux";
        case "android":
            return "Android";
        case "ios":
            return "iOS";
    }
}

function formatSize(bytes: number): string {
    if (!bytes) return "—";
    if (bytes >= 1024 * 1024 * 1024)
        return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
    if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
    return `${(bytes / 1024).toFixed(0)} KB`;
}

function findExtensionMarker(): string | null {
    if (typeof document === "undefined") return null;
    const meta = document.querySelector('meta[name="mmo-extension"]');
    return meta?.getAttribute("content") ?? null;
}

// ── Main component ─────────────────────────────────────────────────────
export function DownloadHubButton({ collapsed = false }: { collapsed?: boolean }) {
    const [open, setOpen] = useState(false);
    const [manifest, setManifest] = useState<Manifest | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const [env, setEnv] = useState<Env | null>(null);
    const companion = useCompanionStatus();
    // Derive companion presence from the shared status — replaces the
    // per-mount discovery probe that fired on every page navigation.
    const companionPresent: boolean | "checking" =
        companion.status === "online" ? true
            : companion.status === "offline" ? false
                : "checking";
    const [extensionPresent, setExtensionPresent] = useState<
        string | null | "checking"
    >("checking");

    // First-mount: detect env + extension marker. Companion presence is
    // sourced from <CompanionStatusProvider> so we no longer probe here.
    useEffect(() => {
        setEnv(detectEnv());
        setExtensionPresent(findExtensionMarker());
    }, []);

    // Lazy-load the manifest only when the modal opens for the first time.
    useEffect(() => {
        if (!open || manifest || loading) return;
        setLoading(true);
        setError(null);
        fetch("/api/downloads/manifest", { cache: "no-store" })
            .then(async (r) => {
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                return r.json();
            })
            .then((j: Manifest) => setManifest(j))
            .catch((e) =>
                setError(e instanceof Error ? e.message : "fetch failed")
            )
            .finally(() => setLoading(false));
    }, [open, manifest, loading]);

    const recommendedTab = useMemo<
        "desktop" | "extension" | "mobile" | "companion"
    >(() => {
        if (!env) return "desktop";
        if (env.isMobile) return "mobile";
        if (companionPresent === false && extensionPresent === null)
            return "extension"; // user has nothing → start with the lightest option
        return "desktop";
    }, [env, companionPresent, extensionPresent]);

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
                {collapsed ? (
                    <button
                        type="button"
                        className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors relative"
                        title="Download MMO apps & extensions"
                    >
                        <Download className="h-4 w-4" />
                        {companionPresent === true && (
                            <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-emerald-500" />
                        )}
                    </button>
                ) : (
                    <button
                        type="button"
                        className="flex items-center gap-2 w-full rounded-md border border-sidebar-border bg-sidebar px-2 py-1.5 text-[11px] text-sidebar-foreground hover:bg-muted transition-colors"
                    >
                        <Download className="h-3.5 w-3.5" />
                        <span className="flex-1 truncate text-left">
                            Get MMO apps
                        </span>
                        {(companionPresent === true ||
                            extensionPresent !== null) && (
                            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                        )}
                    </button>
                )}
            </DialogTrigger>

            <DialogContent className="max-w-3xl">
                <DialogHeader>
                    <DialogTitle>Get MMO everywhere</DialogTitle>
                    <DialogDescription>
                        Native apps, browser extension, and the local companion
                        server. Pick what fits your setup; everything works
                        against the same muzicai.ro account.
                    </DialogDescription>
                </DialogHeader>

                {/* Presence summary strip */}
                {env && (
                    <div className="flex flex-wrap gap-2 text-[11px] -mt-1">
                        <Badge variant="outline" className="gap-1.5">
                            <Cpu className="h-3 w-3" />
                            Detected: {osLabel(env.os)}
                            {env.arch !== "unknown" && ` · ${env.arch}`} ·{" "}
                            {env.browser}
                        </Badge>
                        <PresenceBadge
                            label="Companion"
                            present={companionPresent}
                            okText="Running"
                            missingText="Not detected"
                        />
                        <PresenceBadge
                            label="Extension"
                            present={
                                extensionPresent === "checking"
                                    ? "checking"
                                    : extensionPresent !== null
                            }
                            okText={
                                typeof extensionPresent === "string"
                                    ? `v${extensionPresent}`
                                    : "Installed"
                            }
                            missingText="Not installed"
                        />
                    </div>
                )}

                {loading && (
                    <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin mr-2" />
                        Loading download manifest…
                    </div>
                )}
                {error && (
                    <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
                        <AlertCircle className="h-4 w-4 mt-px shrink-0" />
                        <div>
                            <p className="font-medium">
                                Couldn&apos;t load the download manifest
                            </p>
                            <p className="text-destructive/80 mt-0.5">{error}</p>
                            <p className="text-destructive/70 mt-1">
                                You can still browse releases on{" "}
                                <a
                                    className="underline"
                                    href="https://github.com/dragoscv/mmo/releases"
                                    target="_blank"
                                    rel="noreferrer"
                                >
                                    GitHub
                                </a>
                                .
                            </p>
                        </div>
                    </div>
                )}

                {manifest && env && (
                    <Tabs defaultValue={recommendedTab} className="mt-2">
                        <TabsList className="grid grid-cols-4 w-full">
                            <TabsTrigger value="desktop">
                                <Package className="h-3.5 w-3.5 mr-1.5" />
                                Desktop
                            </TabsTrigger>
                            <TabsTrigger value="mobile">
                                <Smartphone className="h-3.5 w-3.5 mr-1.5" />
                                Mobile
                            </TabsTrigger>
                            <TabsTrigger value="extension">
                                <Globe className="h-3.5 w-3.5 mr-1.5" />
                                Extension
                            </TabsTrigger>
                            <TabsTrigger value="companion">
                                <Cpu className="h-3.5 w-3.5 mr-1.5" />
                                Companion
                            </TabsTrigger>
                        </TabsList>

                        <TabsContent value="desktop">
                            <ChannelSection
                                channel={manifest.channels.native}
                                env={env}
                                osFilter={(o) =>
                                    o === "win" || o === "mac" || o === "linux"
                                }
                                emptyHint="The native desktop app hasn't shipped a release yet. The web app at muzicai.ro works in any browser in the meantime."
                            />
                        </TabsContent>

                        <TabsContent value="mobile">
                            <MobileSection
                                channel={manifest.channels.native}
                                stores={manifest.mobileStores}
                                env={env}
                            />
                        </TabsContent>

                        <TabsContent value="extension">
                            <ExtensionSection
                                channel={manifest.channels.extension}
                                stores={manifest.extensionStores}
                                env={env}
                                installed={
                                    typeof extensionPresent === "string"
                                        ? extensionPresent
                                        : null
                                }
                            />
                        </TabsContent>

                        <TabsContent value="companion">
                            <ChannelSection
                                channel={manifest.channels.companion}
                                env={env}
                                osFilter={(o) =>
                                    o === "win" || o === "mac" || o === "linux"
                                }
                                emptyHint="No companion release available yet."
                                running={companionPresent === true}
                            />
                        </TabsContent>
                    </Tabs>
                )}
            </DialogContent>
        </Dialog>
    );
}

// ── Sub-components ─────────────────────────────────────────────────────

function PresenceBadge({
    label,
    present,
    okText,
    missingText,
}: {
    label: string;
    present: boolean | "checking";
    okText: string;
    missingText: string;
}) {
    if (present === "checking") {
        return (
            <Badge variant="outline" className="gap-1.5">
                <Loader2 className="h-3 w-3 animate-spin" />
                {label}…
            </Badge>
        );
    }
    return (
        <Badge
            variant="outline"
            className={cn(
                "gap-1.5",
                present
                    ? "border-emerald-500/40 text-emerald-400 bg-emerald-500/5"
                    : "border-muted-foreground/20 text-muted-foreground"
            )}
        >
            {present ? (
                <CheckCircle2 className="h-3 w-3" />
            ) : (
                <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40" />
            )}
            {label}: {present ? okText : missingText}
        </Badge>
    );
}

function ChannelSection({
    channel,
    env,
    osFilter,
    emptyHint,
    running,
}: {
    channel: Channel;
    env: Env;
    osFilter: (os: PlatformAsset["os"]) => boolean;
    emptyHint: string;
    running?: boolean;
}) {
    const assets = channel.assets.filter((a) => osFilter(a.os));
    if (assets.length === 0) {
        return (
            <div className="text-sm text-muted-foreground py-6 px-2">
                {emptyHint}
            </div>
        );
    }
    return (
        <div className="space-y-3 mt-3">
            {running && (
                <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-400 flex items-center gap-2">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    The companion is already running on this machine. You only
                    need to reinstall to update.
                </div>
            )}
            <div className="text-[11px] text-muted-foreground flex items-center gap-2">
                <span>
                    Latest: <strong>v{channel.version}</strong>
                </span>
                {channel.releaseUrl && (
                    <a
                        className="underline hover:text-foreground inline-flex items-center gap-1"
                        href={channel.releaseUrl}
                        target="_blank"
                        rel="noreferrer"
                    >
                        Release notes <ExternalLink className="h-2.5 w-2.5" />
                    </a>
                )}
            </div>
            <ul className="space-y-1.5">
                {assets.map((a) => {
                    const recommended =
                        a.os === env.os &&
                        (!a.arch || a.arch === env.arch || env.arch === "unknown");
                    return (
                        <AssetRow
                            key={a.url}
                            asset={a}
                            recommended={recommended}
                        />
                    );
                })}
            </ul>
        </div>
    );
}

function MobileSection({
    channel,
    stores,
    env,
}: {
    channel: Channel;
    stores: Manifest["mobileStores"];
    env: Env;
}) {
    const apks = channel.assets.filter((a) => a.os === "android");
    const ipas = channel.assets.filter((a) => a.os === "ios");

    return (
        <div className="space-y-4 mt-3">
            <StoreCard
                title="iOS"
                Icon={Apple}
                recommended={env.os === "ios"}
                primary={
                    stores.appStore
                        ? { label: "App Store", url: stores.appStore }
                        : null
                }
                secondary={
                    stores.testFlight
                        ? { label: "TestFlight (beta)", url: stores.testFlight }
                        : null
                }
                directDownloads={ipas}
                hint={
                    !stores.appStore && !stores.testFlight && ipas.length === 0
                        ? "iOS distribution requires an Apple Developer account; no public build is available yet."
                        : !stores.appStore && !stores.testFlight
                          ? "An unsigned .ipa is available below for sideloading via Xcode."
                          : null
                }
            />
            <StoreCard
                title="Android"
                Icon={Smartphone}
                recommended={env.os === "android"}
                primary={
                    stores.playStore
                        ? { label: "Google Play", url: stores.playStore }
                        : null
                }
                secondary={null}
                directDownloads={apks}
                hint={
                    !stores.playStore && apks.length === 0
                        ? "No Android build available yet."
                        : !stores.playStore
                          ? "Sideload the APK below. You'll need to allow installs from your browser the first time."
                          : null
                }
            />
        </div>
    );
}

function ExtensionSection({
    channel,
    stores,
    env,
    installed,
}: {
    channel: Channel;
    stores: Manifest["extensionStores"];
    env: Env;
    installed: string | null;
}) {
    type StoreRow = {
        id: BrowserId;
        label: string;
        url: string;
    };
    const rows: StoreRow[] = [
        { id: "chrome", label: "Chrome Web Store", url: stores.chrome },
        { id: "firefox", label: "Firefox Add-ons", url: stores.firefox },
        { id: "edge", label: "Edge Add-ons", url: stores.edge },
    ];

    const zipAsset = channel.assets.find((a) =>
        /\.zip$/i.test(a.filename) || /extension/i.test(a.filename)
    );

    return (
        <div className="space-y-3 mt-3">
            {installed && (
                <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-400 flex items-center gap-2">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    Extension v{installed} is already installed in this browser.
                </div>
            )}
            <p className="text-xs text-muted-foreground">
                Lets you download audio from YouTube, SoundCloud, Bandcamp,
                Mixcloud, and 10+ other platforms directly into your MMO
                library.
            </p>
            <ul className="space-y-1.5">
                {rows.map((r) => {
                    const recommended =
                        (r.id === "chrome" && env.browser === "chrome") ||
                        (r.id === "firefox" && env.browser === "firefox") ||
                        (r.id === "edge" && env.browser === "edge");
                    return (
                        <li key={r.id}>
                            <a
                                href={r.url}
                                target="_blank"
                                rel="noreferrer"
                                className={cn(
                                    "flex items-center gap-3 rounded-md border px-3 py-2 text-sm hover:bg-muted transition-colors",
                                    recommended
                                        ? "border-emerald-500/40 bg-emerald-500/5"
                                        : "border-border"
                                )}
                            >
                                <Globe className="h-4 w-4 shrink-0" />
                                <span className="flex-1">{r.label}</span>
                                {recommended && (
                                    <Badge
                                        variant="outline"
                                        className="border-emerald-500/40 text-emerald-400 text-[10px]"
                                    >
                                        Recommended
                                    </Badge>
                                )}
                                <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
                            </a>
                        </li>
                    );
                })}
            </ul>
            {zipAsset && (
                <div className="border-t border-border pt-3 mt-3">
                    <p className="text-[11px] text-muted-foreground mb-2">
                        Power users: load the unpacked extension from a .zip
                        instead.
                    </p>
                    <AssetRow asset={zipAsset} recommended={false} />
                </div>
            )}
        </div>
    );
}

function StoreCard({
    title,
    Icon,
    recommended,
    primary,
    secondary,
    directDownloads,
    hint,
}: {
    title: string;
    Icon: typeof Apple;
    recommended: boolean;
    primary: { label: string; url: string } | null;
    secondary: { label: string; url: string } | null;
    directDownloads: PlatformAsset[];
    hint: string | null;
}) {
    return (
        <div
            className={cn(
                "rounded-md border p-3 space-y-2",
                recommended
                    ? "border-emerald-500/40 bg-emerald-500/5"
                    : "border-border"
            )}
        >
            <div className="flex items-center gap-2">
                <Icon className="h-4 w-4" />
                <h3 className="text-sm font-medium">{title}</h3>
                {recommended && (
                    <Badge
                        variant="outline"
                        className="border-emerald-500/40 text-emerald-400 text-[10px]"
                    >
                        Recommended for you
                    </Badge>
                )}
            </div>
            {hint && (
                <p className="text-[11px] text-muted-foreground">{hint}</p>
            )}
            <div className="flex flex-wrap gap-2">
                {primary && (
                    <Button asChild size="sm">
                        <a href={primary.url} target="_blank" rel="noreferrer">
                            {primary.label}{" "}
                            <ExternalLink className="h-3 w-3 ml-1.5" />
                        </a>
                    </Button>
                )}
                {secondary && (
                    <Button asChild size="sm" variant="outline">
                        <a href={secondary.url} target="_blank" rel="noreferrer">
                            {secondary.label}{" "}
                            <ExternalLink className="h-3 w-3 ml-1.5" />
                        </a>
                    </Button>
                )}
            </div>
            {directDownloads.length > 0 && (
                <ul className="space-y-1 pt-1">
                    {directDownloads.map((a) => (
                        <AssetRow key={a.url} asset={a} recommended={false} />
                    ))}
                </ul>
            )}
        </div>
    );
}

function AssetRow({
    asset,
    recommended,
}: {
    asset: PlatformAsset;
    recommended: boolean;
}) {
    return (
        <li>
            <a
                href={asset.url}
                target="_blank"
                rel="noreferrer"
                className={cn(
                    "flex items-center gap-3 rounded-md border px-3 py-2 text-sm hover:bg-muted transition-colors",
                    recommended
                        ? "border-emerald-500/40 bg-emerald-500/5"
                        : "border-border"
                )}
            >
                <Download className="h-3.5 w-3.5 shrink-0" />
                <span className="flex-1 min-w-0">
                    <span className="block truncate">{asset.label}</span>
                    <span className="block truncate text-[10px] text-muted-foreground/70">
                        {asset.filename}
                    </span>
                </span>
                <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">
                    {formatSize(asset.sizeBytes)}
                </span>
                {recommended && (
                    <Badge
                        variant="outline"
                        className="border-emerald-500/40 text-emerald-400 text-[10px] shrink-0"
                    >
                        Recommended
                    </Badge>
                )}
            </a>
        </li>
    );
}
