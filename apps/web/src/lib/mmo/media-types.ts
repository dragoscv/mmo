/**
 * Minimal copies of the `/media/*` wire types from `server/src/media/types.ts`
 * (canonical: `packages/sdk/src/generated/mmo-server.d.ts`). Copied because this
 * app's tsconfig has no `paths` alias for `@mmo/sdk` and stays dependency-free.
 */

export type MediaKind = "movie" | "tv";

export type OfferType = "subscription" | "rent" | "buy" | "free" | "ads";

/** Concrete URLs — the server resolves its URL builders before serialising. */
export interface LaunchData {
    web: string;
    android?: { package: string; uri?: string };
    tizen?: { appId: string; payload?: string };
    search: string;
}

export interface Offer {
    providerId: number;
    name: string;
    logo: string | null;
    type: OfferType;
    link?: string;
    launch: LaunchData;
}

export interface Availability {
    offers: Offer[];
    source: "motn" | "tmdb" | "none";
    attribution: string[];
    fetchedAt?: number;
}

export interface TitleCard {
    kind: MediaKind;
    tmdbId: number;
    title: string;
    originalTitle?: string;
    overview?: string;
    posterPath: string | null;
    backdropPath: string | null;
    releaseDate?: string;
    voteAverage?: number;
    voteCount?: number;
    popularity?: number;
    genreIds: number[];
    inLibrary?: boolean;
    /** 0..1 for `continue` rows. */
    progress?: number;
    reason?: string;
    /** Minimum viewer age (RO CNC scale; 19 = adult-only). Null = unrated. */
    age?: number | null;
    nextEpisode?: NextEpisode;
}

export interface NextEpisode {
    season: number;
    episode: number;
    positionSec: number;
}

export interface Person {
    id: number;
    name: string;
    role: string;
    profilePath: string | null;
}

export interface TitleVideo {
    key: string;
    site: string;
    type: string;
    name: string;
}

export interface TitleDetails extends TitleCard {
    runtime?: number;
    status?: string;
    tagline?: string;
    genres: { id: number; name: string }[];
    keywords?: { id: number; name: string }[];
    cast?: Person[];
    crew?: Person[];
    collectionId?: number | null;
    numberOfSeasons?: number;
    numberOfEpisodes?: number;
    externalIds?: Record<string, unknown>;
    videos?: TitleVideo[];
    logoPath: string | null;
    certification?: string;
    /** Certification per country code. */
    ratings?: Record<string, string>;
    seasons?: SeasonSummary[];
    recommendations: TitleCard[];
    similar: TitleCard[];
    watchProviders?: Record<string, unknown>;
}

export interface HomeRow {
    id: string;
    title: { ro: string; en: string };
    kind: "mixed" | MediaKind;
    items: TitleCard[];
    reason?: string;
}

export interface MediaHome {
    region: string;
    profile: string;
    configured: boolean;
    revision: number;
    libraryEtag: number | null;
    serverId: string | null;
    serverName: string;
    rows: HomeRow[];
}

export interface MediaStatus {
    configured: boolean;
    tmdb: boolean;
    motn: boolean;
    region: string;
    language: string;
    revision: number;
    libraryEtag: number | null;
    libraryCount: number;
    serverId: string | null;
    serverName: string;
}

export interface MediaEtag {
    revision: number;
    libraryEtag: number | null;
}

export interface LibraryIndexRow {
    /** Same id `/video/direct/:fileId` expects. */
    serverFileId: string;
    kind: MediaKind;
    tmdbId: number | null;
    season: number | null;
    episode: number | null;
    path: string;
    size: number;
    mtime: number;
    updatedAt: number;
    rev?: number;
}

export interface LibraryIndex {
    revision: number;
    full: boolean;
    items: LibraryIndexRow[];
    removed: string[];
    serverId: string | null;
    serverName: string;
}

