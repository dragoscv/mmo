"use client";

/**
 * Cinematic back button for /watch detail pages. Mounts next to the
 * page title. Uses `router.back()` when there's a history stack to
 * preserve user's scroll position on the index page, otherwise falls
 * back to a static `href` (default `/watch`).
 */
import { useRouter } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { useCallback } from "react";

interface Props {
    /** Static fallback when there's no history (cold deep-link). */
    fallbackHref?: string;
    label?: string;
}

export function WatchBackButton({ fallbackHref = "/watch", label = "Back" }: Props) {
    const router = useRouter();
    const onClick = useCallback(() => {
        // window.history.length === 1 ⇒ no entries to pop in this tab.
        if (typeof window !== "undefined" && window.history.length > 1) {
            router.back();
        } else {
            router.push(fallbackHref);
        }
    }, [router, fallbackHref]);

    return (
        <button type="button" className="watch-back-btn" onClick={onClick} aria-label={label}>
            <ChevronLeft size={18} />
            <span>{label}</span>
        </button>
    );
}
