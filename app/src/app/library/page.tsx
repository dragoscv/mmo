import { getTracks, getGenres, getAllTags, getKeys } from "@/actions/tracks";
import { LibraryClient } from "./library-client";
import { auth } from "@/auth";
import { getCompanionLink } from "@/lib/companion-library";
import { NotSignedIn, NoCompanion } from "@/components/library-empty-state";

export const dynamic = "force-dynamic";

export default async function LibraryPage({
    searchParams,
}: {
    searchParams: Promise<Record<string, string | undefined>>;
}) {
    const params = await searchParams;

    // Library is per-user and lives on the companion. Bail out early
    // when we can't reach either, rather than rendering an empty grid.
    const session = await auth();
    if (!session?.user?.id) return <NotSignedIn feature="your library" />;
    const link = await getCompanionLink();
    if (!link) return <NoCompanion feature="your library" />;

    const page = parseInt(params.page || "1");
    const pageSize = parseInt(params.pageSize || "50");
    const sort = params.sort || "addedAt";
    const order = (params.order || "desc") as "asc" | "desc";

    const [result, genres, allTags, keys] = await Promise.all([
        getTracks({
            page,
            pageSize,
            sort,
            order,
            genre: params.genre || undefined,
            search: params.search || undefined,
            energy: params.energy ? parseInt(params.energy) : undefined,
            key: params.key || undefined,
            isFavorite: params.favorites === "true" ? true : undefined,
            tag: params.tag || undefined,
            rating: params.rating ? parseInt(params.rating) : undefined,
            minBpm: params.minBpm ? parseInt(params.minBpm) : undefined,
            maxBpm: params.maxBpm ? parseInt(params.maxBpm) : undefined,
            album: params.album || undefined,
            artist: params.artist || undefined,
            year: params.year ? parseInt(params.year) : undefined,
            label: params.label || undefined,
            subgenre: params.subgenre || undefined,
            mood: params.mood || undefined,
        }),
        getGenres(),
        getAllTags(),
        getKeys(),
    ]);

    return (
        <LibraryClient
            tracks={result.tracks}
            total={result.total}
            page={result.page}
            pageSize={result.pageSize}
            totalPages={result.totalPages}
            genres={genres}
            allTags={allTags}
            keys={keys}
            currentSort={sort}
            currentOrder={order}
            currentFilters={{
                genre: params.genre || "",
                search: params.search || "",
                energy: params.energy || "",
                key: params.key || "",
                favorites: params.favorites || "",
                tag: params.tag || "",
                rating: params.rating || "",
                minBpm: params.minBpm || "",
                maxBpm: params.maxBpm || "",
                album: params.album || "",
                artist: params.artist || "",
                year: params.year || "",
                label: params.label || "",
                subgenre: params.subgenre || "",
                mood: params.mood || "",
            }}
        />
    );
}
