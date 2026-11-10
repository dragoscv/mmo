// GENERATED FILE — do not edit by hand.
// Source: server/openapi.yaml (info.version 3.15.0); generator: server/scripts/openapi-kotlin.mjs
// Regenerate with: pnpm --dir server openapi:gen
@file:Suppress("unused")

package ro.mixai.tv.data.generated

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

@Serializable
data class Health(
    val status: String = "",
    val version: String = "",
    val hostname: String = "",
    val platform: String = "",
    val uptime: Double = 0.0,
)

@Serializable
data class PairInfo(
    val name: String = "",
    val version: String = "",
    val lanUrl: String? = null,
    val port: Long = 0L,
    val pairingSupported: Boolean = false,
    val hasToken: Boolean = false,
)

@Serializable
data class PairRequest(
    val deviceName: String? = null,
    val platform: String? = null,
)

@Serializable
data class PairRequestResponse(
    val code: String = "",
    val secret: String = "",
    val expiresAt: Long = 0L,
    val qr: String = "",
    val approveUrl: String = "",
)

@Serializable
data class PairPollResponse(
    val status: String = "",
    val deviceToken: String? = null,
    val userId: String? = null,
)

@Serializable
data class PairApproveRequest(
    val code: String = "",
)

@Serializable
data class PairApproveResponse(
    val ok: Boolean = false,
    val code: String = "",
)

@Serializable
data class PairPending(
    val code: String = "",
    val deviceName: String = "",
    val platform: String = "",
    val createdAt: Long = 0L,
    val expiresAt: Long = 0L,
    val approved: Boolean = false,
)

@Serializable
data class ParsedFilename(
    val title: String = "",
    val year: Long? = null,
    val season: Long? = null,
    val episode: Long? = null,
)

@Serializable
data class AudioTrack(
    val index: Long = 0L,
    val codec: String = "",
    val channels: Long = 0L,
    val lang: String? = null,
    val title: String? = null,
)

@Serializable
data class SubtitleTrack(
    val index: Long = 0L,
    val codec: String = "",
    val lang: String? = null,
    val title: String? = null,
    val forced: Boolean = false,
)

/** One entry of `POST /video/scan` `files`. */
@Serializable
data class VideoFile(
    val fileId: String = "",
    val parsed: ParsedFilename = ParsedFilename(),
    val path: String = "",
    val sizeBytes: Long = 0L,
    val mtime: String = "",
    val container: String? = null,
    val videoCodec: String? = null,
    val audioCodec: String? = null,
    val width: Long? = null,
    val height: Long? = null,
    val durationSec: Double? = null,
    val bitrateKbps: Long? = null,
    val hdr: String? = null,
    val audioTracks: List<AudioTrack> = emptyList(),
    val subtitleTracks: List<SubtitleTrack> = emptyList(),
)

@Serializable
data class VideoScanResult(
    val files: List<VideoFile> = emptyList(),
    val rootsScanned: Long = 0L,
    val pendingRoots: List<String>? = null,
    val jobIds: List<String>? = null,
)

@Serializable
data class VideoInfo(
    val fileId: String = "",
    val parsed: ParsedFilename = ParsedFilename(),
    val path: String = "",
    val sizeBytes: Long = 0L,
    val mtime: String = "",
    val container: String? = null,
    val videoCodec: String? = null,
    val audioCodec: String? = null,
    val width: Long? = null,
    val height: Long? = null,
    val durationSec: Double? = null,
    val bitrateKbps: Long? = null,
    val hdr: String? = null,
    val audioTracks: List<AudioTrack> = emptyList(),
    val subtitleTracks: List<SubtitleTrack> = emptyList(),
    val hasSidecar: Boolean = false,
)

@Serializable
data class SubtitleResult(
    val provider: String = "",
    val id: String = "",
    val language: String = "",
    val title: String = "",
    val release: String? = null,
    val downloads: Long? = null,
    val downloadToken: String = "",
)

