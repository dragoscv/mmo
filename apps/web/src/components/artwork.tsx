"use client";

import { useState } from "react";
import { Music, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

interface ArtworkProps {
    src?: string | null;
    alt?: string;
    size?: "sm" | "md" | "lg" | "xl";
    className?: string;
    showPlaceholder?: boolean;
}

const sizeMap = {
    sm: "h-8 w-8",
    md: "h-12 w-12",
    lg: "h-24 w-24",
    xl: "h-48 w-48",
};

export function Artwork({
    src,
    alt = "Album artwork",
    size = "md",
    className,
    showPlaceholder = true,
}: ArtworkProps) {
    const [loading, setLoading] = useState(!!src);
    const [error, setError] = useState(false);

    if (!src || error) {
        if (!showPlaceholder) return null;
        return (
            <div
                className={cn(
                    sizeMap[size],
                    "flex items-center justify-center rounded-lg bg-gradient-to-br from-muted to-muted/50 ring-1 ring-border",
                    className
                )}
            >
                <Music
                    className={cn(
                        "text-muted-foreground/40",
                        size === "sm" ? "h-4 w-4" : size === "md" ? "h-5 w-5" : size === "lg" ? "h-8 w-8" : "h-16 w-16"
                    )}
                />
            </div>
        );
    }

    return (
        <div className={cn(sizeMap[size], "relative rounded-lg overflow-hidden ring-1 ring-border", className)}>
            {loading && (
                <div className="absolute inset-0 flex items-center justify-center bg-muted/50">
                    <Loader2 className="h-4 w-4 animate-spin text-purple-400/50" />
                </div>
            )}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
                src={src}
                alt={alt}
                className={cn(
                    "h-full w-full object-cover",
                    loading ? "opacity-0 scale-105" : "opacity-100 scale-100",
                    "transition-all duration-300"
                )}
                onLoad={() => setLoading(false)}
                onError={() => {
                    setError(true);
                    setLoading(false);
                }}
            />
        </div>
    );
}
