/**
 * Availability resolver: where can this title be watched in `region`?
 *
 * Chain (first hit wins, cached in `availability`):
 *   1. Movie of the Night v4 — `GET /shows/{kind}/{tmdbId}?country=ro`
 *      (header `X-API-Key`, https://docs.movieofthenight.com/guide/authentication)
 *      → exact deep links, cached 7 d.
 *   2. TMDB `watch/providers` from the cached title (JustWatch data) → offers
 *      without exact link, launch.search filled, cached 24 h.
 *   3. `none`.
 *
 * Attribution: "JustWatch" whenever TMDB provider data is shown (TMDB ToS),
 * "Movie of the Night" when MOTN data is shown.
 */

import type { MediaDb } from "./db";
import type { FetchLike, TmdbClient } from "./tmdb";
import { KEY_TO_TMDB_ID, MOTN_SERVICE_TO_KEY, ProviderRegistry } from "./providers";
import type { Availability, MediaKind, MediaLogger, Offer, OfferType, TmdbProviderRef, TmdbRegionProviders } from "./types";

export const MOTN_BASE = "https://api.movieofthenight.com/v4";
export const MOTN_TTL_MS = 7 * 24 * 3600_000;
export const TMDB_AVAIL_TTL_MS = 24 * 3600_000;

export interface AvailabilityDeps {
    db: MediaDb;
    tmdb: TmdbClient;
    registry: ProviderRegistry;
    motnApiKey?: string;
    fetch?: FetchLike;
    log?: MediaLogger;
    now?: () => number;
}

interface MotnStreamingOption {
    service?: { id?: string; name?: string; imageSet?: { lightThemeImage?: string; darkThemeImage?: string } };
    type?: string;
    link?: string;
    videoLink?: string;
    quality?: string;
    expiresSoon?: boolean;
}

interface MotnShow {
    tmdbId?: string;
    streamingOptions?: Record<string, MotnStreamingOption[]>;
}

function motnType(t: string | undefined): OfferType {
    switch (t) {
        case "subscription": return "subscription";
        case "rent": return "rent";
        case "buy": return "buy";
        case "free": return "free";
        case "addon": return "subscription";
        default: return "ads";
    }
}

/** Pure: MOTN streamingOptions[region] → offers via our registry. */
export function mapMotnOffers(
    options: MotnStreamingOption[] | undefined,
    registry: ProviderRegistry,
    kind: MediaKind,
    tmdbId: number,
    title: string,
): Offer[] {
    if (!options) return [];
    const out: Offer[] = [];
    const seen = new Set<string>();
    for (const o of options) {
        const serviceId = o.service?.id ?? "";
        const key = MOTN_SERVICE_TO_KEY[serviceId];
        const type = motnType(o.type);
        const dedupe = `${serviceId}:${type}`;
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        const providerId = key ? KEY_TO_TMDB_ID[key] ?? 0 : 0;
        const resolved = registry.resolveProvider(providerId, {
            name: o.service?.name,
            logo: o.service?.imageSet?.lightThemeImage ?? null,
        });
        const launch = resolved.launch(kind, tmdbId, title);
        if (o.link) {
            launch.web = o.link;
            if (launch.android) launch.android.uri = o.link;
            if (launch.tizen) launch.tizen.payload = o.link;
        }
        out.push({
            providerId,
            name: resolved.name,
            logo: resolved.logo,
            type,
            link: o.link,
            launch,
        });
    }
    return out;
}

/** Pure: TMDB watch/providers for a region → offers (no exact link). */
export function mapTmdbOffers(
    region: TmdbRegionProviders | undefined,
    registry: ProviderRegistry,
    kind: MediaKind,
    tmdbId: number,
    title: string,
): Offer[] {
    if (!region) return [];
    const out: Offer[] = [];
    const seen = new Set<string>();
    const push = (list: TmdbProviderRef[] | undefined, type: OfferType) => {
        for (const p of list ?? []) {
            const dedupe = `${p.provider_id}:${type}`;
            if (seen.has(dedupe)) continue;
            seen.add(dedupe);
            const resolved = registry.resolveProvider(p.provider_id, {
                name: p.provider_name,
                logo: p.logo_path,
                priority: p.display_priority,
            });
            out.push({
                providerId: p.provider_id,
                name: resolved.name,
                logo: resolved.logo,
                type,
                launch: resolved.launch(kind, tmdbId, title),
            });
        }
    };
    push(region.flatrate, "subscription");
    push(region.free, "free");
    push(region.ads, "ads");
    push(region.rent, "rent");
    push(region.buy, "buy");
    return out;
}

