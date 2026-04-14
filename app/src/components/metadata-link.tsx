"use client";

import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";

type FilterField =
    | "artist"
    | "album"
    | "genre"
    | "subgenre"
    | "key"
    | "year"
    | "label"
    | "mood"
    | "tag"
    | "energy";

interface MetadataLinkProps {
    field: FilterField;
    value: string | number | null | undefined;
    children?: React.ReactNode;
    className?: string;
    onNavigate?: () => void;
}

export function MetadataLink({
    field,
    value,
    children,
    className,
    onNavigate,
}: MetadataLinkProps) {
    const router = useRouter();

    if (!value) return null;

    const displayValue = children ?? String(value);

    function handleClick(e: React.MouseEvent) {
        e.stopPropagation();
        e.preventDefault();
        onNavigate?.();
        router.push(`/library?${field}=${encodeURIComponent(String(value))}&page=1`);
    }

    return (
        <button
            type="button"
            onClick={handleClick}
            className={cn(
                "inline cursor-pointer text-left hover:underline hover:text-foreground transition-colors",
                className
            )}
            title={`Show all tracks with ${field}: ${value}`}
        >
            {displayValue}
        </button>
    );
}