/** Row of the companion tracks table. Every field except id, userId, filepath and filename is nullable. */
@Serializable
data class Track(
    val id: Long? = null,
    val userId: String? = null,
    val filepath: String? = null,
    val filename: String? = null,
    val artist: String? = null,
    val title: String? = null,
    val album: String? = null,
    val remix: String? = null,
    val label: String? = null,
    val bpm: Double? = null,
    val keyCamelot: String? = null,
    val keyMusical: String? = null,
    val duration: Long? = null,
    val energy: Long? = null,
    val genre: String? = null,
    val subgenre: String? = null,
    val mood: String? = null,
    val color: String? = null,
    val vocalType: String? = null,
    val setPosition: String? = null,
    val mixability: Long? = null,
    val isProcessed: Boolean? = null,
    val fileSize: Long? = null,
    val format: String? = null,
    val bitrate: Long? = null,
    val sampleRate: Long? = null,
    val addedAt: String? = null,
    val analyzedAt: String? = null,
    val rating: Long? = null,
    val isFavorite: Boolean? = null,
    val tags: String? = null,
    val artworkUrl: String? = null,
    val musicbrainzId: String? = null,
    val releaseMbid: String? = null,
    val isrc: String? = null,
    val year: Long? = null,
    val comment: String? = null,
    val lyrics: String? = null,
    val syncedLyrics: String? = null,
    val isHidden: Boolean? = null,
    val sourceUrl: String? = null,
    val sourcePlatform: String? = null,
    val sourceId: String? = null,
    val relatedTrackId: Long? = null,
    val deviceId: String? = null,
    val isOfflineAvailable: Boolean? = null,
    val stemsStatus: String? = null,
    val stemsVocalsPath: String? = null,
    val stemsDrumsPath: String? = null,
    val stemsBassPath: String? = null,
    val stemsMelodyPath: String? = null,
    val stemsAnalyzedAt: String? = null,
    val stemsModel: String? = null,
    val stemsError: String? = null,
    val loudnessLufs: Double? = null,
    val loudnessTruePeakDbfs: Double? = null,
    val loudnessRangeLu: Double? = null,
    val acoustidFingerprint: String? = null,
    val acoustidId: String? = null,
    val bpmConfidence: Double? = null,
    val keyConfidence: Double? = null,
    val beats: String? = null,
    val downbeats: String? = null,
    val chordProgression: String? = null,
    val structureSegments: String? = null,
    val dspAnalyzedAt: String? = null,
    val sha256: String? = null,
    val fieldVersions: String? = null,
)

@Serializable
data class Playlist(
    val id: Long = 0L,
    val userId: String? = null,
    val name: String = "",
    val description: String? = null,
    val type: String? = null,
    val createdAt: String? = null,
    val externalId: String? = null,
    val updatedAt: String? = null,
)

@Serializable
data class PreRemuxJob(
    val fileId: String = "",
    val sourcePath: String = "",
    val sidecarPath: String = "",
    val status: String = "",
    val progress: Double = 0.0,
    val durationSec: Double? = null,
    val error: String? = null,
    val enqueuedAt: Long = 0L,
    val startedAt: Long? = null,
    val finishedAt: Long? = null,
)

@Serializable
data class MediaStatus(
    val configured: Boolean = false,
    val tmdb: Boolean = false,
    val motn: Boolean = false,
    val region: String = "",
    val language: String = "",
    val revision: Long = 0L,
    val libraryEtag: Long = 0L,
    val libraryCount: Long = 0L,
    val serverId: String? = null,
    val serverName: String = "",
    val sync: JsonObject? = null,
)

@Serializable
data class MediaEtag(
    val revision: Long = 0L,
    val libraryEtag: Long = 0L,
)

@Serializable
data class NextEpisode(
    val season: Long = 0L,
    val episode: Long = 0L,
    val positionSec: Double = 0.0,
)

@Serializable
data class TitleCard(
    val kind: String = "",
    val tmdbId: Long = 0L,
    val title: String = "",
    val originalTitle: String? = null,
    val overview: String? = null,
    val posterPath: String? = null,
    val backdropPath: String? = null,
    val releaseDate: String? = null,
    val voteAverage: Double? = null,
    val voteCount: Long? = null,
    val popularity: Double? = null,
    val genreIds: List<Long> = emptyList(),
    val inLibrary: Boolean? = null,
    val progress: Double? = null,
    val reason: String? = null,
    val age: Long? = null,
    val nextEpisode: NextEpisode? = null,
)

