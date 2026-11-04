/**
 * LiveTvService — user-supplied IPTV sources (M3U, Xtream Codes, HDHomeRun),
 * channel lineup, XMLTV guide, favourites and catch-up URLs.
 *
 * Channel ids are a stable hash of (source, tvg-id | url | stream id), so a
 * refresh keeps hidden/sort/custom number/favourites. We ship no channel lists.
 */

import { createEpgMatcher } from "./epg-match";
import { loadM3u } from "./m3u";
import { loadXmltv, type XmltvProgramme } from "./xmltv";
import { XtreamClient } from "./xtream";
import { HdHomeRunClient } from "./hdhomerun";
import type { LiveTvDb } from "./db";
import {
    LiveTvError, type ChannelPatch, type ChannelQuery, type ChannelView, type GroupView, type GuideRefreshResult, type NowNext,
    type Programme, type RefreshResult, type SourceInput, type SourceKind, type SourcePatch, type SourceView, type TestResult,
} from "./types";
import { defaultFetch, errorMessage, isHttpUrl, newId, redactText, redactUrl, silentLogger, stableId, type FetchLike, type LiveTvLogger } from "./util";

export const DEFAULT_TUNER_LIMIT = 2;
export const MAX_GUIDE_WINDOW_MS = 48 * 3_600_000;
const GUIDE_KEEP_PAST_MS = 24 * 3_600_000;
const GUIDE_KEEP_AHEAD_MS = 14 * 24 * 3_600_000;
const HOUR = 3_600_000;

interface SourceRow {
    id: string; kind: SourceKind; name: string; url: string; xmltv_url: string | null; username: string | null; password: string | null;
    enabled: number; refresh_hours: number; last_refresh: number | null; last_error: string | null; channel_count: number;
    header_xmltv: string | null; tuner_limit: number | null; tuner_override: number | null; meta: string;
    guide_refreshed_at: number | null; guide_error: string | null; created_at: number; updated_at: number;
}

interface ChannelRow {
    id: string; source_id: string; number: string | null; custom_number: string | null; name: string; logo: string | null;
    group_title: string | null; tvg_id: string | null; stream_url: string; archive_days: number; catchup: string | null;
    catchup_source: string | null; ext_id: string | null; hidden: number; sort: number | null; position: number;
}

interface ProgrammeRow {
    channel_id: string; start: number; stop: number; title: string; subtitle: string | null; description: string | null;
    category: string | null; episode_num: string | null; icon: string | null;
}

/** What a source fetch yields before it is written to the DB. */
export interface FetchedChannel {
    key: string;
    number: string | null;
    name: string;
    logo: string | null;
    group: string | null;
    tvgId: string | null;
    streamUrl: string;
    archiveDays: number;
    catchup: string | null;
    catchupSource: string | null;
    extId: string | null;
}

interface FetchedSource {
    channels: FetchedChannel[];
    tunerLimit: number | null;
    headerXmltv: string | null;
    meta: Record<string, unknown>;
    info: Record<string, unknown>;
}

export interface LiveTvServiceOptions {
    db: LiveTvDb;
    log?: LiveTvLogger;
    fetch?: FetchLike;
    now?: () => number;
    /** Background loop period (default 15 min). */
    tickMs?: number;
}

const KINDS: readonly SourceKind[] = ["m3u", "xtream", "hdhomerun"];

function toProgramme(r: ProgrammeRow): Programme {
    return {
        channelId: r.channel_id, start: r.start, stop: r.stop, title: r.title, subtitle: r.subtitle, description: r.description,
        category: r.category, episodeNum: r.episode_num, icon: r.icon,
    };
}

/** Offset (minutes) of an IANA zone at `ms`, or 0 when unknown. */
export function zoneOffsetMin(timeZone: string | null | undefined, ms: number): number {
    if (!timeZone) return 0;
    try {
        const parts = new Intl.DateTimeFormat("en-US", {
            timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
        }).formatToParts(new Date(ms));
        const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
        const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
        return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60_000);
    } catch {
        return 0;
    }
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * Expand an M3U `catchup-source` template. Supported placeholders (both
 * `{x}` and `${x}`): utc/start, lutc/now/timestamp, utcend/end, duration,
 * offset, Y m d H M S (UTC parts of start). `{duration:60}` / `{offset:60}`
 * divide by the given number (minutes).
 */
