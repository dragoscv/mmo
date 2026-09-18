"use client";

/**
 * Client bridge between server-rendered Listen cards and the player.
 * Wraps a card as a single button: click → `play(track, queue)`.
 * `CompanionTrack` is structurally what the player consumes (the app casts
 * it to `Track` everywhere), so the cast is confined to this file.
 */
import type { ComponentProps, ReactNode } from "react";
import type { Track } from "@/db/schema";
import type { CompanionTrack } from "@/lib/companion-library";
import { usePlayer } from "@/components/player-context";
import { cn } from "@/lib/utils";

export interface PlayTrackButtonProps extends Omit<ComponentProps<"button">, "onClick" | "children"> {
    track: CompanionTrack;
    /** Queue to install; defaults to `[track]`. */
    queue?: CompanionTrack[];
    children: ReactNode;
}

export function PlayTrackButton({ track, queue, className, children, ...rest }: PlayTrackButtonProps) {
    const player = usePlayer();
    return (
        <button
            type="button"
            onClick={() => player.play(track as unknown as Track, (queue ?? [track]) as unknown as Track[])}
            className={cn(
                "group/card block w-full text-left rounded-xl outline-none",
                "focus-visible:ring-3 focus-visible:ring-ring/40",
                className,
            )}
            {...rest}
        >
            {children}
        </button>
    );
}