export interface ProgressEntry {
    profileId: string;
    kind: MediaKind;
    tmdbId: number;
    season: number;
    episode: number;
    positionSec: number;
    durationSec: number;
    completed: boolean;
    updatedAt: number;
    rev?: number;
}

export interface ProgressInput {
    profileId?: string;
    kind: MediaKind;
    tmdbId: number;
    season?: number;
    episode?: number;
    positionSec: number;
    durationSec: number;
    completed?: boolean;
    updatedAt?: number;
}

export interface MediaTitleResponse {
    title: TitleDetails;
    availability: Availability;
    files: VersionedFile[];
    progress: ProgressEntry[];
    nextUp?: NextEpisode | null;
    inWatchlist?: boolean;
    serverId: string | null;
    serverName: string;
}

export interface MediaSearchPage {
    page: number;
    totalPages: number;
    results: TitleCard[];
}

// ─── Versions / seasons (WP16-04) ────────────────────────────────────────────

export interface VersionInfo {
    resolution: "2160p" | "1080p" | "720p" | "480p" | null;
    hdr: "DV" | "HDR10+" | "HDR" | null;
    edition: string | null;
    remux: boolean;
    label: string;
    rank: number;
}

export interface VersionedFile extends LibraryIndexRow {
    version: VersionInfo;
}

export interface SeasonSummary {
    seasonNumber: number;
    name: string;
    episodeCount: number;
    airDate?: string;
    posterPath: string | null;
}

export interface SeasonEpisode {
    seasonNumber: number;
    episodeNumber: number;
    name: string;
    overview?: string;
    stillPath: string | null;
    airDate?: string;
    runtime?: number;
    voteAverage?: number;
    files: VersionedFile[];
    progress: ProgressEntry | null;
}

export interface MediaSeasonResponse {
    tmdbId: number;
    seasonNumber: number;
    name: string;
    overview?: string;
    posterPath: string | null;
    episodes: SeasonEpisode[];
    serverId: string | null;
}

// ─── Profiles + watchlist (WP16-02/03) ───────────────────────────────────────

export interface Profile {
    id: string;
    name: string;
    avatar: string | null;
    color: string | null;
    kind: "adult" | "kid";
    /** Max viewer age allowed (null = unrestricted). */
    maxAge: number | null;
    hasPin: boolean;
    prefs: Record<string, unknown>;
    sort: number;
    createdAt: number;
    updatedAt: number;
}

export interface ProfileInput {
    name?: string;
    avatar?: string | null;
    color?: string | null;
    kind?: "adult" | "kid";
    maxAge?: number | null;
    /** 4 digits; null clears the PIN. */
    pin?: string | null;
    prefs?: Record<string, unknown>;
    sort?: number;
}

export interface WatchlistEntry {
    profileId: string;
    kind: MediaKind;
    tmdbId: number;
    addedAt: number;
    rev?: number;
}

export interface WatchlistResponse {
    revision: number;
    entries: WatchlistEntry[];
    items: TitleCard[];
}

// ─── Music (`/media/music/*`, WP16-11) ───────────────────────────────────────

export interface AlbumCard {
    id: string;
    name: string;
    artist: string | null;
    artistId: string | null;
    year?: number | null;
    genre?: string | null;
    songCount: number;
    durationSec: number;
    coverArt: string;
    /** Relative to the server origin; append the Subsonic apiKey (see `MusicClient.coverUrl`). */
    coverUrlPath: string;
}