export function expandCatchupTemplate(template: string, startMs: number, durationSec: number, nowMs: number): string {
    const utc = Math.floor(startMs / 1000);
    const lutc = Math.floor(nowMs / 1000);
    const d = new Date(startMs);
    const values: Record<string, number | string> = {
        utc, start: utc, lutc, now: lutc, timestamp: lutc, utcend: utc + durationSec, end: utc + durationSec,
        duration: durationSec, offset: Math.max(0, lutc - utc),
        Y: d.getUTCFullYear(), m: pad2(d.getUTCMonth() + 1), d: pad2(d.getUTCDate()),
        H: pad2(d.getUTCHours()), M: pad2(d.getUTCMinutes()), S: pad2(d.getUTCSeconds()),
    };
    return template.replace(/\$?\{([A-Za-z]+)(?::(\d+))?\}/g, (whole, key: string, div?: string) => {
        const v = values[key];
        if (v === undefined) return whole;
        if (div && typeof v === "number") return String(Math.floor(v / Math.max(1, Number(div))));
        return String(v);
    });
}

function catchupUrlForM3u(ch: ChannelRow, startMs: number, durationSec: number, nowMs: number): string | null {
    const mode = (ch.catchup ?? "").toLowerCase();
    const src = ch.catchup_source;
    if (src && (mode === "append" || (!isHttpUrl(src) && mode !== "default"))) {
        return ch.stream_url + expandCatchupTemplate(src, startMs, durationSec, nowMs);
    }
    if (src) return expandCatchupTemplate(src, startMs, durationSec, nowMs);
    if (mode === "shift" || mode === "timeshift") {
        const sep = ch.stream_url.includes("?") ? "&" : "?";
        return `${ch.stream_url}${sep}utc=${Math.floor(startMs / 1000)}&lutc=${Math.floor(nowMs / 1000)}`;
    }
    if (mode === "flussonic" || mode === "flussonic-hls" || mode === "fs") {
        const utc = Math.floor(startMs / 1000);
        return /\.m3u8(\?|$)/i.test(ch.stream_url)
            ? ch.stream_url.replace(/\/[^/?]*\.m3u8/i, `/index-${utc}-${durationSec}.m3u8`)
            : ch.stream_url.replace(/\/[^/?]*(\?|$)/, `/timeshift_abs-${utc}.ts$1`);
    }
    return null;
}

export class LiveTvService {
    readonly db: LiveTvDb;
    private readonly log: LiveTvLogger;
    private readonly fetchImpl: FetchLike;
    private readonly now: () => number;
    private readonly tickMs: number;
    private timer: NodeJS.Timeout | null = null;
    private kick: NodeJS.Timeout | null = null;
    private busy = false;
    private readonly guideListeners: Array<() => void> = [];
    private readonly refreshing = new Map<string, Promise<RefreshResult>>();
    private readonly guideInflight = new Map<string, Promise<GuideRefreshResult>>();

    constructor(opts: LiveTvServiceOptions) {
        this.db = opts.db;
        this.log = opts.log ?? silentLogger;
        this.fetchImpl = opts.fetch ?? defaultFetch;
        this.now = opts.now ?? Date.now;
        this.tickMs = opts.tickMs ?? 15 * 60_000;
    }

    // ── sources ──────────────────────────────────────────────────────────

    private row(id: string): SourceRow | undefined {
        return this.db.prepare("SELECT * FROM sources WHERE id = ?").get(id) as SourceRow | undefined;
    }

    private requireRow(id: string): SourceRow {
        const r = this.row(id);
        if (!r) throw new LiveTvError(404, "source not found");
        return r;
    }

    private view(r: SourceRow): SourceView {
        return {
            id: r.id, kind: r.kind, name: r.name, url: redactUrl(r.url), xmltvUrl: r.xmltv_url ? redactUrl(r.xmltv_url) : null,
            username: r.username, hasPassword: !!r.password, enabled: r.enabled === 1, refreshHours: r.refresh_hours,
            lastRefresh: r.last_refresh, lastError: r.last_error, channelCount: r.channel_count,
            guideRefreshedAt: r.guide_refreshed_at, guideError: r.guide_error, tunerLimit: this.tunerLimitOf(r),
            createdAt: r.created_at, updatedAt: r.updated_at,
        };
    }

    private tunerLimitOf(r: SourceRow): number {
        return r.tuner_override ?? r.tuner_limit ?? DEFAULT_TUNER_LIMIT;
    }

    tunerLimit(sourceId: string): number {
        const r = this.row(sourceId);
        return r ? this.tunerLimitOf(r) : DEFAULT_TUNER_LIMIT;
    }

