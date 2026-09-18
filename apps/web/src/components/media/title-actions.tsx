"use client";

/**
 * Title page actions (WP11-04): watchlist toggle, mark watched/unwatched
 * (movies indexed locally), hide from recommendations. Optimistic UI via
 * `useTransition`; the server actions revalidate the relevant paths.
 */
import { Check, Eye, EyeOff, ListMinus, ListPlus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@mmo/ui";
import { toast } from "sonner";
import { addToWatchlist, removeFromWatchlist } from "@/actions/watchlist";
import { toggleHidden } from "@/actions/watch-prefs";
import { setTitleWatched, type LocalTitleState } from "@/actions/media";
import type { MediaKind } from "@/lib/media/types";

export interface TitleActionsProps {
    kind: MediaKind;
    tmdbId: number;
    state: LocalTitleState;
}

export function TitleActions({ kind, tmdbId, state }: TitleActionsProps) {
    const t = useTranslations("media.actions");
    const router = useRouter();
    const [pending, start] = useTransition();
    const [s, setS] = useState(state);
    const wlKind = kind === "movie" ? "movie" : "show";

    const onWatchlist = () => start(async () => {
        if (!s.localId) { toast.info(t("needsLocal")); return; }
        const r = s.inWatchlist ? await removeFromWatchlist(wlKind, s.localId) : await addToWatchlist(wlKind, s.localId);
        if ("error" in r) { toast.error(t("failed")); return; }
        setS((cur) => ({ ...cur, inWatchlist: !cur.inWatchlist }));
        router.refresh();
    });

    const onWatched = () => start(async () => {
        if (!s.localId) { toast.info(t("needsLocal")); return; }
        const r = await setTitleWatched(kind, s.localId, !s.watched);
        if (!r.ok) { toast.error(t("failed")); return; }
        setS((cur) => ({ ...cur, watched: !cur.watched }));
        router.refresh();
    });

    const onHide = () => start(async () => {
        const r = await toggleHidden(kind, tmdbId);
        if (!r.ok) { toast.error(t("failed")); return; }
        setS((cur) => ({ ...cur, hidden: r.hidden }));
        toast.success(r.hidden ? t("hidden") : t("unhidden"));
    });

    return (
        <div className="flex flex-wrap gap-2" id="actions" data-slot="title-actions">
            <Button variant="secondary" onClick={onWatchlist} disabled={pending} aria-pressed={s.inWatchlist}>
                {s.inWatchlist ? <ListMinus aria-hidden /> : <ListPlus aria-hidden />}
                {s.inWatchlist ? t("removeWatchlist") : t("addWatchlist")}
            </Button>
            {kind === "movie" ? (
                <Button variant="secondary" onClick={onWatched} disabled={pending} aria-pressed={s.watched}>
                    <Check aria-hidden />
                    {s.watched ? t("markUnwatched") : t("markWatched")}
                </Button>
            ) : null}
            <Button variant="ghost" onClick={onHide} disabled={pending} aria-pressed={s.hidden}>
                {s.hidden ? <Eye aria-hidden /> : <EyeOff aria-hidden />}
                {s.hidden ? t("unhide") : t("hide")}
            </Button>
        </div>
    );
}
