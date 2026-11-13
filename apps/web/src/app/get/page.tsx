import type { Metadata } from "next";
import Link from "next/link";
import { BrandLockup, BrandMark } from "@mmo/ui";

/**
 * Public /get landing page (formerly /downloads; redirected in next.config.ts).
 *
 * Auth-free entry point for sharing direct download links (MixAI Server,
 * native shells, MixAI Connector, app stores). Mirrors the in-app
 * Download Hub modal content but optimised for SEO and unauthenticated
 * visitors who land here from external links or search results.
 *
 * Caching: the manifest `fetch` below is cached for 5 min through the
 * Data Cache (`next: { revalidate: 300 }`), so the GH API is hit at most
 * once per 5 min regardless of traffic. The previous implementation read
 * `headers()` to compute its own origin, which opted the render out of
 * every cache and re-fetched the manifest on every request; the origin is
 * now derived from `AUTH_URL` (falls back to the canonical mixai.ro).
 *
 * The HTML itself still renders dynamically (ƒ) because the ROOT layout
 * reads the `mmo-locale` cookie via `getLocale()` — that applies to every
 * route in the app and is out of scope here (see
 * docs/followups/web-bundle-report.md). `revalidate` is kept so the page
 * flips to ISR automatically once the layout stops reading cookies.
 */

export const revalidate = 300;

const SELF_ORIGIN = (process.env.AUTH_URL ?? process.env.NEXTAUTH_URL ?? "https://mixai.ro").replace(/\/$/, "");

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
    id: "companion" | "native" | "extension" | "music";
    name: string;
    version: string | null;
    releaseUrl: string | null;
    publishedAt: string | null;
    assets: PlatformAsset[];
}
interface Manifest {
    channels: { companion: Channel; native: Channel; extension: Channel; music?: Channel };
    extensionStores: { chrome: string; firefox: string; edge: string };
    mobileStores: {
        appStore: string | null;
        playStore: string | null;
        testFlight: string | null;
    };
    generatedAt: string;
}

export const metadata: Metadata = {
    title: { absolute: "Descarcă MixAI · MixAI Server, aplicații native, MixAI Connector" },
    description:
        "Descarcă MixAI — suita muzicală AI pentru Windows, macOS, Linux, Android și iOS. MixAI Server, build-uri native și MixAI Connector pentru Chrome, Firefox și Edge.",
    alternates: { canonical: "https://mixai.ro/get" },
    openGraph: {
        title: "Descarcă MixAI",
        description:
            "Aplicații desktop, mobile și extensii browser pentru organizarea muzicii — gratuit, open source.",
        url: "https://mixai.ro/get",
        siteName: "MixAI",
        type: "website",
        images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "MixAI" }],
    },
    twitter: {
        card: "summary_large_image",
        title: "Descarcă MixAI",
        description:
            "Aplicații desktop, mobile și extensii browser pentru organizarea muzicii.",
        images: ["/og-image.png"],
    },
};

async function getManifest(): Promise<Manifest | null> {
    // Reuse the existing /api/downloads/manifest route as the single
    // source of truth for the GH-release crawl + store URLs.
    try {
        const res = await fetch(`${SELF_ORIGIN}/api/downloads/manifest`, {
            next: { revalidate: 300 },
        });
        if (!res.ok) return null;
        return (await res.json()) as Manifest;
    } catch {
        return null;
    }
}

function formatBytes(n: number): string {
    if (!n) return "";
    const units = ["B", "KB", "MB", "GB"];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < units.length - 1) {
        v /= 1024;
        i++;
    }
    return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

function OsBadge({ os }: { os: PlatformAsset["os"] }) {
    const map: Record<PlatformAsset["os"], string> = {
        win: "Windows",
        mac: "macOS",
        linux: "Linux",
        android: "Android",
        ios: "iOS",
    };
    return (
        <span className="inline-flex items-center rounded-md border border-white/15 bg-white/5 px-2 py-0.5 text-[11px] font-medium text-white/80">
            {map[os]}
        </span>
    );
}

