import "./cinematic.css";
import "./tv-mode.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { LibraryEventsListener } from "@/components/video/library-events-listener";
import { TvModeProbe } from "@/components/video/tv-mode-probe";

export const metadata: Metadata = {
    title: { template: "%s · Watch · MMO", default: "Watch · MMO" },
    description: "Filme, seriale și alte clipuri din biblioteca ta locală.",
};

export default function WatchLayout({ children }: { children: ReactNode }) {
    return (
        <div className="watch-shell">
            <LibraryEventsListener />
            <TvModeProbe />
            {children}
        </div>
    );
}
