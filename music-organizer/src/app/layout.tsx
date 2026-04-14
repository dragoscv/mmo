import type { Metadata } from "next";
import { Toaster } from "sonner";
import { AppSidebar } from "@/components/app-sidebar";
import { PlayerProvider } from "@/components/player-context";
import { AudioPlayer } from "@/components/audio-player";
import { NowPlaying } from "@/components/now-playing";
import "./globals.css";

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
        <html lang="ro">
            <body className="antialiased">
                <PlayerProvider>
                    <div className="flex h-screen overflow-hidden">
                        <AppSidebar />
                        <main className="flex-1 overflow-y-auto p-6 pb-20">
                            {children}
                        </main>
                    </div>
                    <AudioPlayer />
                    <NowPlaying />
                    <Toaster
                        theme="dark"
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
            </body>
        </html>
    );
}