export class AvailabilityResolver {
    readonly motnConfigured: boolean;
    private readonly fetchImpl: FetchLike;
    private readonly now: () => number;

    constructor(private readonly deps: AvailabilityDeps) {
        this.motnConfigured = Boolean(deps.motnApiKey?.trim());
        this.fetchImpl = deps.fetch ?? ((url, init) => fetch(url, init) as unknown as ReturnType<FetchLike>);
        this.now = deps.now ?? Date.now;
    }

    private readCache(kind: MediaKind, tmdbId: number, region: string): Availability | null {
        const row = this.deps.db
            .prepare("SELECT source, json, fetched_at FROM availability WHERE kind = ? AND tmdb_id = ? AND region = ?")
            .get(kind, tmdbId, region) as { source: string; json: string; fetched_at: number } | undefined;
        if (!row) return null;
        const ttl = row.source === "motn" ? MOTN_TTL_MS : TMDB_AVAIL_TTL_MS;
        if (this.now() - row.fetched_at > ttl) return null;
        // A cached `none` should not block a freshly configured MOTN key.
        if (row.source === "none" && this.motnConfigured) return null;
        try { return { ...(JSON.parse(row.json) as Availability), fetchedAt: row.fetched_at }; } catch { return null; }
    }

    private writeCache(kind: MediaKind, tmdbId: number, region: string, a: Availability): void {
        this.deps.db.prepare(
            `INSERT INTO availability (kind, tmdb_id, region, source, json, fetched_at) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(kind, tmdb_id, region) DO UPDATE SET source = excluded.source, json = excluded.json, fetched_at = excluded.fetched_at`,
        ).run(kind, tmdbId, region, a.source, JSON.stringify({ offers: a.offers, source: a.source, attribution: a.attribution }), this.now());
    }

    /** Returns null on 404/no key/network error (→ fall through to TMDB). */
    private async fetchMotn(kind: MediaKind, tmdbId: number, region: string): Promise<MotnShow | null> {
        if (!this.motnConfigured) return null;
        const url = `${MOTN_BASE}/shows/${kind}/${tmdbId}?country=${encodeURIComponent(region.toLowerCase())}&series_granularity=show`;
        try {
            const res = await this.fetchImpl(url, { headers: { "X-API-Key": this.deps.motnApiKey!.trim(), accept: "application/json" } });
            if (!res.ok) {
                if (res.status !== 404) this.deps.log?.warn("[media/motn] http error", { status: res.status, kind, tmdbId });
                return null;
            }
            return (await res.json()) as MotnShow;
        } catch (err) {
            this.deps.log?.warn("[media/motn] fetch failed", { kind, tmdbId }, err);
            return null;
        }
    }

    async getAvailability(kind: MediaKind, tmdbId: number, regionIn?: string): Promise<Availability> {
        const region = (regionIn ?? this.deps.tmdb.region).toUpperCase();
        const cached = this.readCache(kind, tmdbId, region);
        if (cached) return cached;

        const title = this.deps.tmdb.getCachedTitle(kind, tmdbId) ?? (await this.deps.tmdb.getTitle(kind, tmdbId));
        const name = title?.title ?? title?.originalTitle ?? "";

        const motn = await this.fetchMotn(kind, tmdbId, region);
        if (motn) {
            const options = motn.streamingOptions?.[region.toLowerCase()] ?? motn.streamingOptions?.[region];
            const offers = mapMotnOffers(options, this.deps.registry, kind, tmdbId, name);
            if (offers.length > 0) {
                const a: Availability = { offers, source: "motn", attribution: ["Movie of the Night"] };
                this.writeCache(kind, tmdbId, region, a);
                return { ...a, fetchedAt: this.now() };
            }
        }

        const regionData = title?.watchProviders?.[region];
        const offers = mapTmdbOffers(regionData, this.deps.registry, kind, tmdbId, name);
        if (offers.length > 0) {
            const a: Availability = { offers, source: "tmdb", attribution: ["JustWatch"] };
            this.writeCache(kind, tmdbId, region, a);
            return { ...a, fetchedAt: this.now() };
        }

        const none: Availability = { offers: [], source: "none", attribution: [] };
        this.writeCache(kind, tmdbId, region, none);
        return { ...none, fetchedAt: this.now() };
    }
}
