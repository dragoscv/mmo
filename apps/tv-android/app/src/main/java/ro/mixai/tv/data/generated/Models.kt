// GENERATED FILE — do not edit by hand.
// Source: server/openapi.yaml (info.version 3.0.0); generator: server/scripts/openapi-kotlin.mjs
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
data class Error(
    val error: String = "",
)