function AssetRow({ asset }: { asset: PlatformAsset }) {
    return (
        <a
            href={asset.url}
            className="flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/5 px-3 py-2.5 transition hover:border-purple-400/40 hover:bg-white/10"
        >
            <div className="flex min-w-0 items-center gap-2">
                <OsBadge os={asset.os} />
                <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-white">
                        {asset.label}
                    </div>
                    <div className="truncate text-xs text-white/40">
                        {asset.filename}
                    </div>
                </div>
            </div>
            <div className="shrink-0 text-xs text-white/60">
                {formatBytes(asset.sizeBytes)}
            </div>
        </a>
    );
}

function ChannelSection({ channel, blurb }: { channel: Channel; blurb: string }) {
    if (!channel.assets.length && !channel.releaseUrl)
        return (
            <section className="rounded-xl border border-white/10 bg-white/[0.03] p-5">
                <h2 className="text-lg font-semibold text-white">{channel.name}</h2>
                <p className="mt-1 text-sm text-white/60">{blurb}</p>
                <p className="mt-4 text-sm text-white/40">
                    No release published yet — check back soon.
                </p>
            </section>
        );

    return (
        <section className="rounded-xl border border-white/10 bg-white/[0.03] p-5">
            <div className="flex items-baseline justify-between gap-2">
                <h2 className="text-lg font-semibold text-white">{channel.name}</h2>
                {channel.version && (
                    <span className="text-xs text-white/50">v{channel.version}</span>
                )}
            </div>
            <p className="mt-1 text-sm text-white/60">{blurb}</p>
            <div className="mt-4 grid gap-2 sm:grid-cols-2">
                {channel.assets.map((a) => (
                    <AssetRow key={a.filename} asset={a} />
                ))}
            </div>
            {channel.releaseUrl && (
                <div className="mt-3">
                    <a
                        href={channel.releaseUrl}
                        className="text-xs text-purple-300 hover:underline"
                    >
                        Release notes on GitHub →
                    </a>
                </div>
            )}
        </section>
    );
}

