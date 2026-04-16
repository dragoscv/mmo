import type { Metadata, Viewport } from "next";
import { Suspense } from "react";
import { Toaster } from "sonner";
import { AppSidebar } from "@/components/app-sidebar";
import { SidebarProvider } from "@/components/sidebar-context";
import { PlayerProvider } from "@/components/player-context";
import { AnalysisProvider } from "@/components/analysis-provider";
import { AudioPlayer } from "@/components/audio-player";
import { NowPlaying } from "@/components/now-playing";
import { StickyNowPlaying } from "@/components/sticky-now-playing";
import { PlayerAwareLayout } from "@/components/player-aware-layout";
import { ThemeProvider } from "@/components/theme-provider";
import { SelectionProvider } from "@/components/selection-provider";
import { EQProvider } from "@/components/eq-context";
import { MixerProvider } from "@/components/mixer-context";
import { MobileHeader } from "@/components/mobile-header";
import "./globals.css";
import { Inter } from "next/font/google";
import { cn } from "@/lib/utils";
import Script from "next/script";

const inter = Inter({ subsets: ['latin'], variable: '--font-sans' });

export const metadata: Metadata = {
    title: "MMO",
    description:
        "Mwrty Music Organizer — scan, tag, organize, export",
    manifest: "/manifest.webmanifest",
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
        title: "MMO",
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
        <html lang="ro" className={cn("dark font-sans", inter.variable)} suppressHydrationWarning>
            <head>
                <meta name="theme-color" content="#a855f7" />
            </head>
            <body className="antialiased">
                <Script id="sw-register" strategy="afterInteractive">
                    {`if('serviceWorker' in navigator){window.addEventListener('load',()=>{navigator.serviceWorker.register('/sw.js')})}`}
                </Script>
                <ThemeProvider>
                    <SelectionProvider>
                        <SidebarProvider>
                            <PlayerProvider>
                                <EQProvider>
                                    <MixerProvider>
                                        <AnalysisProvider>
                                            <PlayerAwareLayout>
                                                <div data-app-sidebar="">
                                                    <AppSidebar />
                                                </div>
                                                <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
                                                    <MobileHeader />
                                                    <main className="flex-1 min-h-0">
                                                        {children}
                                                    </main>
                                                </div>
                                            </PlayerAwareLayout>
                                            <div data-app-nowplaying="">
                                                <AudioPlayer />
                                                <Suspense>
                                                    <NowPlaying />
                                                </Suspense>
                                                <StickyNowPlaying />
                                            </div>
                                        </AnalysisProvider>
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
                            </PlayerProvider>
                        </SidebarProvider>
                    </SelectionProvider>
                </ThemeProvider>
            </body>
        </html>
    );
}
