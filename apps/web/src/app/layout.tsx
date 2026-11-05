import type { Metadata, Viewport } from "next";
import { Suspense } from "react";
import { Toaster } from "sonner";
import { SidebarProvider } from "@/components/sidebar-context";
import { PlayerProvider } from "@/components/player-context";
import { AnalysisProvider } from "@/components/analysis-provider";
import { OfflineProvider } from "@/hooks/offline-context";
import { AudioPlayer } from "@/components/audio-player";
import { NowPlaying } from "@/components/now-playing";
import { StickyNowPlaying } from "@/components/sticky-now-playing";
import { VideoPlayerHost, MaestroChatDock } from "@/components/layout-lazy";
import { PlayerAwareLayout } from "@/components/player-aware-layout";
import { ThemeProvider } from "@/components/theme-provider";
import { SelectionProvider } from "@/components/selection-provider";
import { EQProvider } from "@/components/eq-context";
import { MixerProvider } from "@/components/mixer-context";
import { MidiProvider } from "@/hooks/use-midi";
import { ControllerBridge } from "@/components/controller-bridge";
import { ConfirmLoadDialog } from "@/components/confirm-load-dialog";
import { FocusModeProvider } from "@/components/focus-mode-context";
import { FocusAwareNowPlayingBar } from "@/components/focus-aware-shell";
import { ShortcutsOverlay } from "@/components/shortcuts-overlay";
import { CinemaSettingsSync } from "@/components/cinema-settings-sync";
import { AuthProvider } from "@/components/auth-provider";
import { PreferencesSync } from "@/components/preferences-sync";
import { PwaStandalone } from "@/components/pwa-standalone";
import { CompanionStatusProvider } from "@/components/companion/companion-status-provider";
import { QueryProvider } from "@/components/query-provider";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages } from "next-intl/server";
import { NuqsAdapter } from "nuqs/adapters/next/app";
import { SerwistProvider } from "@serwist/next/react";
// NOTE: globals.css is pre-compiled by `@tailwindcss/cli` into `public/globals.css`
// during `prebuild`, then served as a static asset and linked from <head> below.
// We bypass Next.js' postcss pipeline because @tailwindcss/postcss on Linux
// (Vercel) emits CSS its own re-parse step can't handle (relative-color
// inside @supports). Source lives at `src/app/globals.src.css`.
// Self-hosted variable fonts (OFL, latin + latin-ext subsets incl. RO diacritics) — `next/font/google`
// failed under Turbopack on Linux ("Can't resolve '@vercel/turbopack-next/internal/font/google/font'")
// and needs network at build time. Same CSS variables as before.
import localFont from "next/font/local";
import { cn } from "@/lib/utils";
import { ThemeColorMeta } from "./theme-color-meta";

const inter = localFont({
    src: "./fonts/InterVariable.woff2",
    weight: "100 900",
    display: "swap",
    variable: "--font-sans",
    fallback: ["system-ui", "Arial", "sans-serif"],
});
const spaceGrotesk = localFont({
    src: "./fonts/SpaceGroteskVariable.woff2",
    weight: "300 700",
    display: "swap",
    variable: "--font-heading",
    fallback: ["system-ui", "Arial", "sans-serif"],
});
const jetbrainsMono = localFont({
    src: "./fonts/JetBrainsMonoVariable.woff2",
    weight: "100 800",
    display: "swap",
    variable: "--font-mono",
    fallback: ["ui-monospace", "Consolas", "monospace"],
});

