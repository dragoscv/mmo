import { notFound, redirect } from "next/navigation";

/**
 * Legacy TMDB-only detail route. The unified title page (`/media/movie/[id]`,
 * WP11-04) replaces it — keep this as a permanent redirect so old links,
 * bookmarks and PWA history still resolve.
 */
export default async function DiscoverMovieRedirect({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    if (!/^\d+$/.test(id)) notFound();
    redirect(`/media/movie/${id}`);
}
