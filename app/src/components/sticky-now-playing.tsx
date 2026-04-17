"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { usePlayer } from "./player-context";
import { Artwork } from "./artwork";
import { ChevronUp, ChevronDown, Pause } from "lucide-react";
import { cn, formatKey } from "@/lib/utils";
import { useDAWSettings } from "@/hooks/use-daw-settings";
import { usePathname } from "next/navigation";

export function StickyNowPlaying() {
    const player = usePlayer();
    const { noteNotations } = useDAWSettings();
    const pathname = usePathname();
    const [position, setPosition] = useState<"above" | "below" | null>(null);
    const [mainRect, setMainRect] = useState<{ left: number; width: number } | null>(null);
    const observerRef = useRef<IntersectionObserver | null>(null);
    const rafRef = useRef<number>(0);

    const scrollToTrack = useCallback(() => {
        const row = document.querySelector<HTMLElement>("[data-playing-track]");
        if (row) {
            row.scrollIntoView({ behavior: "smooth", block: "center" });
        }
    }, []);

    // Track the <main> element's position for sizing the bar
    useEffect(() => {
        const main = document.querySelector<HTMLElement>("main");
        if (!main) return;

        const update = () => {
            const rect = main.getBoundingClientRect();
            setMainRect({ left: rect.left, width: rect.width });
        };

        update();
        const ro = new ResizeObserver(update);
        ro.observe(main);

        return () => ro.disconnect();
    }, []);

    useEffect(() => {
        setPosition(null);

        if (!player.currentTrack) return;

        const setup = () => {
            const row = document.querySelector<HTMLElement>("[data-playing-track]");
            if (!row) {
                setPosition(null);
                return;
            }

            const main = document.querySelector<HTMLElement>("main");
            if (!main) return;

            observerRef.current?.disconnect();

            const observer = new IntersectionObserver(
                (entries) => {
                    const entry = entries[0];
                    if (!entry) return;

                    if (entry.isIntersecting) {
                        setPosition(null);
                    } else {
                        const rowTop = entry.boundingClientRect.top;
                        const rootTop = entry.rootBounds?.top ?? 0;
                        setPosition(rowTop < rootTop ? "above" : "below");
                    }
                },
                {
                    root: main,
                    threshold: 0,
                    rootMargin: "0px",
                }
            );

            observer.observe(row);
            observerRef.current = observer;
        };

        const timer = setTimeout(setup, 150);

        const mutationObs = new MutationObserver(() => {
            cancelAnimationFrame(rafRef.current);
            rafRef.current = requestAnimationFrame(setup);
        });

        const main = document.querySelector("main");
        if (main) {
            mutationObs.observe(main, { childList: true, subtree: true });
        }

        return () => {
            clearTimeout(timer);
            cancelAnimationFrame(rafRef.current);
            mutationObs.disconnect();
            observerRef.current?.disconnect();
        };
    }, [player.currentTrack?.id, pathname]);

    if (!position || !player.currentTrack) return null;

    const track = player.currentTrack;
    const isAbove = position === "above";

    return (
        <button
            onClick={scrollToTrack}
            style={mainRect ? { left: mainRect.left, width: mainRect.width } : undefined}
            className={cn(
                "fixed z-40 flex items-center gap-3 px-4 py-2 bg-card/95 backdrop-blur-sm shadow-lg cursor-pointer transition-all duration-200 hover:bg-card group border-purple-500/30",
                isAbove
                    ? "top-0 border-b"
                    : "bottom-[73px] border-t"
            )}
        >
            {/* Direction indicator */}
            <div className="flex h-6 w-6 items-center justify-center rounded-full bg-purple-500/10 text-purple-400 group-hover:bg-purple-500/20 transition-colors shrink-0">
                {isAbove ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            </div>

            {/* Artwork */}
            <Artwork src={track.artworkUrl} size="sm" showPlaceholder={false} />

            {/* Track info */}
            <div className="flex-1 min-w-0 text-left">
                <p className="text-sm font-medium text-purple-400 truncate">
                    {track.title || track.filename}
                </p>
                <p className="text-xs text-muted-foreground truncate">
                    {track.artist || "Unknown"}
                </p>
            </div>

            {/* BPM / Key badges */}
            <div className="hidden sm:flex items-center gap-2">
                {track.bpm && (
                    <span className="text-xs font-mono text-muted-foreground tabular-nums">
                        {Math.round(track.bpm)} BPM
                    </span>
                )}
                {track.keyCamelot && (
                    <span className="text-xs font-mono text-muted-foreground">
                        {formatKey(track.keyCamelot, noteNotations)}
                    </span>
                )}
            </div>

            {/* Playing indicator */}
            <div className="flex items-center gap-1.5 shrink-0">
                {player.isPlaying ? (
                    <div className="flex items-center gap-0.5">
                        <span className="w-0.5 h-3 bg-purple-400 rounded-full animate-pulse" />
                        <span className="w-0.5 h-4 bg-purple-400 rounded-full animate-pulse [animation-delay:150ms]" />
                        <span className="w-0.5 h-2.5 bg-purple-400 rounded-full animate-pulse [animation-delay:300ms]" />
                    </div>
                ) : (
                    <Pause className="h-3.5 w-3.5 text-purple-400" />
                )}
            </div>

            {/* Label */}
            <span className="text-[10px] text-muted-foreground/50 uppercase tracking-wider shrink-0">
                {isAbove ? "↑ Scroll to track" : "↓ Scroll to track"}
            </span>
        </button>
    );
}
