"use client";

import { useTransition, useState } from "react";
import { useTranslations } from "next-intl";
import { toggleWishlist } from "@/actions/video-collections";
import { Heart } from "lucide-react";
import { toast } from "sonner";

export function WishlistButton({ movieId, tvShowId, initial }: {
    movieId?: number; tvShowId?: number; initial: boolean;
}) {
    const [pending, start] = useTransition();
    const [on, setOn] = useState(initial);
    const t = useTranslations("watch.actions");
    return (
        <button
            type="button"
            disabled={pending}
            onClick={() => start(async () => {
                try {
                    const r = await toggleWishlist({ movieId, tvShowId });
                    if ("added" in r) {
                        setOn(r.added === true);
                        toast.success(r.added ? t("addedWishlist") : t("removedWishlist"));
                    } else if ("error" in r) {
                        toast.error(t("failed"));
                    }
                } catch {
                    toast.error(t("failed"));
                }
            })}
            aria-pressed={on}
            style={{
                display: "inline-flex", alignItems: "center", gap: 6,
                background: on ? "var(--watch-accent, #ff3366)" : "rgba(255,255,255,.08)",
                color: "#fff", border: "1px solid rgba(255,255,255,.15)",
                borderRadius: 999, padding: "6px 14px", fontSize: ".85rem", cursor: pending ? "wait" : "pointer",
                transition: "background 120ms",
            }}
        >
            <Heart fill={on ? "#fff" : "none"} size={14} />
            {on ? "In wishlist" : "Add to wishlist"}
        </button>
    );
}
