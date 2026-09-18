"use client";

import { useTransition, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import {
    Check, Plus, Star, Eye, EyeOff, RefreshCw, Copy, ListPlus,
    PlayCircle, Heart, Ban, ExternalLink,
} from "lucide-react";
import {
    ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator,
    ContextMenuSub, ContextMenuSubTrigger, ContextMenuSubContent,
    ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { markWatched } from "@/actions/video-playback";
import { markUnwatched, rateItem, addToCustomCollection, refreshMetadata } from "@/actions/video-context";
import { toggleWishlist } from "@/actions/video-collections";
import { toggleHidden } from "@/actions/watch-prefs";

export interface PosterContextMenuProps {
    children: ReactNode;
    href?: string;
    movieId?: number;
    showId?: number;
    tmdbId?: number | null;
    imdbId?: string | null;
    kind: "movie" | "tv";
    /** Whether the item is already in the wishlist (controls toggle label). */
    inWishlist?: boolean;
    /** Whether the item is already marked watched. */
    watched?: boolean;
    /** Custom collections of the active profile. */
    customCollections?: Array<{ id: number; name: string }>;
}

export function PosterContextMenu({
    children, href, movieId, showId, tmdbId, imdbId, kind,
    inWishlist, watched, customCollections = [],
}: PosterContextMenuProps) {
    const [pending, start] = useTransition();
    const t = useTranslations("watch.actions");
    const failed = t("failed");

    function withToast(promise: Promise<unknown>, ok: string, err = failed): void {
        void promise.then((r) => {
            if (r && typeof r === "object" && "error" in r && r.error) {
                toast.error(typeof r.error === "string" ? r.error : err);
                return;
            }
            toast.success(ok);
        }).catch(() => toast.error(err));
    }

    function onMarkWatched() {
        start(() => withToast(markWatched({ movieId }), t("markedWatched")));
    }
    function onMarkUnwatched() {
        start(() => withToast(markUnwatched({ movieId }), t("markedUnwatched")));
    }
    function onToggleWishlist() {
        start(() => withToast(
            toggleWishlist({ movieId, tvShowId: showId }),
            inWishlist ? t("removedWishlist") : t("addedWishlist"),
        ));
    }
    function onRate(rating: number | null) {
        start(() => withToast(rateItem({ movieId, showId, rating }), rating ? t("rated", { rating }) : t("ratingCleared")));
    }
    function onAddToCollection(collectionId: number) {
        start(() => withToast(
            addToCustomCollection({ collectionId, movieId, showId }),
            t("addedToPlaylist"),
        ));
    }
    function onRefresh() {
        start(() => withToast(refreshMetadata({ movieId, showId }), t("metadataRefreshed")));
    }
    function onHide() {
        if (!tmdbId) { toast.error(t("missingTmdb")); return; }
        start(() => withToast(
            toggleHidden(kind, tmdbId),
            t("hiddenFromRecs"),
        ));
    }
    function copy(text: string, label: string) {
        navigator.clipboard.writeText(text).then(
            () => toast.success(t("copied", { what: label })),
            () => toast.error(t("copyFailed")),
        );
    }

    return (
        <ContextMenu>
            <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
            <ContextMenuContent className="w-60">
                {href && (
                    <>
                        <ContextMenuItem onClick={() => { window.location.assign(href); }}>
                            <PlayCircle className="mr-2 h-4 w-4" /> {t("open")}
                        </ContextMenuItem>
                        <ContextMenuSeparator />
                    </>
                )}

                {watched ? (
                    <ContextMenuItem onClick={onMarkUnwatched} disabled={pending}>
                        <EyeOff className="mr-2 h-4 w-4" /> {t("markUnwatched")}
                    </ContextMenuItem>
                ) : (
                    <ContextMenuItem onClick={onMarkWatched} disabled={pending}>
                        <Eye className="mr-2 h-4 w-4" /> {t("markWatched")}
                    </ContextMenuItem>
                )}

                <ContextMenuItem onClick={onToggleWishlist} disabled={pending}>
                    <Heart className="mr-2 h-4 w-4" /> {inWishlist ? t("removeWishlist") : t("addWishlist")}
                </ContextMenuItem>

                <ContextMenuSub>
                    <ContextMenuSubTrigger>
                        <Star className="mr-2 h-4 w-4" /> {t("rate")}
                    </ContextMenuSubTrigger>
                    <ContextMenuSubContent>
                        {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((r) => (
                            <ContextMenuItem key={r} onClick={() => onRate(r)}>
                                {r} / 10
                            </ContextMenuItem>
                        ))}
                        <ContextMenuSeparator />
                        <ContextMenuItem onClick={() => onRate(null)}>{t("clearRating")}</ContextMenuItem>
                    </ContextMenuSubContent>
                </ContextMenuSub>

                <ContextMenuSub>
                    <ContextMenuSubTrigger>
                        <ListPlus className="mr-2 h-4 w-4" /> {t("addToPlaylist")}
                    </ContextMenuSubTrigger>
                    <ContextMenuSubContent>
                        {customCollections.length === 0 && (
                            <ContextMenuItem disabled>{t("noPlaylists")}</ContextMenuItem>
                        )}
                        {customCollections.map((c) => (
                            <ContextMenuItem key={c.id} onClick={() => onAddToCollection(c.id)}>
                                <Plus className="mr-2 h-4 w-4" /> {c.name}
                            </ContextMenuItem>
                        ))}
                        <ContextMenuSeparator />
                        <ContextMenuItem onClick={() => window.location.assign("/watch/collections")}>
                            <ListPlus className="mr-2 h-4 w-4" /> {t("managePlaylists")}
                        </ContextMenuItem>
                    </ContextMenuSubContent>
                </ContextMenuSub>

                <ContextMenuSeparator />

                <ContextMenuItem onClick={onRefresh} disabled={pending}>
                    <RefreshCw className="mr-2 h-4 w-4" /> {t("refreshMetadata")}
                </ContextMenuItem>

                {imdbId && (
                    <ContextMenuItem onClick={() => copy(`https://www.imdb.com/title/${imdbId}/`, "Link IMDB")}>
                        <Copy className="mr-2 h-4 w-4" /> {t("copyImdb")}
                    </ContextMenuItem>
                )}
                {tmdbId && (
                    <ContextMenuItem onClick={() => copy(`https://www.themoviedb.org/${kind}/${tmdbId}`, "Link TMDB")}>
                        <ExternalLink className="mr-2 h-4 w-4" /> {t("copyTmdb")}
                    </ContextMenuItem>
                )}

                <ContextMenuSeparator />

                <ContextMenuItem onClick={onHide} disabled={pending || !tmdbId}>
                    <Ban className="mr-2 h-4 w-4" /> {t("hideFromRecs")}
                </ContextMenuItem>
            </ContextMenuContent>
        </ContextMenu>
    );
}
