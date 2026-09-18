/**
 * Streaming provider registry (RO focus), keyed by TMDB `provider_id`.
 *
 * Static part = launch data (web deep link builder, Android package, Tizen
 * app id, provider search URL). Live part = name/logo/priority from
 * `GET /watch/providers/{movie|tv}?watch_region=RO` (24 h cache in
 * `recs_cache`) — the live catalog wins for display fields, the static
 * table provides what TMDB does not know (how to launch the app).
 *
 * TMDB ids used here were cross-checked against the RO catalog at authoring
 * time; `refreshProviderCatalog()` re-validates at runtime and logs any id
 * whose live name does not match our alias list.
 */

import type { MediaDb } from "./db";
import { cacheGet, cacheSet } from "./db";
import type { TmdbClient, ProviderCatalogEntry } from "./tmdb";
import type { LaunchData, MediaKind, MediaLogger } from "./types";

export interface ProviderStatic {
    /** Canonical key shared with MOTN service ids (netflix, prime, disney, hbo, apple, …). */
    key: string;
    name: string;
    /** Lower-case substrings that identify this provider in TMDB's `provider_name`. */
    aliases: string[];
    web?: (kind: MediaKind, tmdbId: number, title: string) => string | undefined;
    android?: { package: string; uri?: (title: string) => string };
    tizen?: { appId: string; payload?: (title: string) => string };
    search: (title: string) => string;
}

export interface ResolvedProvider {
    providerId: number;
    key: string | null;
    name: string;
    logo: string | null;
    displayPriority: number;
    launch: (kind: MediaKind, tmdbId: number, title: string) => LaunchData;
}

const q = (s: string) => encodeURIComponent(s);

const netflix: ProviderStatic = {
    key: "netflix", name: "Netflix", aliases: ["netflix"],
    android: { package: "com.netflix.ninja", uri: (t) => `https://www.netflix.com/search?q=${q(t)}` },
    tizen: { appId: "3201907018807" },
    search: (t) => `https://www.netflix.com/search?q=${q(t)}`,
};
const prime: ProviderStatic = {
    key: "prime", name: "Amazon Prime Video", aliases: ["amazon prime", "prime video"],
    android: { package: "com.amazon.amazonvideo.livingroom" },
    tizen: { appId: "3201910019365" },
    search: (t) => `https://www.primevideo.com/search/ref=atv_nb_sr?phrase=${q(t)}`,
};
const disney: ProviderStatic = {
    key: "disney", name: "Disney Plus", aliases: ["disney"],
    android: { package: "com.disney.disneyplus" },
    tizen: { appId: "3201901017640" },
    search: (t) => `https://www.disneyplus.com/search/${q(t)}`,
};
const hbo: ProviderStatic = {
    key: "hbo", name: "HBO Max", aliases: ["hbo max", "max"],
    android: { package: "com.wbd.stream" },
    tizen: { appId: "3202301029760" },
    search: (t) => `https://play.max.com/search?q=${q(t)}`,
};
const apple: ProviderStatic = {
    key: "apple", name: "Apple TV+", aliases: ["apple tv"],
    android: { package: "com.apple.atve.androidtv.appletv" },
    tizen: { appId: "3201807016597" },
    search: (t) => `https://tv.apple.com/ro/search?term=${q(t)}`,
};
const skyshowtime: ProviderStatic = {
    key: "skyshowtime", name: "SkyShowtime", aliases: ["skyshowtime"],
    android: { package: "com.skyshowtime.skyshowtime.google" },
    tizen: { appId: "3202208028071" },
    search: (t) => `https://www.skyshowtime.com/ro/search?q=${q(t)}`,
};
const youtube: ProviderStatic = {
    key: "youtube", name: "YouTube", aliases: ["youtube"],
    android: { package: "com.google.android.youtube.tv", uri: (t) => `https://www.youtube.com/results?search_query=${q(t)}` },
    tizen: { appId: "111299001912", payload: (t) => `https://www.youtube.com/results?search_query=${q(t)}` },
    search: (t) => `https://www.youtube.com/results?search_query=${q(t)}`,
};
const googleplay: ProviderStatic = {
    key: "google", name: "Google Play Movies", aliases: ["google play", "google tv"],
    android: { package: "com.google.android.videos" },
    search: (t) => `https://play.google.com/store/search?c=movies&q=${q(t)}`,
};
const voyo: ProviderStatic = {
    key: "voyo", name: "Voyo", aliases: ["voyo"],
    android: { package: "net.cme.voyo.ro.tvapp" },
    tizen: { appId: "111299000769" },
    search: (t) => `https://voyo.protv.ro/cauta?q=${q(t)}`,
};
const antenaplay: ProviderStatic = {
    key: "antenaplay", name: "AntenaPLAY", aliases: ["antena"],
    android: { package: "ro.antenaplay.app" },
    tizen: { appId: "3201611011005" },
    search: (t) => `https://antenaplay.ro/cauta?q=${q(t)}`,
};

/** TMDB provider_id → static launch data. Several ids may map to one provider
 *  (TMDB keeps historic ids: Prime 9 + Amazon Video 119, HBO Max 1899 + Max 384). */
