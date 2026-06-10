import { listRecordings } from "@/actions/recordings";
import { MusicDashboardClient, type MusicSourceStat } from "./music-client";
import { auth } from "@/auth";
import { redirect } from "next/navigation";
import type { RecordingSource } from "@/actions/recordings";

export const dynamic = "force-dynamic";

const SOURCES: RecordingSource[] = ["live", "mixer", "daw", "editor"];

export default async function MusicOverviewPage() {
    const session = await auth();
    if (!session?.user?.id) redirect("/login?from=/music");

    const recordings = await listRecordings({ limit: 200 }).catch(() => []);

    const bySource = new Map<RecordingSource, { count: number; bytes: number; durationMs: number }>();
    for (const s of SOURCES) bySource.set(s, { count: 0, bytes: 0, durationMs: 0 });
    let totalBytes = 0;
    let totalDurationMs = 0;
    let favorites = 0;
    let lastAt: string | null = null;
    for (const r of recordings) {
        const src = (SOURCES as string[]).includes(r.source) ? (r.source as RecordingSource) : null;
        if (src) {
            const cur = bySource.get(src)!;
            cur.count += 1;
            cur.bytes += r.sizeBytes ?? 0;
            cur.durationMs += r.durationMs ?? 0;
        }
        totalBytes += r.sizeBytes ?? 0;
        totalDurationMs += r.durationMs ?? 0;
        if (r.isFavorite) favorites += 1;
        const created = r.createdAt ? new Date(r.createdAt as unknown as string).toISOString() : null;
        if (created && (!lastAt || created > lastAt)) lastAt = created;
    }

    const sourceStats: MusicSourceStat[] = SOURCES.map((s) => ({
        source: s,
        ...bySource.get(s)!,
    }));

    const recent = recordings
        .slice()
        .sort((a, b) => {
            const ta = a.createdAt ? new Date(a.createdAt as unknown as string).getTime() : 0;
            const tb = b.createdAt ? new Date(b.createdAt as unknown as string).getTime() : 0;
            return tb - ta;
        })
        .slice(0, 5)
        .map((r) => ({
            id: r.id,
            name: r.name,
            source: r.source,
            durationMs: r.durationMs,
            sizeBytes: r.sizeBytes,
            createdAt: r.createdAt ? new Date(r.createdAt as unknown as string).toISOString() : null,
            isFavorite: !!r.isFavorite,
        }));

    return (
        <MusicDashboardClient
            totals={{
                recordings: recordings.length,
                bytes: totalBytes,
                durationMs: totalDurationMs,
                favorites,
                lastAt,
            }}
            sourceStats={sourceStats}
            recent={recent}
        />
    );
}
