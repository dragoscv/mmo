/**
 * Live TV module wiring. Call once at boot, then mount `module.router`
 * at `/livetv` behind the device-token auth middleware.
 */

import fs from "node:fs";
import type express from "express";
import { openLiveTvDb, type LiveTvDb } from "./db";
import { LiveTvService } from "./service";
import { DvrScheduler, type SpawnFfmpeg } from "./recorder";
import { createLiveTvRouter } from "./routes";
import type { FetchLike, LiveTvLogger } from "./util";

export interface LiveTvModuleOptions {
    /** Directory for `livetv.sqlite` (the server userData dir). */
    userDataDir: string;
    /** Where finished recordings (.mkv) are written; `.partial/` holds in-progress captures. */
    recordingsDir: string;
    log: LiveTvLogger;
    fetch?: FetchLike;
    spawnFfmpeg?: SpawnFfmpeg;
    /** Start the refresh loop + DVR scheduler immediately (default true). */
    autoStart?: boolean;
}

export interface LiveTvModule {
    db: LiveTvDb;
    service: LiveTvService;
    dvr: DvrScheduler;
    router: express.Router;
    close(): void;
}

export function createLiveTvModule(opts: LiveTvModuleOptions): LiveTvModule {
    fs.mkdirSync(opts.recordingsDir, { recursive: true });
    const db = openLiveTvDb(opts.userDataDir);
    const service = new LiveTvService({ db, log: opts.log, fetch: opts.fetch });
    const dvr = new DvrScheduler({ db, service, recordingsDir: opts.recordingsDir, log: opts.log, spawnFfmpeg: opts.spawnFfmpeg });
    const router = createLiveTvRouter({ service, dvr, log: opts.log, fetch: opts.fetch });
    if (opts.autoStart !== false) {
        service.start();
        dvr.start();
    }
    return {
        db, service, dvr, router,
        close() {
            service.stop();
            dvr.stop();
            db.close();
        },
    };
}

export { openLiveTvDb, openMemoryLiveTvDb, type LiveTvDb } from "./db";
export { LiveTvService, expandCatchupTemplate, DEFAULT_TUNER_LIMIT, MAX_GUIDE_WINDOW_MS } from "./service";
export { DvrScheduler, recordArgs, remuxArgs, type SpawnFfmpeg, type FfmpegProcess } from "./recorder";
export { createLiveTvRouter, type LiveTvRouterDeps } from "./routes";
export { parseM3u, loadM3u, type M3uEntry, type M3uPlaylist } from "./m3u";
export { parseXmltv, loadXmltv, parseXmltvTime, XmltvParser } from "./xmltv";
export { XtreamClient } from "./xtream";
export { HdHomeRunClient } from "./hdhomerun";
export { createEpgMatcher, matchChannels, normaliseChannelName } from "./epg-match";
export type { FetchLike, LiveTvLogger } from "./util";
export * from "./types";
