import type { AuthParam, OfflineKind } from "./keys";

export type OfflineStatus = "queued" | "downloading" | "paused" | "done" | "error";
export type OfflineErrorCode = "network" | "quota" | "http" | "auth" | "missing" | "storage" | "unknown";

export interface OfflineError {
    code: OfflineErrorCode;
    /** HTTP status for `http` / `auth`. */
    status?: number;
    /** Bytes for `quota`. */
    needed?: number;
    free?: number;
}

/** One IndexedDB record (store `items`, keyPath `key`, index `scope`). Holds NO credentials. */
export interface OfflineItem {
    key: string;
    /** `${serverId}:${profileId}` (encoded) — index for the per-profile list. */
    scope: string;
    serverId: string;
    profileId: string;
    kind: OfflineKind;
    id: string;
    title: string;
    /** Secondary line (show + episode, artist). */
    subtitle: string | null;
    durationSec: number | null;
    /** Source URL WITHOUT auth params. */
    url: string;
    /** Auth params to re-apply from the live server credentials at download time. */
    auth: AuthParam[];
    hasPoster: boolean;
    /** Total bytes, once known. */
    size: number | null;
    /** Bytes received so far (in-flight value while downloading, committed parts otherwise). */
    bytes: number;
    /** Committed part sizes (Cache Storage `/p/<n>`). */
    parts: number[];
    mime: string | null;
    /** Server answered a Range request with 206 → resume continues instead of restarting. */
    acceptRanges: boolean;
    status: OfflineStatus;
    error: OfflineError | null;
    addedAt: number;
    updatedAt: number;
    completedAt: number | null;
}

/** Cache entry `/__offline/<key>/m`, written last — its presence means "complete". */
export interface OfflineManifest {
    size: number;
    parts: number[];
    type: string;
}

/** What a page hands to `enqueue` (and `DownloadButton`). `url`/`poster` may carry `?t=`/`apiKey` — stripped before persisting. */
export interface DownloadInput {
    serverId: string;
    profileId: string;
    kind: OfflineKind;
    id: string;
    title: string;
    subtitle?: string | null;
    poster?: string | null;
    durationSec?: number | null;
    url: string;
}

export interface OfflineChange {
    key: string;
    /** `null` = deleted. */
    item: OfflineItem | null;
}
