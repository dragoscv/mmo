import { auth } from "@/auth";
import { db } from "@/db";
import { tvShows } from "@/db/schema";
import { desc, eq } from "drizzle-orm";
import Link from "next/link";
import { PosterCard } from "@/components/video/poster-card";

export const dynamic = "force-dynamic";

export default async function ShowsPage() {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) return <main style={{ padding: "2rem" }}><p>Autentifică-te.</p></main>;
    const rows = await db.select().from(tvShows).where(eq(tvShows.userId, userId)).orderBy(desc(tvShows.addedAt));
    return (
        <main>
            <header style={{ padding: "2rem 1.5rem 0" }}>
                <h1 style={{ fontSize: "2rem", fontWeight: 800 }}>Serialele tale</h1>
                <p style={{ color: "var(--watch-fg-dim)" }}>{rows.length} seriale</p>
            </header>
            {rows.length === 0 ? (
                <div style={{ padding: "4rem 2rem", color: "var(--watch-fg-dim)" }}>
                    <p>Niciun serial încă. <Link href="/watch" style={{ color: "var(--watch-accent)" }}>Rulează un scan.</Link></p>
                </div>
            ) : (
                <div className="watch-grid">
                    {rows.map((s) => (
                        <PosterCard key={s.id} href={`/watch/shows/${s.id}`}
                            title={s.title} year={s.firstAirYear} posterPath={s.posterPath}
                            transitionName={`show-${s.id}`} />
                    ))}
                </div>
            )}
        </main>
    );
}
