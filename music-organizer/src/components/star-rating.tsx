"use client";

import { useState } from "react";
import { Star } from "lucide-react";
import { cn } from "@/lib/utils";

interface StarRatingProps {
    value: number | null | undefined;
    onChange?: (rating: number) => void;
    size?: "sm" | "md" | "lg";
    readonly?: boolean;
}

const sizeMap = {
    sm: "h-3.5 w-3.5",
    md: "h-4.5 w-4.5",
    lg: "h-6 w-6",
};

export function StarRating({
    value,
    onChange,
    size = "md",
    readonly = false,
}: StarRatingProps) {
    const [hoverValue, setHoverValue] = useState(0);
    const currentValue = value || 0;
    const displayValue = hoverValue || currentValue;

    return (
        <div
            className="inline-flex items-center gap-0.5"
            onMouseLeave={() => !readonly && setHoverValue(0)}
        >
            {[1, 2, 3, 4, 5].map((star) => (
                <button
                    key={star}
                    type="button"
                    disabled={readonly}
                    className={cn(
                        "transition-all duration-150",
                        readonly
                            ? "cursor-default"
                            : "cursor-pointer hover:scale-110 active:scale-95"
                    )}
                    onMouseEnter={() => !readonly && setHoverValue(star)}
                    onClick={() => {
                        if (!readonly && onChange) {
                            onChange(currentValue === star ? 0 : star);
                        }
                    }}
                >
                    <Star
                        className={cn(
                            sizeMap[size],
                            "transition-colors duration-150",
                            star <= displayValue
                                ? "fill-amber-400 text-amber-400"
                                : "fill-transparent text-zinc-600"
                        )}
                    />
                </button>
            ))}
        </div>
    );
}