export const metadata: Metadata = {
    metadataBase: new URL("https://mixai.ro"),
    title: {
        default: "MixAI — AI Music Suite",
        template: "%s · MixAI",
    },
    applicationName: "MixAI",
    description:
        "MixAI — your music library, mixed by intelligence. Scan, analyze, tag, organize, mix and perform with an AI-native music suite for DJs and producers.",
    keywords: [
        "MixAI",
        "AI music suite",
        "DJ software",
        "music library manager",
        "music organizer",
        "BPM key analysis",
        "music tagging",
        "playlist manager",
    ],
    authors: [{ name: "MixAI", url: "https://mixai.ro" }],
    creator: "MixAI",
    publisher: "MixAI",
    manifest: "/manifest.webmanifest",
    openGraph: {
        type: "website",
        siteName: "MixAI",
        title: "MixAI — AI Music Suite",
        description:
            "Your music library, mixed by intelligence. An AI-native music suite for DJs and producers.",
        url: "https://mixai.ro",
        locale: "ro_RO",
        images: [
            {
                url: "/og-image.png",
                width: 1200,
                height: 630,
                alt: "MixAI — AI Music Suite",
            },
        ],
    },
    twitter: {
        card: "summary_large_image",
        title: "MixAI — AI Music Suite",
        description:
            "Your music library, mixed by intelligence. An AI-native music suite for DJs and producers.",
        images: ["/og-image.png"],
    },
    robots: {
        index: true,
        follow: true,
    },
    icons: {
        icon: [
            { url: "/favicon.ico", sizes: "32x32" },
            { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
            { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
        ],
        apple: "/apple-touch-icon.png",
    },
    appleWebApp: {
        capable: true,
        statusBarStyle: "black-translucent",
        title: "MixAI",
    },
    other: {
        "mobile-web-app-capable": "yes",
    },
};

export const viewport: Viewport = {
    width: "device-width",
    initialScale: 1,
    maximumScale: 1,
    viewportFit: "cover",
};

export default function RootLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    return (
        <RootLayoutAsync>{children}</RootLayoutAsync>
    );
}

async function RootLayoutAsync({ children }: { children: React.ReactNode }) {
    const locale = await getLocale();
    const messages = await getMessages();
    return (
        <html lang={locale} className={cn("font-sans", inter.variable, spaceGrotesk.variable, jetbrainsMono.variable)} suppressHydrationWarning>
            <head>
                {/* Applies persisted mode/accent/surface/density before first paint
                    (no dark→light flash). Generated by packages/design-tokens. */}
                <script src="/prehydrate.js" />
                <ThemeColorMeta />
                {/* Served as a static asset from public/, not as an
                    import, so Tailwind's CSS layers + the legacy globals
                    stay outside the route's RSC payload. */}
                {/* eslint-disable-next-line @next/next/no-css-tags */}
                <link rel="stylesheet" href="/globals.css" />
            </head>
            <body className="antialiased">
                {/* WP9-05: registers public/sw.js (built by `serwist build` after
                    `next build`). Disabled in dev (old behaviour: no SW).
                    cacheOnNavigation MUST stay off — it would write per-user
                    HTML into the cache (cross-user PII leak, see sw.ts). */}
                <SerwistProvider
                    swUrl="/sw.js"
                    disable={process.env.NODE_ENV === "development"}
                    cacheOnNavigation={false}
                    reloadOnOnline={false}
                />
                <ThemeProvider initialLocale={locale as "ro" | "en"}>
                    {/* WP4-03: <html data-standalone> for installed PWA / Capacitor / Tauri. */}
                    <PwaStandalone />
                    <AuthProvider>
                        <PreferencesSync />
                        <QueryProvider>
                        <CompanionStatusProvider>
                        <NextIntlClientProvider locale={locale} messages={messages}>
                        <NuqsAdapter>
                        <SelectionProvider>
                            <SidebarProvider>
                                <PlayerProvider>
                                    <EQProvider>
                                        <MixerProvider>
                                            <MidiProvider>
                                                <ControllerBridge />
                                                <AnalysisProvider>
                                                <OfflineProvider>
                                                <FocusModeProvider>
                                                    <PlayerAwareLayout>
                                                        {children}
                                                    </PlayerAwareLayout>
                                                    <FocusAwareNowPlayingBar>
                                                        <AudioPlayer />
                                                        <Suspense>
                                                            <NowPlaying />
                                                        </Suspense>
                                                        <StickyNowPlaying />
                                                        <VideoPlayerHost />
                                                        <ConfirmLoadDialog />
                                                    </FocusAwareNowPlayingBar>
                                                </FocusModeProvider>
                                                </OfflineProvider>
                                            </AnalysisProvider>
                                            </MidiProvider>
                                        </MixerProvider>
                                    </EQProvider>
                                    <Toaster
                                        position="bottom-right"
                                        toastOptions={{
                                            style: {
                                                background: "var(--card)",
                                                border: "1px solid var(--border)",
                                                color: "var(--foreground)",
                                            },
                                        }}
                                    />
                                    <ShortcutsOverlay />
                                    <CinemaSettingsSync />
                                    <MaestroChatDock />
                                </PlayerProvider>
                            </SidebarProvider>
                        </SelectionProvider>
                        </NuqsAdapter>
                        </NextIntlClientProvider>
                        </CompanionStatusProvider>
                        </QueryProvider>
                    </AuthProvider>
                </ThemeProvider>
            </body>
        </html>
    );
}