@Serializable
data class HomeRow(
    val id: String = "",
    val title: JsonObject = JsonObject(emptyMap()),
    val kind: String = "",
    val items: List<TitleCard> = emptyList(),
    val reason: String? = null,
)

@Serializable
data class MediaHome(
    val region: String = "",
    val profile: String = "",
    val configured: Boolean = false,
    val revision: Long = 0L,
    val libraryEtag: Long = 0L,
    val serverId: String? = null,
    val serverName: String = "",
    val rows: List<HomeRow> = emptyList(),
)

@Serializable
data class Person(
    val id: Long = 0L,
    val name: String = "",
    val role: String = "",
    val profilePath: String? = null,
)

@Serializable
data class SeasonSummary(
    val seasonNumber: Long = 0L,
    val name: String = "",
    val episodeCount: Long = 0L,
    val airDate: String? = null,
    val posterPath: String? = null,
)

@Serializable
data class TitleDetails(
    val kind: String = "",
    val tmdbId: Long = 0L,
    val title: String = "",
    val originalTitle: String? = null,
    val overview: String? = null,
    val posterPath: String? = null,
    val backdropPath: String? = null,
    val releaseDate: String? = null,
    val voteAverage: Double? = null,
    val voteCount: Long? = null,
    val popularity: Double? = null,
    val genreIds: List<Long> = emptyList(),
    val inLibrary: Boolean? = null,
    val progress: Double? = null,
    val reason: String? = null,
    val age: Long? = null,
    val nextEpisode: NextEpisode? = null,
    val runtime: Long? = null,
    val status: String? = null,
    val tagline: String? = null,
    val genres: List<JsonObject> = emptyList(),
    val keywords: List<JsonObject> = emptyList(),
    val cast: List<Person> = emptyList(),
    val crew: List<Person> = emptyList(),
    val collectionId: Long? = null,
    val numberOfSeasons: Long? = null,
    val numberOfEpisodes: Long? = null,
    val externalIds: Map<String, JsonElement> = emptyMap(),
    val videos: List<JsonObject> = emptyList(),
    val logoPath: String? = null,
    val certification: String? = null,
    val ratings: Map<String, String>? = null,
    val seasons: List<SeasonSummary>? = null,
    val recommendations: List<TitleCard> = emptyList(),
    val similar: List<TitleCard> = emptyList(),
    val watchProviders: Map<String, JsonElement> = emptyMap(),
)

/** How to open a title on a provider — exact deep link when known, otherwise the provider's search page; native intents for TVs. */
@Serializable
data class LaunchData(
    val web: String = "",
    val search: String = "",
    val android: JsonObject? = null,
    val tizen: JsonObject? = null,
)

@Serializable
data class Offer(
    val providerId: Long = 0L,
    val name: String = "",
    val logo: String? = null,
    val type: String = "",
    val link: String? = null,
    val launch: LaunchData = LaunchData(),
)

@Serializable
data class Availability(
    val offers: List<Offer> = emptyList(),
    val source: String = "",
    val attribution: List<String> = emptyList(),
    val fetchedAt: Long? = null,
)

@Serializable
data class VersionInfo(
    val resolution: String? = null,
    val hdr: String? = null,
    val edition: String? = null,
    val remux: Boolean = false,
    val label: String = "",
    val rank: Long = 0L,
)

@Serializable
data class VersionedFile(
    val serverFileId: String = "",
    val kind: String = "",
    val tmdbId: Long? = null,
    val season: Long? = null,
    val episode: Long? = null,
    val path: String = "",
    val size: Long = 0L,
    val mtime: Long = 0L,
    val updatedAt: Long = 0L,
    val rev: Long? = null,
    val version: VersionInfo = VersionInfo(),
)

@Serializable
data class ProgressEntry(
    val profileId: String = "",
    val kind: String = "",
    val tmdbId: Long = 0L,
    val season: Long = 0L,
    val episode: Long = 0L,
    val positionSec: Double = 0.0,
    val durationSec: Double = 0.0,
    val completed: Boolean = false,
    val updatedAt: Long = 0L,
    val rev: Long? = null,
)