    listSources(): SourceView[] {
        return (this.db.prepare("SELECT * FROM sources ORDER BY created_at, name").all() as SourceRow[]).map((r) => this.view(r));
    }

    getSource(id: string): SourceView | null {
        const r = this.row(id);
        return r ? this.view(r) : null;
    }

    static validateInput(input: Partial<SourceInput>, partial: boolean): void {
        const bad = (m: string) => { throw new LiveTvError(400, m); };
        if (!partial || input.kind !== undefined) {
            if (!KINDS.includes(input.kind as SourceKind)) bad("kind must be m3u, xtream or hdhomerun");
        }
        if (!partial || input.name !== undefined) {
            if (typeof input.name !== "string" || !input.name.trim() || input.name.length > 200) bad("name required (max 200 chars)");
        }
        if (!partial || input.url !== undefined) {
            if (typeof input.url !== "string" || !input.url.trim() || input.url.length > 4096) bad("url required");
        }
        if (input.xmltvUrl !== undefined && input.xmltvUrl !== null && (typeof input.xmltvUrl !== "string" || input.xmltvUrl.length > 4096)) bad("xmltvUrl must be a string");
        for (const k of ["username", "password"] as const) {
            const v = input[k];
            if (v !== undefined && v !== null && (typeof v !== "string" || v.length > 512)) bad(`${k} must be a string`);
        }
        if (input.enabled !== undefined && typeof input.enabled !== "boolean") bad("enabled must be boolean");
        if (input.refreshHours !== undefined && (!Number.isInteger(input.refreshHours) || input.refreshHours < 1 || input.refreshHours > 720)) bad("refreshHours must be 1..720");
        if (input.tunerLimit !== undefined && input.tunerLimit !== null && (!Number.isInteger(input.tunerLimit) || input.tunerLimit < 1 || input.tunerLimit > 64)) bad("tunerLimit must be 1..64");
    }

