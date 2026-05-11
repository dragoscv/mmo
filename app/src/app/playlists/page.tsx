import { getPlaylists, getPlaylistTracks, getRecommendedPlaylists } from "@/actions/playlists";
import { getSmartPlaylistIds } from "@/actions/smart-playlists";
import { PlaylistsClient } from "./playlists-client";
import type { Track } from "@/db/schema";
import { auth } from "@/auth";
import { getCompanionLink } from "@/lib/companion-library";
import { notSignedInFor, noCompanionFor } from "@/components/empty-state-server";

export const dynamic = "force-dynamic";

export default async function PlaylistsPage({
    searchParams,
}: {
    searchParams: Promise<Record<string, string | undefined>>;
}) {
    const params = await searchParams;
    const session = await auth();
    if (!session?.user?.id) return notSignedInFor("playlists");
    const link = await getCompanionLink();
    if (!link) return noCompanionFor("playlists");

    const playlistId = params.id ? parseInt(params.id) : undefined;
    const page = parseInt(params.page || "1");
    const pageSize = parseInt(params.pageSize || "50");

    const [allPlaylists, recommendedCategories, smartIds] = await Promise.all([
        getPlaylists(),
        getRecommendedPlaylists(),
        getSmartPlaylistIds(),
    ]);
    const playlistResult = playlistId
        ? await getPlaylistTracks(playlistId, page, pageSize)
        : null;

    const activePlaylist = playlistId
        ? allPlaylists.find((p) => p.id === playlistId)
        : undefined;

    return (
        <PlaylistsClient
            playlists={allPlaylists}
            tracks={(playlistResult?.tracks ?? []) as (Track & { position: number })[]}
            total={playlistResult?.total ?? 0}
            page={playlistResult?.page ?? 1}
            pageSize={playlistResult?.pageSize ?? 50}
            totalPages={playlistResult?.totalPages ?? 0}
            activePlaylist={activePlaylist}
            recommendedCategories={recommendedCategories}
            smartPlaylistIds={smartIds}
        />
    );
}