@Serializable
data class MediaTitleResponse(
    val title: TitleDetails = TitleDetails(),
    val availability: Availability = Availability(),
    val files: List<VersionedFile> = emptyList(),
    val progress: List<ProgressEntry> = emptyList(),
    val nextUp: NextEpisode? = null,
    val inWatchlist: Boolean? = null,
    val serverId: String? = null,
    val serverName: String = "",
)

@Serializable
data class MediaSearchPage(
    val page: Long = 0L,
    val totalPages: Long = 0L,
    val results: List<TitleCard> = emptyList(),
)

@Serializable
data class LibraryIndexRow(
    val serverFileId: String = "",
    val kind: String = "",
    val tmdbId: Long? = null,
    val season: Long? = null,
    val episode: Long? = null,
    val path: String = "",
    val size: Long = 0L,
    val mtime: Long = 0L,
    val updatedAt: Long = 0L,
    val rev: Long? = null,
)

@Serializable
data class LibraryIndex(
    val revision: Long = 0L,
    val full: Boolean = false,
    val items: List<LibraryIndexRow> = emptyList(),
    val removed: List<String> = emptyList(),
    val serverId: String? = null,
    val serverName: String = "",
)

@Serializable
data class ProgressInput(
    val profileId: String? = null,
    val kind: String = "",
    val tmdbId: Long = 0L,
    val season: Long? = null,
    val episode: Long? = null,
    val positionSec: Double = 0.0,
    val durationSec: Double? = null,
    val completed: Boolean? = null,
    val updatedAt: Long? = null,
)

@Serializable
data class ProgressList(
    val revision: Long = 0L,
    val entries: List<ProgressEntry> = emptyList(),
)

@Serializable
data class TrackPlayInput(
    val profileId: String? = null,
    val trackKey: String = "",
    val durationSec: Double? = null,
    val completed: Boolean? = null,
    val playedAt: Long? = null,
)

@Serializable
data class TrackPlay(
    val id: Long = 0L,
    val profileId: String = "",
    val trackKey: String = "",
    val playedAt: Long = 0L,
    val durationSec: Double = 0.0,
    val completed: Boolean = false,
    val rev: Long? = null,
)

@Serializable
data class ProviderCatalog(
    val region: String = "",
    val fetchedAt: Long = 0L,
    val providers: List<JsonObject> = emptyList(),
)

@Serializable
data class SeasonEpisode(
    val seasonNumber: Long = 0L,
    val episodeNumber: Long = 0L,
    val name: String = "",
    val overview: String? = null,
    val stillPath: String? = null,
    val airDate: String? = null,
    val runtime: Long? = null,
    val voteAverage: Double? = null,
    val files: List<VersionedFile> = emptyList(),
    val progress: ProgressEntry? = null,
)

@Serializable
data class MediaSeasonResponse(
    val tmdbId: Long = 0L,
    val seasonNumber: Long = 0L,
    val name: String = "",
    val overview: String? = null,
    val posterPath: String? = null,
    val episodes: List<SeasonEpisode> = emptyList(),
    val serverId: String? = null,
)

@Serializable
data class Profile(
    val id: String = "",
    val name: String = "",
    val avatar: String? = null,
    val color: String? = null,
    val kind: String = "",
    val maxAge: Long? = null,
    val hasPin: Boolean = false,
    val prefs: Map<String, JsonElement> = emptyMap(),
    val sort: Long = 0L,
    val createdAt: Long = 0L,
    val updatedAt: Long = 0L,
)

@Serializable
data class ProfileInput(
    val name: String? = null,
    val avatar: String? = null,
    val color: String? = null,
    val kind: String? = null,
    val maxAge: Long? = null,
    val pin: String? = null,
    val prefs: Map<String, JsonElement>? = null,
    val sort: Long? = null,
)

@Serializable
data class WatchlistEntry(
    val profileId: String = "",
    val kind: String = "",
    val tmdbId: Long = 0L,
    val addedAt: Long = 0L,
    val rev: Long? = null,
)

