/**
 * Multi-server fan-out + merge for Media Home (WP11-02).
 *
 * The user may have several MMO Servers (desktop, NAS, Pi). Media Home asks
 * every online server the same question, then merges by TMDB id so a film
 * owned on two machines is ONE card with two `sources[]` chips.
 *
 * Pure merge helpers (`mergeTitlesByTmdbId`, `mergeRows`) have no I/O and
 * are unit-tested; the fan-out wrappers live at the bottom and reuse the
 * companion link resolvers from `companion-library.ts`.
 */

import type { HomeRow, MediaServer, MergedTitle, TitleCard, TitleSource } from "./types";

export interface ServerResult<T> {
    serverId: string;
    name: string;
    data: T;
}

export interface ServerError {
    serverId: string;
    name: string;
    error: string;
}

export interface FanOutResult<T> {
    results: ServerResult<T>[];
    errors: ServerError[];
}

const titleKey = (t: Pick<TitleCard, "kind" | "tmdbId">) => `${t.kind}:${t.tmdbId}`;

const maxNullable = (a: number | null | undefined, b: number | null | undefined): number | null => {
    if (a == null) return b ?? null;
    if (b == null) return a;
    return Math.max(a, b);
};

function sourceKey(s: TitleSource) {
    return `${s.serverId}:${s.fileId}`;
}

/** Tag each source with the server it came from when the server omitted it. */
function attributedSources(card: TitleCard, serverId: string, serverName: string): TitleSource[] {
    return (card.sources ?? []).map((s) => ({
        ...s,
        serverId: s.serverId || serverId,
        serverName: s.serverName || serverName,
    }));
}

/**
 * Merge per-server title lists into one list keyed by `kind:tmdbId`.
 * - first occurrence wins for descriptive fields, later ones fill nulls;
 * - `sources` = union (deduped by server+file);
 * - `progress` = max across servers (the furthest the user got anywhere);
 * - `inLibrary` = any server has a source.
 * Order = first-seen order (stable across servers so rows don't reshuffle).
 */
export function mergeTitlesByTmdbId(results: ServerResult<TitleCard[]>[]): MergedTitle[] {
    const map = new Map<string, MergedTitle>();
    for (const r of results) {
        for (const card of r.data) {
            const key = titleKey(card);
            const sources = attributedSources(card, r.serverId, r.name);
            const existing = map.get(key);
            if (!existing) {
                const { sources: _s, inLibrary, ...rest } = card;
                map.set(key, {
                    ...rest,
                    sources,
                    inLibrary: inLibrary || sources.length > 0,
                });
                continue;
            }
            const seen = new Set(existing.sources.map(sourceKey));
            for (const s of sources) {
                if (!seen.has(sourceKey(s))) {
                    existing.sources.push(s);
                    seen.add(sourceKey(s));
                }
            }
            existing.inLibrary = existing.inLibrary || card.inLibrary || existing.sources.length > 0;
            existing.progress = maxNullable(existing.progress, card.progress);
            existing.poster ??= card.poster ?? null;
            existing.backdrop ??= card.backdrop ?? null;
            existing.logo ??= card.logo ?? null;
            existing.rating ??= card.rating ?? null;
            existing.year ??= card.year ?? null;
        }
    }
    return [...map.values()];
}

/**
 * Merge `/media/home` responses from N servers. Rows with the same `id`
 * collapse into one; their items go through `mergeTitlesByTmdbId`. Row
 * order = order of first appearance (the first/online-first server sets it).
 */
export function mergeRows(results: ServerResult<HomeRow[]>[]): HomeRow[] {
    const order: string[] = [];
    const byId = new Map<string, { row: HomeRow; parts: ServerResult<TitleCard[]>[] }>();
    for (const r of results) {
        for (const row of r.data) {
            let entry = byId.get(row.id);
            if (!entry) {
                entry = { row: { ...row, items: [] }, parts: [] };
                byId.set(row.id, entry);
                order.push(row.id);
            }
            entry.row.reason ??= row.reason ?? null;
            entry.parts.push({ serverId: r.serverId, name: r.name, data: row.items });
        }
    }
    return order.map((id) => {
        const { row, parts } = byId.get(id)!;
        return { ...row, items: mergeTitlesByTmdbId(parts) };
    });
}

// ─── Fan-out (server-only I/O) ──────────────────────────────────────────────

/** All paired MMO Servers for the signed-in user, online-first. */
export async function getMediaServers(): Promise<MediaServer[]> {
    const { getAllCompanionLinks } = await import("@/lib/companion-library");
    const links = await getAllCompanionLinks();
    return links.map((l) => ({
        id: l.deviceId,
        name: l.name,
        online: l.online,
        apiUrl: l.apiUrl,
        lastSeenAt: l.lastSeenAt,
    }));
}

export interface FetchFromAllOptions {
    /** Skip servers whose heartbeat is stale (default true). */
    onlineOnly?: boolean;
    /** Per-server timeout (default 4 s — Home must not wait on a sleeping NAS). */
    timeoutMs?: number;
}

/**
 * GET `path` (e.g. `/media/home?profile=3`) on every server in parallel.
 * One slow/offline server never fails the page: it lands in `errors` and the
 * UI renders an "unreachable" chip for it.
 */
export async function fetchFromAllServers<T>(
    path: string,
    opts: FetchFromAllOptions = {},
): Promise<FanOutResult<T>> {
    const { aggregateAcrossCompanions } = await import("@/lib/companion-library");
    const timeoutMs = opts.timeoutMs ?? 4000;
    const { results, errors } = await aggregateAcrossCompanions<T>(async (link) => {
        const res = await fetch(`${link.apiUrl}${path}`, {
            headers: { "X-Device-Token": link.token, "X-User-Id": link.userId },
            signal: AbortSignal.timeout(timeoutMs),
            cache: "no-store",
        });
        if (!res.ok) throw new Error(`GET ${path} failed (${res.status})`);
        return (await res.json()) as T;
    }, { onlineOnly: opts.onlineOnly ?? true });
    return {
        results: results.map((r) => ({ serverId: r.link.deviceId, name: r.link.name, data: r.value })),
        errors: errors.map((e) => ({ serverId: e.deviceId, name: e.name, error: e.error })),
    };
}
