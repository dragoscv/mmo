import { getPlaylists, getPlaylistTracks } from "@/actions/playlists";
import { PlaylistsClient } from "./playlists-client";

export const dynamic = "force-dynamic";

export default async function PlaylistsPage({
    searchParams,
}: {
    searchParams: Promise<Record<string, string | undefined>>;
}) {
    const params = await searchParams;
    const playlistId = params.id ? parseInt(params.id) : undefined;
    const page = parseInt(params.page || "1");
    const pageSize = parseInt(params.pageSize || "50");

    const allPlaylists = await getPlaylists();
    const playlistResult = playlistId
        ? await getPlaylistTracks(playlistId, page, pageSize)
        : null;

    const activePlaylist = playlistId
        ? allPlaylists.find((p) => p.id === playlistId)
        : undefined;

    return (
        <PlaylistsClient
            playlists={allPlaylists}
            tracks={playlistResult?.tracks ?? []}
            total={playlistResult?.total ?? 0}
            page={playlistResult?.page ?? 1}
            pageSize={playlistResult?.pageSize ?? 50}
            totalPages={playlistResult?.totalPages ?? 0}
            activePlaylist={activePlaylist}
        />
    );
}
