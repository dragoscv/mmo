/**
 * Media module wiring. Call once at server boot, then mount
 * `module.router` behind authMiddleware (WP10-07).
 */

import type express from "express";
import { openMediaDb, type MediaDb } from "./db";
import { TmdbClient } from "./tmdb";
import { ProviderRegistry } from "./providers";
import { AvailabilityResolver } from "./availability";
import { ProgressStore } from "./progress";
import { LibraryIndex } from "./library";
import { MediaSyncClient } from "./sync-client";
import { createMediaRouter } from "./routes";
import type { MediaLogger } from "./types";

export interface MediaModuleOptions {
    userDataDir: string;
    env: NodeJS.ProcessEnv | Record<string, string | undefined>;
    log: MediaLogger;
    getServerId?: () => string;
    getServerName?: () => string;
    /** Enable the push client to the web app (`POST {webAppUrl}/api/media/sync`). */
    sync?: {
        getWebAppUrl: () => string | undefined;
        getDeviceToken: () => string | undefined;
    };
}

export interface MediaModule {
    db: MediaDb;
    tmdb: TmdbClient;
    registry: ProviderRegistry;
    availability: AvailabilityResolver;
    progress: ProgressStore;
    library: LibraryIndex;
    sync: MediaSyncClient | null;
    router: express.Router;
    region: string;
    language: string;
    configured: { tmdb: boolean; motn: boolean };
    close(): void;
}

export function createMediaModule(opts: MediaModuleOptions): MediaModule {
    const region = (opts.env.MEDIA_REGION?.trim() || "RO").toUpperCase();
    const language = opts.env.MEDIA_LANG?.trim() || "ro-RO";
    const db = openMediaDb(opts.userDataDir);
    const tmdb = new TmdbClient(db, { apiKey: opts.env.TMDB_API_KEY, language, region, log: opts.log });
    const registry = new ProviderRegistry(db, tmdb, opts.log);
    const availability = new AvailabilityResolver({ db, tmdb, registry, motnApiKey: opts.env.MOTN_API_KEY, log: opts.log });
    const progress = new ProgressStore(db);
    const library = new LibraryIndex(db, tmdb, opts.log);
    const sync = opts.sync
        ? new MediaSyncClient({
            db, progress, log: opts.log,
            getWebAppUrl: opts.sync.getWebAppUrl,
            getDeviceToken: opts.sync.getDeviceToken,
            getDeviceId: () => opts.getServerId?.() ?? "",
        })
        : null;
    const router = createMediaRouter({
        db, tmdb, registry, availability, progress, library, sync: sync ?? undefined, region, log: opts.log,
        getServerId: opts.getServerId, getServerName: opts.getServerName,
    });

    if (!tmdb.configured) opts.log.info("[media] TMDB_API_KEY missing — media module runs in no-op mode");
    else void registry.refreshProviderCatalog(region).catch((err: unknown) => opts.log.warn("[media] provider catalog refresh failed", {}, err));
    if (!availability.motnConfigured) opts.log.info("[media] MOTN_API_KEY missing — deep links fall back to TMDB/JustWatch + search URLs");
    sync?.start();

    return {
        db, tmdb, registry, availability, progress, library, sync, router, region, language,
        configured: { tmdb: tmdb.configured, motn: availability.motnConfigured },
        close: () => { sync?.stop(); try { db.close(); } catch { /* ignore */ } },
    };
}

export { createMediaRouter } from "./routes";
export { openMediaDb, openMemoryMediaDb } from "./db";
export { TmdbClient } from "./tmdb";
export { ProviderRegistry } from "./providers";
export { AvailabilityResolver } from "./availability";
export { ProgressStore } from "./progress";
export { LibraryIndex, makeServerFileId } from "./library";
export { MediaSyncClient } from "./sync-client";
export * from "./types";
