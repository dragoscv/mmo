"use client";

/**
 * Lazy TMDB details for library entries (the server index has no titles/posters): a session-wide cache keyed by
 * profile + title, filled by a FIFO with at most 4 concurrent `/media/title` calls. Visible cards ask "urgent";
 * sorts/filters that need every title ask for the rest in the background. Port of Tizen `library-data.ts`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "@/lib/mmo/api";
import type { MediaClient } from "@/lib/mmo/media";
import { yearOf, type LibDetails, type LibEntry } from "./lib";

export type DetailState = LibDetails | "restricted" | "error";

const cache = new Map<string, DetailState>();
const MAX_CONCURRENT = 4;

const keyOf = (media: MediaClient, e: LibEntry) => `${media.profile}|${e.kind}:${e.tmdbId}`;

export function detailsOf(media: MediaClient, e: LibEntry): DetailState | undefined {
    return e.tmdbId == null ? undefined : cache.get(keyOf(media, e));
}

export class DetailResolver {
    private queue: LibEntry[] = [];
    private queued = new Set<string>();
    private running = 0;
    private dead = false;
    private timer: ReturnType<typeof setTimeout> | null = null;

    constructor(private readonly media: MediaClient, private readonly onBatch: () => void) {}

    want(list: readonly LibEntry[], urgent = false): void {
        const add: LibEntry[] = [];
        for (const e of list) {
            if (e.tmdbId == null) continue;
            const k = keyOf(this.media, e);
            if (cache.has(k) || this.queued.has(k)) continue;
            this.queued.add(k);
            add.push(e);
        }
        if (add.length === 0) return;
        this.queue = urgent ? add.concat(this.queue) : this.queue.concat(add);
        this.pump();
    }

    get pending(): number { return this.queue.length + this.running; }

    private pump(): void {
        while (!this.dead && this.running < MAX_CONCURRENT && this.queue.length > 0) {
            const e = this.queue.shift();
            if (!e) break;
            this.running++;
            void this.one(e).then(() => { this.running--; this.flush(); this.pump(); });
        }
    }

    private async one(e: LibEntry): Promise<void> {
        const k = keyOf(this.media, e);
        try {
            const d = e.tmdbId == null ? null : await this.media.mediaTitle(e.kind, e.tmdbId);
            if (!d) { cache.set(k, "error"); return; }
            cache.set(k, {
                title: d.title.title,
                posterPath: d.title.posterPath,
                backdropPath: d.title.backdropPath,
                year: yearOf(d.title.releaseDate),
                rating: d.title.voteAverage ?? 0,
                genres: (d.title.genres ?? []).map((g) => g.name).filter(Boolean),
            });
        } catch (err) {
            cache.set(k, err instanceof ApiError && err.status === 403 ? "restricted" : "error");
        } finally {
            this.queued.delete(k);
        }
    }

    private flush(): void {
        if (this.timer || this.dead) return;
        this.timer = setTimeout(() => { this.timer = null; if (!this.dead) this.onBatch(); }, this.pending === 0 ? 0 : 300);
    }

    dispose(): void {
        this.dead = true;
        this.queue = [];
        if (this.timer) clearTimeout(this.timer);
    }
}

/** React binding: `tick` bumps when a batch of details landed; `get` reads the cache. */
export function useLibDetails(media: MediaClient | null) {
    const [tick, setTick] = useState(0);
    const ref = useRef<DetailResolver | null>(null);
    useEffect(() => {
        if (!media) return;
        const r = new DetailResolver(media, () => setTick((n) => n + 1));
        ref.current = r;
        return () => { r.dispose(); ref.current = null; };
    }, [media]);
    const want = useCallback((list: readonly LibEntry[], urgent = false) => ref.current?.want(list, urgent), []);
    const get = useCallback((e: LibEntry): LibDetails | null => {
        if (!media) return null;
        const d = detailsOf(media, e);
        return d && typeof d === "object" ? d : null;
        // eslint-disable-next-line react-hooks/exhaustive-deps -- tick invalidates the memoised reader
    }, [media, tick]);
    const restricted = useCallback((e: LibEntry) => (media ? detailsOf(media, e) === "restricted" : false), [media]);
    const pending = useCallback(() => ref.current?.pending ?? 0, []);
    return useMemo(() => ({ tick, want, get, restricted, pending }), [tick, want, get, restricted, pending]);
}
