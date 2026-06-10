"use client";

import { Heart } from "lucide-react";
import { cn } from "@/lib/utils";

interface FavoriteButtonProps {
    isFavorite: boolean;
    onChange?: (value: boolean) => void;
    size?: "sm" | "md" | "lg";
}

const sizeMap = {
    sm: "h-3.5 w-3.5",
    md: "h-4.5 w-4.5",
    lg: "h-6 w-6",
};

export function FavoriteButton({
    isFavorite,
    onChange,
    size = "md",
}: FavoriteButtonProps) {
    return (
        <button
            type="button"
            onClick={() => onChange?.(!isFavorite)}
            className={cn(
                "transition-all duration-200 cursor-pointer",
                "hover:scale-110 active:scale-90"
            )}
        >
            <Heart
                className={cn(
                    sizeMap[size],
                    "transition-all duration-200",
                    isFavorite
                        ? "fill-rose-500 text-rose-500 drop-shadow-[0_0_4px_rgba(244,63,94,0.5)]"
                        : "fill-transparent text-zinc-500 hover:text-rose-400"
                )}
            />
        </button>
    );
}