export interface TrackCard {
    id: string;
    title: string;
    artist?: string | null;
    artistId?: string | null;
    album?: string | null;
    albumId: string;
    track?: number | null;
    disc?: number | null;
    year?: number | null;
    genre?: string | null;
    durationSec: number;
    format: string;
    bitrate?: number | null;
    sampleRate?: number | null;
    hasLyrics: boolean;
    hasSyncedLyrics: boolean;
    plays?: number;
    /** Tempo in BPM (file tag, Deezer or analyzer); absent when unknown (server 3.13+). */
    bpm?: number | null;
    /** Analyzer tempo confidence 0..1; absent for tag / Deezer BPM. */
    bpmConfidence?: number | null;
    /** Camelot key (analyzer or file tag), e.g. `8A`. */
    keyCamelot?: string | null;
    /** First downbeat (else first beat) in seconds; present only when a beat grid was measured. */
    firstBeatSec?: number | null;
    coverArt: string;
    coverUrlPath: string;
    streamUrlPath: string;
}

export interface ArtistCard {
    id: string;
    name: string;
    albumCount: number;
    songCount: number;
    coverArt: string;
    coverUrlPath: string;
}

export interface PlaylistCard {
    id: string;
    name: string;
    songCount: number;
    durationSec: number;
    coverArt: string | null;
    coverUrlPath: string | null;
}

export interface GenreCard {
    name: string;
    songCount: number;
    albumCount: number;
}

export interface MusicHome {
    profileId: string;
    recent: AlbumCard[];
    newest: AlbumCard[];
    mostPlayed: TrackCard[];
    playlists: PlaylistCard[];
    genres: GenreCard[];
    randomAlbums: AlbumCard[];
}

export interface Page<T> {
    total: number;
    offset: number;
    limit: number;
    items: T[];
}

export type ArtistPage = Page<ArtistCard>;
export type AlbumPage = Page<AlbumCard>;
export type TrackPage = Page<TrackCard>;

export interface ArtistDetail {
    artist: ArtistCard;
    albums: AlbumCard[];
    topTracks: TrackCard[];
    similar: ArtistCard[];
}

export interface AlbumDetail {
    album: AlbumCard;
    tracks: TrackCard[];
}

export interface GenreAlbums extends Page<AlbumCard> {
    genre: string;
}

export interface PlaylistDetail {
    playlist: PlaylistCard;
    tracks: TrackCard[];
}

export interface MusicSearch {
    query: string;
    artists: ArtistCard[];
    albums: AlbumCard[];
    tracks: TrackCard[];
}

export type RepeatMode = "off" | "all" | "one";

export interface MusicQueueInput {
    trackIds: string[];
    index?: number;
    positionSec?: number;
    shuffle?: boolean;
    repeat?: RepeatMode;
}

export interface MusicQueue {
    profileId: string;
    trackIds: string[];
    index: number;
    positionSec: number;
    shuffle: boolean;
    repeat: RepeatMode;
    updatedAt: number;
}

export interface LyricLine {
    timeMs: number;
    text: string;
}

export interface Lyrics {
    trackId: string;
    synced: LyricLine[] | null;
    plain: string | null;
    source: "embedded" | "sidecar" | "lrclib" | "none";
}

export interface TrackPlayInput {
    profileId?: string;
    trackKey: string;
    durationSec?: number;
    completed?: boolean;
    playedAt?: number;
}

// ─── Year in review (`/media/stats`) ─────────────────────────────────────────

export interface MediaStats {
    year: number;
    profileId: string;
    watch: {
        hours: number;
        titles: number;
        movies: number;
        episodes: number;
        completed: number;
        topGenres: { id: number; name: string; hours: number }[];
        longestStreakDays: number;
        byMonth: number[];
        topTitles: { kind: string; tmdbId: number; title: string; hours: number }[];
    };
    listen: {
        hours: number;
        plays: number;
        topTracks: { trackKey: string; plays: number }[];
        byMonth: number[];
    };
}

// ─── Live TV (`/livetv/*`, WP16-12..16) ──────────────────────────────────────

export type LiveTvSourceKind = "m3u" | "xtream" | "hdhomerun";

export interface LiveTvSourceInput {
    kind?: LiveTvSourceKind;
    name?: string;
    url?: string;
    xmltvUrl?: string | null;
    username?: string | null;
    password?: string | null;
    enabled?: boolean;
    refreshHours?: number;
    tunerLimit?: number;
}

