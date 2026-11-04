/** Public shapes of the Live TV module (responses never contain passwords). */

export type SourceKind = "m3u" | "xtream" | "hdhomerun";

export interface SourceView {
    id: string;
    kind: SourceKind;
    name: string;
    /** Playlist URL / Xtream host / HDHomeRun address. Credentials in the URL are masked. */
    url: string;
    xmltvUrl: string | null;
    username: string | null;
    hasPassword: boolean;
    enabled: boolean;
    refreshHours: number;
    lastRefresh: number | null;
    lastError: string | null;
    channelCount: number;
    guideRefreshedAt: number | null;
    guideError: string | null;
    /** Concurrent streams this source allows (TunerCount / max_connections / default 2). */
    tunerLimit: number;
    createdAt: number;
    updatedAt: number;
}

export interface SourceInput {
    kind: SourceKind;
    name: string;
    url: string;
    xmltvUrl?: string | null;
    username?: string | null;
    password?: string | null;
    enabled?: boolean;
    refreshHours?: number;
    tunerLimit?: number | null;
}

export type SourcePatch = Partial<Omit<SourceInput, "kind">>;

export interface ChannelView {
    id: string;
    sourceId: string;
    number: string | null;
    name: string;
    logo: string | null;
    group: string | null;
    tvgId: string | null;
    archiveDays: number;
    catchup: boolean;
    hidden: boolean;
    sort: number | null;
    favourite: boolean;
}

export interface ChannelQuery {
    group?: string;
    /** Profile id: marks `favourite` and, with `favouritesOnly`, filters. */
    favouritesOf?: string;
    favouritesOnly?: boolean;
    includeHidden?: boolean;
    sourceId?: string;
}

export interface ChannelPatch { hidden?: boolean; sort?: number | null; number?: string | null }

export interface Programme {
    channelId: string;
    start: number;
    stop: number;
    title: string;
    subtitle: string | null;
    description: string | null;
    category: string | null;
    episodeNum: string | null;
    icon: string | null;
}

export interface NowNext { channelId: string; now: Programme | null; next: Programme | null }

export interface GroupView { name: string; count: number }

export interface RefreshResult { ok: boolean; channelCount: number; error: string | null }

export interface GuideRefreshResult { ok: boolean; programmes: number; matchedChannels: number; error: string | null }

export interface TestResult { ok: boolean; channelCount: number; error: string | null; info?: Record<string, unknown> }

export type RecordingStatus = "scheduled" | "recording" | "done" | "failed" | "cancelled";

export interface RecordingView {
    id: string;
    channelId: string;
    channelName: string | null;
    title: string;
    start: number;
    stop: number;
    paddingBeforeSec: number;
    paddingAfterSec: number;
    status: RecordingStatus;
    path: string | null;
    error: string | null;
    ruleId: string | null;
    createdAt: number;
    /** True when more recordings overlap on this source than it has tuners. */
    conflict: boolean;
}

export interface RecordingInput {
    channelId: string;
    start: number;
    stop: number;
    title?: string;
    paddingBeforeSec?: number;
    paddingAfterSec?: number;
}

export interface RuleView {
    id: string;
    titleMatch: string;
    channelId: string | null;
    paddingBeforeSec: number;
    paddingAfterSec: number;
    keepLast: number;
    enabled: boolean;
    createdAt: number;
}

export interface RuleInput {
    titleMatch: string;
    channelId?: string | null;
    paddingBeforeSec?: number;
    paddingAfterSec?: number;
    keepLast?: number;
    enabled?: boolean;
}

export class LiveTvError extends Error {
    constructor(readonly status: number, message: string) {
        super(message);
        this.name = "LiveTvError";
    }
}
