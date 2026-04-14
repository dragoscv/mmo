import type { Metadata } from "next";
import { Toaster } from "sonner";
import { AppSidebar } from "@/components/app-sidebar";
import { PlayerProvider } from "@/components/player-context";
import { AnalysisProvider } from "@/components/analysis-provider";
import { AudioPlayer } from "@/components/audio-player";
import { NowPlaying } from "@/components/now-playing";
import { PlayerAwareLayout } from "@/components/player-aware-layout";
import { ThemeProvider } from "@/components/theme-provider";
import "./globals.css";
import { Inter } from "next/font/google";
import { cn } from "@/lib/utils";

const inter = Inter({ subsets: ['latin'], variable: '--font-sans' });

export const metadata: Metadata = {
    title: "Music Organizer — mwrty",
    description:
        "Music organization tool for rekordbox — scan, tag, organize, export",
};

export default function RootLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    return (
        <html lang="ro" className={cn("font-sans", inter.variable)} suppressHydrationWarning>
            <body className="antialiased">
                <ThemeProvider>
                    <PlayerProvider>
                        <AnalysisProvider>
                            <PlayerAwareLayout>
                                <AppSidebar />
                                <main className="flex-1 overflow-y-auto p-6">
                                    {children}
                                </main>
                            </PlayerAwareLayout>
                            <AudioPlayer />
                            <NowPlaying />
                        </AnalysisProvider>
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
                </ThemeProvider>
            </body>
        </html>
    );
}
