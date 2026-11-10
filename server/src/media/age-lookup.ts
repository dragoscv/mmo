/**
 * Ages for profiles with an age limit.
 *
 * TMDB list endpoints (search, trending, recommendations, similar) carry no certification: the minimum age of a
 * title is only known once its details were fetched (`titles` cache, 30 d). A list filtered on cached ages alone
 * therefore let through every title nobody had opened yet. `resolve()` fetches the missing details first, with a
 * bounded number of lookups in flight and a time budget per call. Whatever is still unknown when the budget ends
 * stays hidden for that response (`allowedForAge` blocks an unknown age) and keeps loading in the background.
 * Queued lookups are served newest request first: the request a viewer is waiting on now (a search) must not sit
 * behind the backlog of an earlier one (the first Library of a kid profile on a server with thousands of titles).
 * Within one request the titles keep their list order, so the top of a page resolves first.
 */

import type { MediaKind } from "./types";

export interface TitleRef {
    kind: MediaKind;
    tmdbId: number;
}

/** `age`: a number, `null` = looked up but unrated, `undefined` = never looked up. */
export interface TitleRating {
    age: number | null | undefined;
    genreIds: number[];
}

/** The part of `TmdbClient` this needs (a fake in tests). */
export interface AgeSource {
    readonly configured: boolean;
    getCachedTitle(kind: MediaKind, tmdbId: number): { age?: number | null; genreIds: number[] } | null;
    /** Same answer as `getCachedTitle` for `age` and `genreIds`, without parsing the whole row. */
    getCachedRating?(kind: MediaKind, tmdbId: number): { age: number | null | undefined; genreIds: number[] } | null;
    getTitle(kind: MediaKind, tmdbId: number, opts?: { force?: boolean }): Promise<{ age?: number | null } | null>;
}

export interface AgeLookupOptions {
    /** Title lookups in flight at once, across all callers (the TMDB client allows 30 requests per second). */
    concurrency?: number;
    /** How long one `resolve()` call waits. */
    budgetMs?: number;
    /** A failed lookup is not repeated for this long. */
    retryAfterMs?: number;
    now?: () => number;
}

export const AGE_LOOKUP_CONCURRENCY = 8;
export const AGE_LOOKUP_BUDGET_MS = 6000;
export const AGE_LOOKUP_RETRY_MS = 10 * 60_000;
const MAX_REMEMBERED_FAILURES = 5000;

const keyOf = (t: TitleRef): string => `${t.kind}:${t.tmdbId}`;

export class AgeLookup {
    private readonly concurrency: number;
    private readonly budgetMs: number;
    private readonly retryAfterMs: number;
    private readonly now: () => number;
    private readonly inflight = new Map<string, Promise<void>>();
    private readonly failedAt = new Map<string, number>();
    /** Stack of requests; each request is a FIFO of lookups waiting for a slot. */
    private readonly waiting: (() => void)[][] = [];
    private active = 0;

    constructor(private readonly source: AgeSource, opts: AgeLookupOptions = {}) {
        this.concurrency = Math.max(1, opts.concurrency ?? AGE_LOOKUP_CONCURRENCY);
        this.budgetMs = opts.budgetMs ?? AGE_LOOKUP_BUDGET_MS;
        this.retryAfterMs = opts.retryAfterMs ?? AGE_LOOKUP_RETRY_MS;
        this.now = opts.now ?? Date.now;
    }

    /** Rating from the title cache only (no network). */
    rating(kind: MediaKind, tmdbId: number): TitleRating {
        return this.cachedRating(kind, tmdbId) ?? { age: undefined, genreIds: [] };
    }

    /** `null` when the title was never cached. */
    private cachedRating(kind: MediaKind, tmdbId: number): TitleRating | null {
        if (this.source.getCachedRating) return this.source.getCachedRating(kind, tmdbId);
        const t = this.source.getCachedTitle(kind, tmdbId);
        return t ? { age: t.age, genreIds: t.genreIds } : null;
    }

    /**
     * Fetches the details of every listed title whose age is not cached yet and waits for them, at most
     * `budgetMs`. A lookup that fails leaves the age unknown (and is remembered, see `retryAfterMs`).
     */
    async resolve(titles: Iterable<TitleRef>, budgetMs: number = this.budgetMs): Promise<void> {
        if (!this.source.configured) return;
        const pending: Promise<void>[] = [];
        const seen = new Set<string>();
        const startedAt = this.now();
        const batch: (() => void)[] = [];
        this.waiting.push(batch);
        for (const title of titles) {
            const key = keyOf(title);
            if (seen.has(key)) continue;
            seen.add(key);
            const running = this.inflight.get(key);
            if (running) {
                pending.push(running);
                continue;
            }
            const cached = this.cachedRating(title.kind, title.tmdbId);
            if (cached && cached.age !== undefined) continue;
            const failed = this.failedAt.get(key);
            if (failed !== undefined && startedAt - failed < this.retryAfterMs) continue;
            // A row cached before ratings existed has no `age`; `getTitle` would serve it from the cache until its
            // 30-day TTL ends, so the refetch is forced.
            const lookup = this.lookup(key, title, cached !== null, batch);
            this.inflight.set(key, lookup);
            pending.push(lookup);
        }
        if (pending.length === 0) return;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const budget = new Promise<void>((done) => {
            timer = setTimeout(done, budgetMs);
        });
        try {
            await Promise.race([Promise.all(pending), budget]);
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    private async lookup(key: string, title: TitleRef, force: boolean, batch: (() => void)[]): Promise<void> {
        await this.acquire(batch);
        try {
            const details = await this.source.getTitle(title.kind, title.tmdbId, force ? { force: true } : {});
            if (details && details.age !== undefined) this.failedAt.delete(key);
            else this.rememberFailure(key);
        } catch {
            this.rememberFailure(key);
        } finally {
            this.release();
            this.inflight.delete(key);
        }
    }

    private rememberFailure(key: string): void {
        if (this.failedAt.size >= MAX_REMEMBERED_FAILURES) this.failedAt.clear();
        this.failedAt.set(key, this.now());
    }

    private acquire(batch: (() => void)[]): Promise<void> {
        if (this.active < this.concurrency) {
            this.active++;
            return Promise.resolve();
        }
        return new Promise((granted) => {
            batch.push(granted);
        });
    }

    /** Hands the slot to the first waiter of the newest request that still has one, or frees it. */
    private release(): void {
        while (this.waiting.length > 0) {
            const next = this.waiting[this.waiting.length - 1]!.shift();
            if (next) {
                next();
                return;
            }
            this.waiting.pop();
        }
        this.active--;
    }
}