export const STATIC_BY_TMDB_ID: Readonly<Record<number, ProviderStatic>> = {
    8: netflix,
    1796: netflix, // Netflix basic with Ads
    9: prime,
    119: prime,
    10: prime, // Amazon Video (rent/buy)
    337: disney,
    1899: hbo,
    384: hbo,
    350: apple,
    2: { ...apple, key: "apple", name: "Apple TV" }, // Apple TV (rent/buy)
    1773: skyshowtime,
    192: youtube,
    3: googleplay,
    1002: voyo,
    1932: antenaplay,
};

/** MOTN service id → canonical key (identical for the big ones). */
export const MOTN_SERVICE_TO_KEY: Readonly<Record<string, string>> = {
    netflix: "netflix",
    prime: "prime",
    disney: "disney",
    hbo: "hbo",
    apple: "apple",
    skyshowtime: "skyshowtime",
    youtube: "youtube",
    google: "google",
    voyo: "voyo",
    antenaplay: "antenaplay",
};

/** Canonical key → preferred TMDB provider id (for MOTN → registry mapping). */
export const KEY_TO_TMDB_ID: Readonly<Record<string, number>> = {
    netflix: 8, prime: 9, disney: 337, hbo: 1899, apple: 350, skyshowtime: 1773,
    youtube: 192, google: 3, voyo: 1002, antenaplay: 1932,
};

export const ALL_STATIC: readonly ProviderStatic[] = [netflix, prime, disney, hbo, apple, skyshowtime, youtube, googleplay, voyo, antenaplay];

export function staticByKey(key: string): ProviderStatic | undefined {
    return ALL_STATIC.find((p) => p.key === key);
}

export function buildLaunch(st: ProviderStatic | undefined, kind: MediaKind, tmdbId: number, title: string, exactLink?: string): LaunchData {
    const search = st ? st.search(title) : `https://www.google.com/search?q=${q(title)}`;
    const web = exactLink ?? st?.web?.(kind, tmdbId, title) ?? search;
    const launch: LaunchData = { web, search };
    if (st?.android) launch.android = { package: st.android.package, uri: exactLink ?? st.android.uri?.(title) };
    if (st?.tizen) launch.tizen = { appId: st.tizen.appId, payload: exactLink ?? st.tizen.payload?.(title) };
    return launch;
}

// ── live catalog ──────────────────────────────────────────────────────────

export interface ProviderCatalog {
    region: string;
    fetchedAt: number;
    /** Merged movie+tv catalog, sorted by display priority. */
    entries: ProviderCatalogEntry[];
}

export class ProviderRegistry {
    private live = new Map<number, ProviderCatalogEntry>();
    private liveRegion: string | null = null;

    constructor(private readonly db: MediaDb, private readonly tmdb: TmdbClient, private readonly log?: MediaLogger) {}

    async refreshProviderCatalog(region: string = this.tmdb.region): Promise<ProviderCatalog> {
        const key = `providers:catalog:${region}`;
        const cached = cacheGet<ProviderCatalog>(this.db, key, 24 * 3600_000);
        if (cached) { this.load(cached); return cached; }
        const [movie, tv] = await Promise.all([this.tmdb.providerCatalog("movie", region), this.tmdb.providerCatalog("tv", region)]);
        const byId = new Map<number, ProviderCatalogEntry>();
        for (const e of [...movie, ...tv]) {
            const prev = byId.get(e.provider_id);
            if (!prev || e.display_priority < prev.display_priority) byId.set(e.provider_id, e);
        }
        const catalog: ProviderCatalog = {
            region,
            fetchedAt: Date.now(),
            entries: [...byId.values()].sort((a, b) => a.display_priority - b.display_priority),
        };
        if (catalog.entries.length > 0) {
            cacheSet(this.db, key, catalog);
            this.validate(catalog);
        }
        this.load(catalog);
        return catalog;
    }

    private load(c: ProviderCatalog): void {
        this.live = new Map(c.entries.map((e) => [e.provider_id, e]));
        this.liveRegion = c.region;
    }

    /** Warn when a static id resolves to a live name none of our aliases match. */
    private validate(c: ProviderCatalog): void {
        for (const [idStr, st] of Object.entries(STATIC_BY_TMDB_ID)) {
            const id = Number(idStr);
            const live = c.entries.find((e) => e.provider_id === id);
            if (!live) continue;
            const name = live.provider_name.toLowerCase();
            if (!st.aliases.some((a) => name.includes(a))) {
                this.log?.warn("[media/providers] static id name mismatch", { id, live: live.provider_name, expected: st.name });
            }
        }
    }

    get catalogRegion(): string | null { return this.liveRegion; }

    listCatalog(): ProviderCatalogEntry[] {
        return [...this.live.values()];
    }

    resolveProvider(id: number, fallback?: { name?: string; logo?: string | null; priority?: number }): ResolvedProvider {
        const st = STATIC_BY_TMDB_ID[id];
        const live = this.live.get(id);
        return {
            providerId: id,
            key: st?.key ?? null,
            name: live?.provider_name ?? fallback?.name ?? st?.name ?? `Provider ${id}`,
            logo: live?.logo_path ?? fallback?.logo ?? null,
            displayPriority: live?.display_priority ?? fallback?.priority ?? 999,
            launch: (kind, tmdbId, title) => buildLaunch(st, kind, tmdbId, title),
        };
    }

    resolveByKey(key: string): ResolvedProvider | null {
        const id = KEY_TO_TMDB_ID[key];
        if (!id) return null;
        return this.resolveProvider(id);
    }
}