export default async function DownloadsPublicPage() {
    const manifest = await getManifest();

    return (
        <main className="min-h-screen bg-gradient-to-br from-[#0a0a0f] via-[#0f0a1a] to-[#1a0a1f] px-4 py-12 text-white sm:px-6 lg:px-8">
            <div className="mx-auto max-w-5xl">
                <header className="mb-12 text-center">
                    {/* The page is dark in every theme: `.dark` makes the mark's token colours resolve to their dark values. */}
                    <Link
                        href="/"
                        className="dark inline-flex items-center gap-3"
                    >
                        <BrandMark
                            product="mark"
                            size={48}
                            tile
                            decorative
                            className="rounded-[22.5%] shadow-[0_0_24px_color-mix(in_oklch,var(--primary)_35%,transparent)]"
                        />
                        <BrandLockup product="mark" wordmarkOnly height={34} />
                    </Link>
                    <h1 className="mt-6 text-4xl font-bold tracking-tight sm:text-5xl">
                        Descarcă MixAI
                    </h1>
                    <p className="mx-auto mt-3 max-w-2xl text-base text-white/60">
                        Aplicații desktop, mobile și extensii de browser pentru
                        organizarea muzicii. Toate componentele sunt opționale —
                        aplicația web funcționează singură pe{" "}
                        <Link
                            href="/"
                            className="text-purple-300 hover:underline"
                        >
                            mixai.ro
                        </Link>
                        .
                    </p>
                </header>

                {!manifest && (
                    <div className="rounded-xl border border-amber-400/30 bg-amber-400/10 p-5 text-amber-100">
                        Nu am putut prelua lista de descărcări momentan. Încearcă
                        din nou peste câteva minute, sau vizitează{" "}
                        <a
                            href="https://github.com/dragoscv/mmo/releases"
                            className="underline"
                        >
                            paginile de release direct pe GitHub
                        </a>
                        .
                    </div>
                )}

                {manifest && (
                    <div className="space-y-5">
                        {manifest.channels.music && (
                            <ChannelSection
                                channel={manifest.channels.music}
                                blurb="Player-ul MixAI Music pentru serverul tău MixAI. Windows și macOS din Microsoft Store și Mac App Store; Linux ca AppImage sau .deb."
                            />
                        )}
                        <ChannelSection
                            channel={manifest.channels.native}
                            blurb="Build-uri native pentru Windows, macOS, Linux, Android și iOS. Folosesc aplicația web direct — fără export offline."
                        />
                        <ChannelSection
                            channel={manifest.channels.companion}
                            blurb="Server local care expune fișierele și hardware-ul tău audio aplicației web. Necesar pentru DJ/mixer/recordings."
                        />
                        <ChannelSection
                            channel={manifest.channels.extension}
                            blurb="MixAI Connector este extensia de browser care leagă MixAI de paginile de unde descarci muzică (YouTube, Bandcamp, SoundCloud)."
                        />

                        <section className="rounded-xl border border-white/10 bg-white/[0.03] p-5">
                            <h2 className="text-lg font-semibold text-white">
                                Web stores
                            </h2>
                            <p className="mt-1 text-sm text-white/60">
                                Versiuni publicate și auto-update pe magazinele
                                oficiale.
                            </p>
                            <div className="mt-4 grid gap-2 sm:grid-cols-3">
                                <a
                                    href={manifest.extensionStores.chrome}
                                    className="rounded-lg border border-white/10 bg-white/5 px-3 py-3 text-center text-sm font-medium text-white transition hover:border-purple-400/40 hover:bg-white/10"
                                >
                                    Chrome Web Store
                                </a>
                                <a
                                    href={manifest.extensionStores.firefox}
                                    className="rounded-lg border border-white/10 bg-white/5 px-3 py-3 text-center text-sm font-medium text-white transition hover:border-purple-400/40 hover:bg-white/10"
                                >
                                    Firefox Add-ons
                                </a>
                                <a
                                    href={manifest.extensionStores.edge}
                                    className="rounded-lg border border-white/10 bg-white/5 px-3 py-3 text-center text-sm font-medium text-white transition hover:border-purple-400/40 hover:bg-white/10"
                                >
                                    Edge Add-ons
                                </a>
                            </div>
                            {(manifest.mobileStores.appStore ||
                                manifest.mobileStores.playStore ||
                                manifest.mobileStores.testFlight) && (
                                <div className="mt-3 grid gap-2 sm:grid-cols-3">
                                    {manifest.mobileStores.appStore && (
                                        <a
                                            href={manifest.mobileStores.appStore}
                                            className="rounded-lg border border-white/10 bg-white/5 px-3 py-3 text-center text-sm font-medium text-white transition hover:border-purple-400/40 hover:bg-white/10"
                                        >
                                            App Store
                                        </a>
                                    )}
                                    {manifest.mobileStores.playStore && (
                                        <a
                                            href={manifest.mobileStores.playStore}
                                            className="rounded-lg border border-white/10 bg-white/5 px-3 py-3 text-center text-sm font-medium text-white transition hover:border-purple-400/40 hover:bg-white/10"
                                        >
                                            Google Play
                                        </a>
                                    )}
                                    {manifest.mobileStores.testFlight && (
                                        <a
                                            href={manifest.mobileStores.testFlight}
                                            className="rounded-lg border border-white/10 bg-white/5 px-3 py-3 text-center text-sm font-medium text-white transition hover:border-purple-400/40 hover:bg-white/10"
                                        >
                                            TestFlight (iOS beta)
                                        </a>
                                    )}
                                </div>
                            )}
                        </section>
                    </div>
                )}

                <footer className="mt-12 text-center text-xs text-white/40">
                    Open source pe{" "}
                    <a
                        href="https://github.com/dragoscv/mmo"
                        className="text-white/60 hover:text-white hover:underline"
                    >
                        github.com/dragoscv/mmo
                    </a>
                </footer>
            </div>
        </main>
    );
}