@Serializable
data class HubMedia(
    val fileId: String? = null,
    val kind: String? = null,
    val tmdbId: Long? = null,
    val season: Long? = null,
    val episode: Long? = null,
    val title: String? = null,
    val posterPath: String? = null,
    val durationSec: Double? = null,
    val channelId: String? = null,
    val trackId: String? = null,
    val artist: String? = null,
    val album: String? = null,
    val coverUrlPath: String? = null,
)

@Serializable
data class HubNowPlaying(
    val playing: Boolean = false,
    val positionSec: Double = 0.0,
    val durationSec: Double? = null,
    val media: HubMedia? = null,
    val at: Long = 0L,
)

@Serializable
data class HubDevice(
    val deviceId: String = "",
    val name: String = "",
    val platform: String = "",
    val formFactor: String? = null,
    val playbackTarget: Boolean? = null,
    val caps: List<String> = emptyList(),
    val profileId: String? = null,
    val app: String? = null,
    val connectedAt: Long = 0L,
    val guest: Boolean = false,
    val nowPlaying: HubNowPlaying? = null,
)

@Serializable
data class HubAck(
    val ok: Boolean = false,
    val seq: String? = null,
    val error: String? = null,
    val from: String? = null,
    val state: Map<String, JsonElement>? = null,
)

@Serializable
data class HubRoom(
    val id: String = "",
    val name: String = "",
    val phase: String = "",
    val media: HubMedia? = null,
    val anchor: JsonObject = JsonObject(emptyMap()),
    val hostConnId: String? = null,
    val members: List<JsonObject> = emptyList(),
)

@Serializable
data class AlbumCard(
    val id: String = "",
    val name: String = "",
    val artist: String? = null,
    val artistId: String? = null,
    val year: Long? = null,
    val genre: String? = null,
    val songCount: Long = 0L,
    val durationSec: Double = 0.0,
    val coverArt: String = "",
    val coverUrlPath: String = "",
)

@Serializable
data class TrackCard(
    val id: String = "",
    val title: String = "",
    val artist: String? = null,
    val artistId: String? = null,
    val album: String? = null,
    val albumId: String = "",
    val track: Long? = null,
    val disc: Long? = null,
    val year: Long? = null,
    val genre: String? = null,
    val durationSec: Double = 0.0,
    val format: String = "",
    val bitrate: Long? = null,
    val sampleRate: Long? = null,
    val hasLyrics: Boolean = false,
    val hasSyncedLyrics: Boolean = false,
    val plays: Long? = null,
    val loudnessLufs: Double? = null,
    val truePeakDbfs: Double? = null,
    val bpm: Double? = null,
    val bpmConfidence: Double? = null,
    val keyCamelot: String? = null,
    val firstBeatSec: Double? = null,
    val coverArt: String = "",
    val coverUrlPath: String = "",
    val streamUrlPath: String = "",
)

@Serializable
data class PlaylistCard(
    val id: String = "",
    val name: String = "",
    val songCount: Long = 0L,
    val durationSec: Double = 0.0,
    val coverArt: String? = null,
    val coverUrlPath: String? = null,
)

@Serializable
data class GenreCard(
    val name: String = "",
    val songCount: Long = 0L,
    val albumCount: Long = 0L,
)

@Serializable
data class MusicHome(
    val profileId: String = "",
    val recent: List<AlbumCard> = emptyList(),
    val newest: List<AlbumCard> = emptyList(),
    val mostPlayed: List<TrackCard> = emptyList(),
    val playlists: List<PlaylistCard> = emptyList(),
    val genres: List<GenreCard> = emptyList(),
    val randomAlbums: List<AlbumCard> = emptyList(),
)

@Serializable
data class ArtistCard(
    val id: String = "",
    val name: String = "",
    val albumCount: Long = 0L,
    val songCount: Long = 0L,
    val coverArt: String = "",
    val coverUrlPath: String = "",
)

@Serializable
data class ArtistPage(
    val total: Long = 0L,
    val offset: Long = 0L,
    val limit: Long = 0L,
    val items: List<ArtistCard> = emptyList(),
)

@Serializable
data class ArtistDetail(
    val artist: ArtistCard = ArtistCard(),
    val albums: List<AlbumCard> = emptyList(),
    val topTracks: List<TrackCard> = emptyList(),
    val similar: List<ArtistCard> = emptyList(),
)