    createSource(input: SourceInput): SourceView {
        LiveTvService.validateInput(input, false);
        if (input.kind === "xtream" && (!input.username || !input.password)) throw new LiveTvError(400, "xtream sources need username and password");
        const id = newId();
        const now = this.now();
        this.db.prepare(
            `INSERT INTO sources (id, kind, name, url, xmltv_url, username, password, enabled, refresh_hours, tuner_override, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
            id, input.kind, input.name.trim(), input.url.trim(), input.xmltvUrl?.trim() || null, input.username ?? null, input.password ?? null,
            input.enabled === false ? 0 : 1, input.refreshHours ?? 24, input.tunerLimit ?? null, now, now,
        );
        return this.view(this.requireRow(id));
    }

    updateSource(id: string, patch: SourcePatch): SourceView {
        LiveTvService.validateInput(patch, true);
        const r = this.requireRow(id);
        const next = {
            name: patch.name?.trim() ?? r.name,
            url: patch.url?.trim() ?? r.url,
            xmltv_url: patch.xmltvUrl !== undefined ? (patch.xmltvUrl?.trim() || null) : r.xmltv_url,
            username: patch.username !== undefined ? patch.username : r.username,
            // Empty string clears; undefined keeps — clients never see the stored value.
            password: patch.password !== undefined ? (patch.password || null) : r.password,
            enabled: patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : r.enabled,
            refresh_hours: patch.refreshHours ?? r.refresh_hours,
            tuner_override: patch.tunerLimit !== undefined ? patch.tunerLimit : r.tuner_override,
        };
        if (r.kind === "xtream" && (!next.username || !next.password)) throw new LiveTvError(400, "xtream sources need username and password");
        this.db.prepare(
            `UPDATE sources SET name=?, url=?, xmltv_url=?, username=?, password=?, enabled=?, refresh_hours=?, tuner_override=?, updated_at=? WHERE id=?`,
        ).run(next.name, next.url, next.xmltv_url, next.username, next.password, next.enabled, next.refresh_hours, next.tuner_override, this.now(), id);
        return this.view(this.requireRow(id));
    }

    deleteSource(id: string): boolean {
        this.requireRow(id);
        this.db.transaction(() => {
            this.db.prepare("DELETE FROM programmes WHERE channel_id IN (SELECT id FROM channels WHERE source_id = ?)").run(id);
            this.db.prepare("DELETE FROM favourites WHERE channel_id IN (SELECT id FROM channels WHERE source_id = ?)").run(id);
            this.db.prepare("DELETE FROM channels WHERE source_id = ?").run(id);
            this.db.prepare("DELETE FROM sources WHERE id = ?").run(id);
        })();
        return true;
    }

    private secretsOf(r: SourceRow): string[] {
        return [r.password, r.username].filter((s): s is string => !!s);
    }

    private xtream(r: SourceRow): XtreamClient {
        return new XtreamClient({ host: r.url, username: r.username ?? "", password: r.password ?? "" }, { fetch: this.fetchImpl });
    }

    /** Download the lineup of a source without touching the DB. */
    async fetchSource(r: SourceRow): Promise<FetchedSource> {
        if (r.kind === "m3u") {
            const pl = await loadM3u(r.url, { fetch: this.fetchImpl });
            const seen = new Set<string>();
            const channels: FetchedChannel[] = [];
            pl.entries.forEach((e, i) => {
                let key = e.tvgId ? `tvg:${e.tvgId}` : `url:${e.url}`;
                if (seen.has(key)) key = `url:${e.url}`;
                if (seen.has(key)) key = `idx:${i}:${e.url}`;
                seen.add(key);
                channels.push({
                    key, number: e.tvgChno, name: e.name, logo: e.tvgLogo, group: e.groupTitle, tvgId: e.tvgId, streamUrl: e.url,
                    archiveDays: e.catchupDays, catchup: e.catchup, catchupSource: e.catchupSource, extId: null,
                });
            });
            return { channels, tunerLimit: null, headerXmltv: pl.xmltvUrl, meta: {}, info: { entries: pl.entries.length } };
        }
        if (r.kind === "xtream") {
            const c = this.xtream(r);
            const { user, server } = await c.login();
            const [cats, streams] = await Promise.all([c.liveCategories(), c.liveStreams()]);
            const catName = new Map(cats.map((x) => [x.id, x.name]));
            const channels: FetchedChannel[] = streams.map((s) => ({
                key: `xt:${s.streamId}`, number: s.num !== null ? String(s.num) : null, name: s.name, logo: s.icon,
                group: s.categoryId ? (catName.get(s.categoryId) ?? null) : null, tvgId: s.epgChannelId, streamUrl: c.liveUrl(s.streamId),
                archiveDays: s.tvArchive ? Math.max(1, s.tvArchiveDuration) : 0, catchup: s.tvArchive ? "xc" : null, catchupSource: null,
                extId: String(s.streamId),
            }));
            return {
                channels,
                tunerLimit: user.maxConnections && user.maxConnections > 0 ? user.maxConnections : null,
                headerXmltv: c.xmltvUrl(),
                meta: { timezone: server.timezone },
                info: { status: user.status, expDate: user.expDate, maxConnections: user.maxConnections, categories: cats.length },
            };
        }
        const hd = new HdHomeRunClient(r.url, { fetch: this.fetchImpl });
        const dev = await hd.discover();
        const lineup = await hd.lineup(dev.lineupUrl);
        return {
            channels: lineup.map((x) => ({
                key: `hd:${x.guideNumber}`, number: x.guideNumber, name: x.guideName, logo: null, group: x.hd ? "HD" : null, tvgId: null,
                streamUrl: x.url, archiveDays: 0, catchup: null, catchupSource: null, extId: x.guideNumber,
            })),
            tunerLimit: dev.tunerCount,
            headerXmltv: null,
            meta: { friendlyName: dev.friendlyName, deviceId: dev.deviceId },
            info: { friendlyName: dev.friendlyName, model: dev.modelNumber, tunerCount: dev.tunerCount },
        };
    }

    async testSource(id: string): Promise<TestResult> {
        const r = this.requireRow(id);
        try {
            const f = await this.fetchSource(r);
            return { ok: true, channelCount: f.channels.length, error: null, info: { ...f.info, tunerLimit: f.tunerLimit ?? DEFAULT_TUNER_LIMIT } };
        } catch (err) {
            return { ok: false, channelCount: 0, error: redactText(errorMessage(err), this.secretsOf(r)) };
        }
    }

    /** Replace the channels of one source transactionally (keeps per-channel user state). */
    refreshSource(id: string): Promise<RefreshResult> {
        const inflight = this.refreshing.get(id);
        if (inflight) return inflight;
        const p = this.doRefreshSource(id).finally(() => this.refreshing.delete(id));
        this.refreshing.set(id, p);
        return p;
    }

    private async doRefreshSource(id: string): Promise<RefreshResult> {
        const r = this.requireRow(id);
        const now = this.now();
        let fetched: FetchedSource;
        try {
            fetched = await this.fetchSource(r);
        } catch (err) {
            const error = redactText(errorMessage(err), this.secretsOf(r));
            this.db.prepare("UPDATE sources SET last_refresh = ?, last_error = ? WHERE id = ?").run(now, error, id);
            this.log.warn("[livetv] source refresh failed", { source: id, error });
            return { ok: false, channelCount: r.channel_count, error };
        }
        this.writeChannels(r, fetched, now);
        this.log.info("[livetv] source refreshed", { source: id, channels: fetched.channels.length });
        return { ok: true, channelCount: fetched.channels.length, error: null };
    }

    private writeChannels(r: SourceRow, f: FetchedSource, now: number): void {
        const gen = (this.db.prepare("SELECT COALESCE(MAX(seen_gen), 0) + 1 AS g FROM channels").get() as { g: number }).g;
        const upsert = this.db.prepare(
            `INSERT INTO channels (id, source_id, number, name, logo, group_title, tvg_id, stream_url, archive_days, catchup, catchup_source, ext_id, position, seen_gen)
             VALUES (@id, @source_id, @number, @name, @logo, @group_title, @tvg_id, @stream_url, @archive_days, @catchup, @catchup_source, @ext_id, @position, @gen)
             ON CONFLICT(id) DO UPDATE SET number=excluded.number, name=excluded.name, logo=excluded.logo, group_title=excluded.group_title,
               tvg_id=excluded.tvg_id, stream_url=excluded.stream_url, archive_days=excluded.archive_days, catchup=excluded.catchup,
               catchup_source=excluded.catchup_source, ext_id=excluded.ext_id, position=excluded.position, seen_gen=excluded.seen_gen`,
        );
        this.db.transaction(() => {
            f.channels.forEach((c, i) => {
                upsert.run({
                    id: stableId(r.id, c.key), source_id: r.id, number: c.number, name: c.name, logo: c.logo, group_title: c.group,
                    tvg_id: c.tvgId, stream_url: c.streamUrl, archive_days: c.archiveDays, catchup: c.catchup, catchup_source: c.catchupSource,
                    ext_id: c.extId, position: i, gen,
                });
            });
            this.db.prepare(
                "DELETE FROM programmes WHERE channel_id IN (SELECT id FROM channels WHERE source_id = ? AND seen_gen <> ?)",
            ).run(r.id, gen);
            this.db.prepare("DELETE FROM channels WHERE source_id = ? AND seen_gen <> ?").run(r.id, gen);
            this.db.prepare(
                "UPDATE sources SET last_refresh = ?, last_error = NULL, channel_count = ?, header_xmltv = ?, tuner_limit = ?, meta = ? WHERE id = ?",
            ).run(now, f.channels.length, f.headerXmltv, f.tunerLimit, JSON.stringify(f.meta), r.id);
        })();
    }

    // ── guide ────────────────────────────────────────────────────────────

    onGuideRefreshed(fn: () => void): void {
        this.guideListeners.push(fn);
    }

    private guideUrlOf(r: SourceRow): string | null {
        return r.xmltv_url || r.header_xmltv || (r.kind === "xtream" ? this.xtream(r).xmltvUrl() : null);
    }

    /** Refresh XMLTV for one source (or every enabled source). */
    async refreshGuide(sourceId?: string): Promise<GuideRefreshResult> {
        const rows = sourceId
            ? [this.requireRow(sourceId)]
            : (this.db.prepare("SELECT * FROM sources WHERE enabled = 1").all() as SourceRow[]);
        const total: GuideRefreshResult = { ok: true, programmes: 0, matchedChannels: 0, error: null };
        for (const r of rows) {
            const res = await this.refreshGuideFor(r);
            total.programmes += res.programmes;
            total.matchedChannels += res.matchedChannels;
            if (!res.ok) { total.ok = false; total.error = total.error ? `${total.error}; ${res.error}` : res.error; }
        }
        this.pruneGuide();
        for (const fn of this.guideListeners) {
            try { fn(); } catch (err) { this.log.warn("[livetv] guide listener failed", {}, err); }
        }
        return total;
    }

    pruneGuide(): number {
        return this.db.prepare("DELETE FROM programmes WHERE stop < ?").run(this.now() - GUIDE_KEEP_PAST_MS).changes;
    }

    private refreshGuideFor(r: SourceRow): Promise<GuideRefreshResult> {
        const inflight = this.guideInflight.get(r.id);
        if (inflight) return inflight;
        const p = this.doRefreshGuideFor(r).finally(() => this.guideInflight.delete(r.id));
        this.guideInflight.set(r.id, p);
        return p;
    }

    private async doRefreshGuideFor(r: SourceRow): Promise<GuideRefreshResult> {
        const url = this.guideUrlOf(r);
        if (!url) return { ok: true, programmes: 0, matchedChannels: 0, error: null };
        const channels = this.db.prepare("SELECT id, tvg_id, name FROM channels WHERE source_id = ?").all(r.id) as Array<{ id: string; tvg_id: string | null; name: string }>;
        const matcher = createEpgMatcher(channels.map((c) => ({ id: c.id, tvgId: c.tvg_id, name: c.name })));
        const names = new Map<string, string[]>();
        const now = this.now();
        const minStop = now - GUIDE_KEEP_PAST_MS;
        const maxStart = now + GUIDE_KEEP_AHEAD_MS;
        const gen = (this.db.prepare("SELECT COALESCE(MAX(gen), 0) + 1 AS g FROM programmes").get() as { g: number }).g;
        const insert = this.db.prepare(
            `INSERT INTO programmes (channel_id, start, stop, title, subtitle, description, category, episode_num, icon, gen)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(channel_id, start) DO UPDATE SET stop=excluded.stop, title=excluded.title, subtitle=excluded.subtitle,
               description=excluded.description, category=excluded.category, episode_num=excluded.episode_num, icon=excluded.icon, gen=excluded.gen`,
        );
        let batch: Array<[string, XmltvProgramme]> = [];
        const flushBatch = this.db.transaction((rows: Array<[string, XmltvProgramme]>) => {
            for (const [cid, p] of rows) insert.run(cid, p.start, p.stop, p.title, p.subtitle, p.description, p.category, p.episodeNum, p.icon, gen);
        });
        const matched = new Set<string>();
        let count = 0;
        try {
            await loadXmltv(url, {
                onChannel: (c) => { names.set(c.id, c.displayNames); },
                onProgramme: (p) => {
                    if (p.stop < minStop || p.start > maxStart) return;
                    for (const cid of matcher.match(p.channel, names.get(p.channel))) {
                        matched.add(cid);
                        batch.push([cid, p]);
                        count++;
                    }
                    if (batch.length >= 2000) { flushBatch(batch); batch = []; }
                },
            }, { fetch: this.fetchImpl });
            if (batch.length) flushBatch(batch);
        } catch (err) {
            const error = redactText(errorMessage(err), this.secretsOf(r));
            this.db.prepare("UPDATE sources SET guide_error = ? WHERE id = ?").run(error, r.id);
            this.log.warn("[livetv] guide refresh failed", { source: r.id, error });
            return { ok: false, programmes: 0, matchedChannels: 0, error };
        }
        // Drop programmes of this source's channels that the new guide no longer lists.
        this.db.prepare(
            "DELETE FROM programmes WHERE gen <> ? AND channel_id IN (SELECT id FROM channels WHERE source_id = ?)",
        ).run(gen, r.id);
        this.db.prepare("UPDATE sources SET guide_refreshed_at = ?, guide_error = NULL WHERE id = ?").run(now, r.id);
        return { ok: true, programmes: count, matchedChannels: matched.size, error: null };
    }

    guide(from: number, to: number, channelIds?: readonly string[]): Programme[] {
        if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) throw new LiveTvError(400, "from/to must be epoch ms with to > from");
        if (to - from > MAX_GUIDE_WINDOW_MS) throw new LiveTvError(400, "guide window is limited to 48 h");
        const rows = channelIds && channelIds.length
            ? this.db.prepare(
                "SELECT * FROM programmes WHERE start < ? AND stop > ? AND channel_id IN (SELECT value FROM json_each(?)) ORDER BY channel_id, start",
            ).all(to, from, JSON.stringify(channelIds))
            : this.db.prepare("SELECT * FROM programmes WHERE start < ? AND stop > ? ORDER BY channel_id, start").all(to, from);
        return (rows as ProgrammeRow[]).map(toProgramme);
    }

    programmeAt(channelId: string, start: number): Programme | null {
        const r = this.db.prepare("SELECT * FROM programmes WHERE channel_id = ? AND start = ?").get(channelId, start) as ProgrammeRow | undefined;
        return r ? toProgramme(r) : null;
    }

    /** Future programmes (start >= from), optionally for one channel — used by DVR rule expansion. */
    upcoming(from: number, channelId?: string | null): Programme[] {
        const rows = channelId
            ? this.db.prepare("SELECT * FROM programmes WHERE start >= ? AND channel_id = ? ORDER BY start").all(from, channelId)
            : this.db.prepare(
                "SELECT p.* FROM programmes p JOIN channels c ON c.id = p.channel_id JOIN sources s ON s.id = c.source_id WHERE p.start >= ? AND s.enabled = 1 AND c.hidden = 0 ORDER BY p.start, c.source_id, c.position",
            ).all(from);
        return (rows as ProgrammeRow[]).map(toProgramme);
    }

    nowNext(channelIds?: readonly string[]): NowNext[] {
        const now = this.now();
        const ids = channelIds && channelIds.length ? [...channelIds] : this.channels({}).map((c) => c.id);
        if (ids.length === 0) return [];
        const rows = this.db.prepare(
            "SELECT * FROM programmes WHERE stop > ? AND start < ? AND channel_id IN (SELECT value FROM json_each(?)) ORDER BY channel_id, start",
        ).all(now, now + 24 * HOUR, JSON.stringify(ids)) as ProgrammeRow[];
        const by = new Map<string, ProgrammeRow[]>();
        for (const r of rows) {
            const arr = by.get(r.channel_id);
            if (arr) arr.push(r); else by.set(r.channel_id, [r]);
        }
        return ids.map((id) => {
            const list = by.get(id) ?? [];
            const cur = list.find((p) => p.start <= now && p.stop > now) ?? null;
            const next = list.find((p) => p.start >= (cur ? cur.stop : now)) ?? null;
            return { channelId: id, now: cur ? toProgramme(cur) : null, next: next ? toProgramme(next) : null };
        });
    }

    // ── channels ─────────────────────────────────────────────────────────

    private channelRow(id: string): ChannelRow | undefined {
        return this.db.prepare("SELECT * FROM channels WHERE id = ?").get(id) as ChannelRow | undefined;
    }

    getChannel(id: string): (ChannelView & { streamSourceKind: SourceKind }) | null {
        const r = this.channelRow(id);
        if (!r) return null;
        const s = this.row(r.source_id);
        return { ...this.channelView(r, false), streamSourceKind: s?.kind ?? "m3u" };
    }

    private channelView(r: ChannelRow, fav: boolean): ChannelView {
        return {
            id: r.id, sourceId: r.source_id, number: r.custom_number ?? r.number, name: r.name, logo: r.logo, group: r.group_title,
            tvgId: r.tvg_id, archiveDays: r.archive_days, catchup: !!(r.archive_days > 0 || r.catchup || r.catchup_source),
            hidden: r.hidden === 1, sort: r.sort, favourite: fav,
        };
    }

    channels(q: ChannelQuery): ChannelView[] {
        const where: string[] = ["s.enabled = 1"];
        const params: unknown[] = [q.favouritesOf ?? ""];
        if (!q.includeHidden) where.push("c.hidden = 0");
        if (q.group !== undefined) { where.push("c.group_title IS ?"); params.push(q.group === "" ? null : q.group); }
        if (q.sourceId) { where.push("c.source_id = ?"); params.push(q.sourceId); }
        if (q.favouritesOnly) where.push("f.channel_id IS NOT NULL");
        const rows = this.db.prepare(
            `SELECT c.*, f.channel_id AS fav FROM channels c
             JOIN sources s ON s.id = c.source_id
             LEFT JOIN favourites f ON f.channel_id = c.id AND f.profile_id = ?
             WHERE ${where.join(" AND ")}
             ORDER BY (c.sort IS NULL), c.sort, (COALESCE(c.custom_number, c.number) IS NULL),
                      CAST(COALESCE(c.custom_number, c.number) AS REAL), s.created_at, c.position`,
        ).all(...params) as Array<ChannelRow & { fav: string | null }>;
        return rows.map((r) => this.channelView(r, r.fav !== null));
    }

    groups(): GroupView[] {
        const rows = this.db.prepare(
            `SELECT c.group_title AS name, COUNT(*) AS count FROM channels c JOIN sources s ON s.id = c.source_id
             WHERE s.enabled = 1 AND c.hidden = 0 GROUP BY c.group_title ORDER BY MIN(s.created_at), MIN(c.position)`,
        ).all() as Array<{ name: string | null; count: number }>;
        return rows.map((r) => ({ name: r.name ?? "", count: r.count }));
    }

    updateChannel(id: string, patch: ChannelPatch): ChannelView {
        const r = this.channelRow(id);
        if (!r) throw new LiveTvError(404, "channel not found");
        if (patch.hidden !== undefined && typeof patch.hidden !== "boolean") throw new LiveTvError(400, "hidden must be boolean");
        if (patch.sort !== undefined && patch.sort !== null && !Number.isInteger(patch.sort)) throw new LiveTvError(400, "sort must be an integer or null");
        if (patch.number !== undefined && patch.number !== null && (typeof patch.number !== "string" || patch.number.length > 16)) throw new LiveTvError(400, "number must be a string (max 16) or null");
        this.db.prepare("UPDATE channels SET hidden = ?, sort = ?, custom_number = ? WHERE id = ?").run(
            patch.hidden !== undefined ? (patch.hidden ? 1 : 0) : r.hidden,
            patch.sort !== undefined ? patch.sort : r.sort,
            patch.number !== undefined ? (patch.number || null) : r.custom_number,
            id,
        );
        return this.channelView(this.channelRow(id)!, false);
    }

    setFavourite(profileId: string, channelId: string, on: boolean): void {
        if (!this.channelRow(channelId)) throw new LiveTvError(404, "channel not found");
        if (on) this.db.prepare("INSERT OR IGNORE INTO favourites (profile_id, channel_id, added_at) VALUES (?, ?, ?)").run(profileId, channelId, this.now());
        else this.db.prepare("DELETE FROM favourites WHERE profile_id = ? AND channel_id = ?").run(profileId, channelId);
    }

    channelSourceId(channelId: string): string | null {
        return this.channelRow(channelId)?.source_id ?? null;
    }

    channelName(channelId: string): string | null {
        return this.channelRow(channelId)?.name ?? null;
    }

    streamUrlFor(channelId: string): string | null {
        return this.channelRow(channelId)?.stream_url ?? null;
    }

    catchupUrlFor(channelId: string, startMs: number, durationMin: number): string {
        const ch = this.channelRow(channelId);
        if (!ch) throw new LiveTvError(404, "channel not found");
        if (!Number.isFinite(startMs) || !Number.isFinite(durationMin) || durationMin <= 0 || durationMin > 24 * 60) {
            throw new LiveTvError(400, "start (epoch ms) and duration (1..1440 min) required");
        }
        const now = this.now();
        if (startMs >= now) throw new LiveTvError(400, "catch-up start must be in the past");
        if (ch.archive_days > 0 && startMs < now - ch.archive_days * 24 * HOUR) throw new LiveTvError(400, `outside the ${ch.archive_days}-day archive`);
        const src = this.requireRow(ch.source_id);
        if (src.kind === "xtream") {
            if (ch.archive_days <= 0 || !ch.ext_id) throw new LiveTvError(409, "channel has no catch-up archive");
            let tz: string | null = null;
            try { tz = (JSON.parse(src.meta) as { timezone?: string | null }).timezone ?? null; } catch { /* ignore */ }
            return this.xtream(src).timeshiftUrl(Number(ch.ext_id), startMs, durationMin, zoneOffsetMin(tz, startMs));
        }
        if (src.kind === "m3u") {
            const url = catchupUrlForM3u(ch, startMs, Math.round(durationMin * 60), now);
            if (url) return url;
        }
        throw new LiveTvError(409, "channel has no catch-up archive");
    }

    // ── background refresh loop ──────────────────────────────────────────

    start(): void {
        if (this.timer) return;
        this.timer = setInterval(() => { void this.tick(); }, this.tickMs);
        this.timer.unref?.();
        this.kick = setTimeout(() => { void this.tick(); }, 5_000);
        this.kick.unref?.();
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        if (this.kick) clearTimeout(this.kick);
        this.timer = null;
        this.kick = null;
    }

    /** Refresh every enabled source whose `refresh_hours` elapsed, then its guide. */
    async tick(): Promise<number> {
        if (this.busy) return 0;
        this.busy = true;
        let refreshed = 0;
        try {
            const now = this.now();
            const due = (this.db.prepare("SELECT * FROM sources WHERE enabled = 1").all() as SourceRow[])
                .filter((r) => r.last_refresh === null || now - r.last_refresh >= r.refresh_hours * HOUR);
            for (const r of due) {
                const res = await this.refreshSource(r.id);
                if (res.ok) { refreshed++; await this.refreshGuide(r.id); }
            }
        } catch (err) {
            this.log.warn("[livetv] refresh tick failed", {}, err);
        } finally {
            this.busy = false;
        }
        return refreshed;
    }
}

/** Filesystem-safe name fragment (recordings). */
export function safeFileName(s: string, max = 80): string {
    const cleaned = s.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().replace(/[. ]+$/, "");
    return (cleaned || "recording").slice(0, max);
}
