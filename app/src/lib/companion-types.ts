/**
 * Shared companion types + constants — safe to import from client components.
 *
 * Lives separately from `companion-control.ts` because that file is
 * `server-only` (Drizzle / auth / fetch from the cloud server actions).
 * The devices page client imports the `FolderKind` enum + a couple of
 * shapes from here so it can render the picker dropdown and per-row
 * badge without dragging the server bundle along.
 */

export interface AuthorizedAudioDevice {
    name: string;
    direction: "input" | "output";
    backend: string;
    preferredSampleRate?: number;
}

/** Folder purpose label. Drives downstream routing (audio scanner vs
 *  video transcoder) and the colour/badge in the UI. */
export type FolderKind = "music" | "movies" | "tv-shows" | "samples" | "recordings" | "other";

export const FOLDER_KINDS: ReadonlyArray<FolderKind> = [
    "music", "movies", "tv-shows", "samples", "recordings", "other",
];

export interface CompanionFolder {
    path: string;
    exists: boolean;
    label: string;
    kind?: FolderKind;
    watch?: boolean;
    watchActive?: boolean;
    watchEvents?: number;
    watchError?: string | null;
}

export interface CompanionScannedTrack {
    filepath: string;
    filename: string;
    artist?: string;
    title?: string;
    album?: string;
    bpm?: number;
    key?: string;
    duration?: number;
    genre?: string;
    format?: string;
    bitrate?: number;
    sampleRate?: number;
    fileSize: number;
    year?: number;
}

export interface CompanionScanJob {
    id: string;
    folder: string;
    status: "pending" | "discovering" | "scanning" | "complete" | "error" | "canceled";
    discovered: number;
    scanned: number;
    errored: number;
    currentFile: string | null;
    total: number;
    startedAt: number;
    finishedAt: number | null;
    error: string | null;
    origin: "manual" | "watcher";
    tracks?: CompanionScannedTrack[] | null;
}

export interface CompanionWatchEvent {
    id: number;
    folder: string;
    kind: "add" | "change" | "unlink";
    filepath: string;
    payload: CompanionScannedTrack | null;
    timestamp: number;
}

export interface CompanionAudioDevice {
    id: number;
    name: string;
    inputChannels: number;
    outputChannels: number;
    duplexChannels: number;
    isDefaultInput: boolean;
    isDefaultOutput: boolean;
    sampleRates: number[];
    preferredSampleRate: number;
}

export interface CompanionAudioBackendGroup {
    backend: string;
    apiName: string;
    available: boolean;
    devices: CompanionAudioDevice[];
}

export interface CompanionAudioInventory {
    backends: CompanionAudioBackendGroup[];
    authorized: AuthorizedAudioDevice[];
}

// ─── In-web filesystem browser (companion-side FS, navigated from the cloud) ─

/** A top-level mount: a drive letter on Windows, root volumes on macOS/Linux. */
export interface CompanionDrive {
    /** Absolute path used as the starting point (`C:\`, `/`, `/Volumes/External`). */
    path: string;
    /** Display label (`Local Disk (C:)`, `/`, `External SSD`). */
    label: string;
    /** Mount kind hint, mostly for icon selection. */
    type: "fixed" | "removable" | "network" | "root" | "home" | "unknown";
    /** Free space in bytes if cheaply known. */
    free?: number;
    /** Total capacity in bytes if cheaply known. */
    total?: number;
}

export interface CompanionDirectoryEntry {
    name: string;
    path: string;
    /** True if the directory has at least one navigable subfolder. Used
     *  to show a chevron without forcing the user to drill in. May be
     *  null when the companion didn't probe (e.g. permission denied). */
    hasChildren: boolean | null;
}

export interface CompanionDirectoryListing {
    /** Absolute path that was listed. */
    path: string;
    /** Parent path, or null when we're at a drive root. */
    parent: string | null;
    /** Subdirectories, sorted alphabetically. Files are intentionally
     *  omitted — the picker only deals with folders. */
    entries: CompanionDirectoryEntry[];
    /** Soft-fail flag: when true the listing partially succeeded (e.g.
     *  some children threw EACCES). The visible entries are still valid. */
    partial?: boolean;
}