@Serializable
data class AlbumDetail(
    val album: AlbumCard = AlbumCard(),
    val tracks: List<TrackCard> = emptyList(),
)

@Serializable
data class MusicSearch(
    val query: String = "",
    val artists: List<ArtistCard> = emptyList(),
    val albums: List<AlbumCard> = emptyList(),
    val tracks: List<TrackCard> = emptyList(),
)

@Serializable
data class MusicQueue(
    val profileId: String = "",
    val trackIds: List<String> = emptyList(),
    val index: Long = 0L,
    val positionSec: Double = 0.0,
    val shuffle: Boolean = false,
    val repeat: String = "",
    val updatedAt: Long = 0L,
)

@Serializable
data class MusicQueueInput(
    val trackIds: List<String> = emptyList(),
    val index: Long? = null,
    val positionSec: Double? = null,
    val shuffle: Boolean? = null,
    val repeat: String? = null,
)

@Serializable
data class LyricLine(
    val timeMs: Long = 0L,
    val text: String = "",
)

@Serializable
data class Lyrics(
    val trackId: String = "",
    val synced: List<LyricLine>? = null,
    val plain: String? = null,
    val source: String = "",
)

@Serializable
data class BeatGrid(
    val trackId: String = "",
    val bpm: Double? = null,
    val bpmConfidence: Double? = null,
    val keyCamelot: String? = null,
    val beats: List<Double> = emptyList(),
    val downbeats: List<Double> = emptyList(),
    val segments: List<JsonObject> = emptyList(),
)

/** Minutes per local day for the last 7 days (oldest first), from live progress writes and music plays. */
@Serializable
data class WeeklyUsage(
    val profileId: String = "",
    val days: List<String> = emptyList(),
    val watchMin: List<Long> = emptyList(),
    val listenMin: List<Long> = emptyList(),
    val totalWatchMin: Long = 0L,
    val totalListenMin: Long = 0L,
)

@Serializable
data class MediaStats(
    val year: Long = 0L,
    val profileId: String = "",
    val watch: JsonObject = JsonObject(emptyMap()),
    val listen: JsonObject = JsonObject(emptyMap()),
    val weekly: WeeklyUsage? = null,
)

@Serializable
data class LiveTvChannel(
    val id: String = "",
    val sourceId: String = "",
    val number: String? = null,
    val name: String = "",
    val logo: String? = null,
    val group: String? = null,
    val tvgId: String? = null,
    val archiveDays: Long = 0L,
    val catchup: Boolean = false,
    val hidden: Boolean = false,
    val sort: Long? = null,
    val favourite: Boolean = false,
)

@Serializable
data class LiveTvProgramme(
    val channelId: String = "",
    val start: Long = 0L,
    val stop: Long = 0L,
    val title: String = "",
    val subtitle: String? = null,
    val description: String? = null,
    val category: String? = null,
    val episodeNum: String? = null,
    val icon: String? = null,
)

@Serializable
data class LiveTvRecording(
    val id: String = "",
    val channelId: String = "",
    val channelName: String? = null,
    val title: String = "",
    val start: Long = 0L,
    val stop: Long = 0L,
    val paddingBeforeSec: Long? = null,
    val paddingAfterSec: Long? = null,
    val status: String = "",
    val path: String? = null,
    val error: String? = null,
    val ruleId: String? = null,
    val createdAt: Long = 0L,
    val conflict: Boolean = false,
)

@Serializable
data class LiveTvSource(
    val id: String = "",
    val kind: String = "",
    val name: String = "",
    val url: String = "",
    val xmltvUrl: String? = null,
    val username: String? = null,
    val hasPassword: Boolean = false,
    val enabled: Boolean = false,
    val refreshHours: Long = 0L,
    val lastRefresh: Long? = null,
    val lastError: String? = null,
    val channelCount: Long = 0L,
    val guideRefreshedAt: Long? = null,
    val guideError: String? = null,
    val tunerLimit: Long = 0L,
    val createdAt: Long = 0L,
    val updatedAt: Long = 0L,
)

@Serializable
data class Error(
    val error: String = "",
)