export interface LiveTvSource {
    id: string;
    kind: LiveTvSourceKind;
    name: string;
    /** Credentials masked. */
    url: string;
    xmltvUrl?: string | null;
    username?: string | null;
    hasPassword: boolean;
    enabled: boolean;
    refreshHours: number;
    lastRefresh?: number | null;
    lastError?: string | null;
    channelCount: number;
    guideRefreshedAt?: number | null;
    guideError?: string | null;
    tunerLimit: number;
    createdAt: number;
    updatedAt: number;
}

export interface LiveTvChannel {
    id: string;
    sourceId: string;
    number?: string | null;
    name: string;
    logo?: string | null;
    group?: string | null;
    tvgId?: string | null;
    archiveDays: number;
    catchup: boolean;
    hidden: boolean;
    sort?: number | null;
    favourite: boolean;
}

export interface LiveTvProgramme {
    channelId: string;
    /** Epoch ms. */
    start: number;
    stop: number;
    title: string;
    subtitle?: string | null;
    description?: string | null;
    category?: string | null;
    episodeNum?: string | null;
    icon?: string | null;
}

export interface LiveTvNowNext {
    channelId: string;
    now?: LiveTvProgramme | null;
    next?: LiveTvProgramme | null;
}

export interface LiveTvRecording {
    id: string;
    channelId: string;
    channelName?: string | null;
    title: string;
    start: number;
    stop: number;
    paddingBeforeSec?: number;
    paddingAfterSec?: number;
    status: "scheduled" | "recording" | "done" | "failed" | "cancelled";
    path?: string | null;
    error?: string | null;
    ruleId?: string | null;
    createdAt: number;
    conflict: boolean;
}

export interface LiveTvRecordInput {
    channelId: string;
    start?: number;
    stop?: number;
    title?: string;
    /** Programme start (epoch ms) or `{start}` of a guide entry. */
    programme?: number | { start: number };
    paddingBeforeSec?: number;
    paddingAfterSec?: number;
}

export interface LiveTvRule {
    id: string;
    titleMatch: string;
    channelId?: string | null;
    paddingBeforeSec: number;
    paddingAfterSec: number;
    keepLast: number;
    enabled: boolean;
    createdAt: number;
}

export interface LiveTvRuleInput {
    titleMatch: string;
    channelId?: string | null;
    paddingBeforeSec?: number;
    paddingAfterSec?: number;
    keepLast?: number;
    enabled?: boolean;
}

// ─── Hub (`WS /hub`, `/hub/*`, WP16-07/08) ───────────────────────────────────

export interface HubMedia {
    fileId?: string;
    kind?: string;
    tmdbId?: number;
    season?: number;
    episode?: number;
    title?: string;
    posterPath?: string | null;
    durationSec?: number;
    /** Live TV channel id, when the media is a channel. */
    channelId?: string;
}

export interface HubNowPlaying {
    playing: boolean;
    positionSec: number;
    durationSec?: number;
    media?: HubMedia;
    at: number;
}

export interface HubDevice {
    deviceId: string;
    name: string;
    platform: string;
    caps: string[];
    profileId: string | null;
    app: string | null;
    connectedAt: number;
    guest: boolean;
    nowPlaying: HubNowPlaying | null;
}

export interface HubAck {
    ok: boolean;
    seq?: string;
    error?: string;
    from?: string;
    state?: Record<string, unknown>;
}

export type HubRoomPhase = "idle" | "waiting" | "playing" | "paused";

export interface HubRoom {
    id: string;
    name: string;
    phase: HubRoomPhase;
    media: HubMedia | null;
    anchor: { playing: boolean; positionSec: number; atServerMs: number };
    hostConnId: string | null;
    members: { connId: string; name: string; ready: boolean; guest: boolean }[];
}
