import { auth } from "@/auth";
import { db } from "@/db";
import { movies, videoFiles } from "@/db/schema";
import { and, desc, eq } from "drizzle-orm";
import Link from "next/link";
import { PosterCard } from "@/components/video/poster-card";

export const dynamic = "force-dynamic";

export default async function MoviesPage() {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) return <main style={{ padding: "2rem" }}><p>Autentifică-te.</p></main>;
    const rows = await db.select().from(movies).where(eq(movies.userId, userId)).orderBy(desc(movies.addedAt));
    return (
        <main>
            <header style={{ padding: "2rem 1.5rem 0" }}>
                <h1 style={{ fontSize: "2rem", fontWeight: 800 }}>Filmele tale</h1>
                <p style={{ color: "var(--watch-fg-dim)" }}>{rows.length} filme</p>
            </header>
            {rows.length === 0 ? (
                <div style={{ padding: "4rem 2rem", color: "var(--watch-fg-dim)" }}>
                    <p>Niciun film încă. <Link href="/watch" style={{ color: "var(--watch-accent)" }}>Rulează un scan.</Link></p>
                </div>
            ) : (
                <div className="watch-grid">
                    {rows.map((m) => (
                        <PosterCard key={m.id} href={`/watch/movies/${m.id}`}
                            title={m.title} year={m.year} posterPath={m.posterPath}
                            transitionName={`movie-${m.id}`} />
                    ))}
                </div>
            )}
        </main>
    );
}
