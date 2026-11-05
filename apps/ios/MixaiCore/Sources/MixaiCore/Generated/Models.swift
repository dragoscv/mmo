// GENERATED FILE — do not edit by hand.
// Source: server/openapi.yaml (info.version 3.9.5); generator: server/scripts/openapi-swift.mjs
// Regenerate with: pnpm --dir server openapi:gen
// swiftlint:disable all

import Foundation


/// Any JSON value; used where the spec allows free-form data (Kotlin: JsonElement / JsonObject).
public enum JSONValue: Codable, Sendable, Hashable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public init(from decoder: any Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() {
            self = .null
        } else if let b = try? c.decode(Bool.self) {
            self = .bool(b)
        } else if let n = try? c.decode(Double.self) {
            self = .number(n)
        } else if let s = try? c.decode(String.self) {
            self = .string(s)
        } else if let a = try? c.decode([JSONValue].self) {
            self = .array(a)
        } else if let o = try? c.decode([String: JSONValue].self) {
            self = .object(o)
        } else {
            throw DecodingError.dataCorruptedError(in: c, debugDescription: "Unsupported JSON value")
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let b): try c.encode(b)
        case .number(let n): try c.encode(n)
        case .string(let s): try c.encode(s)
        case .array(let a): try c.encode(a)
        case .object(let o): try c.encode(o)
        }
    }
}

public struct Health: Codable, Sendable, Hashable {
    public let status: String
    public let version: String
    public let hostname: String
    public let platform: String
    /// Process uptime in seconds.
    public let uptime: Double

    public init(
        status: String,
        version: String,
        hostname: String,
        platform: String,
        uptime: Double
    ) {
        self.status = status
        self.version = version
        self.hostname = hostname
        self.platform = platform
        self.uptime = uptime
    }
}

public struct PairInfo: Codable, Sendable, Hashable {
    /// Host name of the companion.
    public let name: String
    public let version: String
    public let lanUrl: String?
    public let port: Int
    public let pairingSupported: Bool
    public let hasToken: Bool

    public init(
        name: String,
        version: String,
        lanUrl: String? = nil,
        port: Int,
        pairingSupported: Bool,
        hasToken: Bool
    ) {
        self.name = name
        self.version = version
        self.lanUrl = lanUrl
        self.port = port
        self.pairingSupported = pairingSupported
        self.hasToken = hasToken
    }
}

public struct PairRequest: Codable, Sendable, Hashable {
    public let deviceName: String?
    public let platform: String?

    public init(
        deviceName: String? = nil,
        platform: String? = nil
    ) {
        self.deviceName = deviceName
        self.platform = platform
    }
}

public struct PairRequestResponse: Codable, Sendable, Hashable {
    public let code: String
    /// 64 hex characters.
    public let secret: String
    /// Epoch milliseconds.
    public let expiresAt: Int
    public let qr: String
    public let approveUrl: String

    public init(
        code: String,
        secret: String,
        expiresAt: Int,
        qr: String,
        approveUrl: String
    ) {
        self.code = code
        self.secret = secret
        self.expiresAt = expiresAt
        self.qr = qr
        self.approveUrl = approveUrl
    }
}

public struct PairPollResponse: Codable, Sendable, Hashable {
    public let status: PairStatus
    /// Present only when `status` is `approved`.
    public let deviceToken: String?
    /// Present only when `status` is `approved`.
    public let userId: String?

    public init(
        status: PairStatus,
        deviceToken: String? = nil,
        userId: String? = nil
    ) {
        self.status = status
        self.deviceToken = deviceToken
        self.userId = userId
    }
}

public struct PairApproveRequest: Codable, Sendable, Hashable {
    public let code: String

    public init(
        code: String
    ) {
        self.code = code
    }
}

public struct PairApproveResponse: Codable, Sendable, Hashable {
    public let ok: Bool
    public let code: String

    public init(
        ok: Bool,
        code: String
    ) {
        self.ok = ok
        self.code = code
    }
}

public struct PairPending: Codable, Sendable, Hashable {
    public let code: String
    public let deviceName: String
    public let platform: String
    public let createdAt: Int
    public let expiresAt: Int
    public let approved: Bool

    public init(
        code: String,
        deviceName: String,
        platform: String,
        createdAt: Int,
        expiresAt: Int,
        approved: Bool
    ) {
        self.code = code
        self.deviceName = deviceName
        self.platform = platform
        self.createdAt = createdAt
        self.expiresAt = expiresAt
        self.approved = approved
    }
}

public struct ParsedFilename: Codable, Sendable, Hashable {
    public let title: String
    public let year: Int?
    public let season: Int?
    public let episode: Int?

    public init(
        title: String,
        year: Int? = nil,
        season: Int? = nil,
        episode: Int? = nil
    ) {
        self.title = title
        self.year = year
        self.season = season
        self.episode = episode
    }
}

public struct AudioTrack: Codable, Sendable, Hashable {
    public let index: Int
    public let codec: String
    public let channels: Int
    public let lang: String?
    public let title: String?

    public init(
        index: Int,
        codec: String,
        channels: Int,
        lang: String? = nil,
        title: String? = nil
    ) {
        self.index = index
        self.codec = codec
        self.channels = channels
        self.lang = lang
        self.title = title
    }
}

public struct SubtitleTrack: Codable, Sendable, Hashable {
    public let index: Int
    public let codec: String
    public let lang: String?
    public let title: String?
    public let forced: Bool

    public init(
        index: Int,
        codec: String,
        lang: String? = nil,
        title: String? = nil,
        forced: Bool
    ) {
        self.index = index
        self.codec = codec
        self.lang = lang
        self.title = title
        self.forced = forced
    }
}

/// One entry of `POST /video/scan` `files`.
public struct VideoFile: Codable, Sendable, Hashable {
    public let fileId: String
    public let parsed: ParsedFilename
    public let path: String
    public let sizeBytes: Int
    public let mtime: String
    public let container: String?
    public let videoCodec: String?
    public let audioCodec: String?
    public let width: Int?
    public let height: Int?
    public let durationSec: Double?
    public let bitrateKbps: Int?
    public let hdr: VideoFileHdr?
    public let audioTracks: [AudioTrack]
    public let subtitleTracks: [SubtitleTrack]

    public init(
        fileId: String,
        parsed: ParsedFilename,
        path: String,
        sizeBytes: Int,
        mtime: String,
        container: String? = nil,
        videoCodec: String? = nil,
        audioCodec: String? = nil,
        width: Int? = nil,
        height: Int? = nil,
        durationSec: Double? = nil,
        bitrateKbps: Int? = nil,
        hdr: VideoFileHdr? = nil,
        audioTracks: [AudioTrack],
        subtitleTracks: [SubtitleTrack]
    ) {
        self.fileId = fileId
        self.parsed = parsed
        self.path = path
        self.sizeBytes = sizeBytes
        self.mtime = mtime
        self.container = container
        self.videoCodec = videoCodec
        self.audioCodec = audioCodec
        self.width = width
        self.height = height
        self.durationSec = durationSec
        self.bitrateKbps = bitrateKbps
        self.hdr = hdr
        self.audioTracks = audioTracks
        self.subtitleTracks = subtitleTracks
    }
}

public struct VideoScanResult: Codable, Sendable, Hashable {
    public let files: [VideoFile]
    /// Roots answered from the registry.
    public let rootsScanned: Int
    /// Roots with no registered files yet; a scan job was enqueued for each.
    public let pendingRoots: [String]?
    /// Scan job ids (one per pending root), pollable via `/scan/jobs/{id}`.
    public let jobIds: [String]?

    public init(
        files: [VideoFile],
        rootsScanned: Int,
        pendingRoots: [String]? = nil,
        jobIds: [String]? = nil
    ) {
        self.files = files
        self.rootsScanned = rootsScanned
        self.pendingRoots = pendingRoots
        self.jobIds = jobIds
    }
}

public struct VideoInfo: Codable, Sendable, Hashable {
    public let fileId: String
    public let parsed: ParsedFilename
    public let path: String
    public let sizeBytes: Int
    public let mtime: String
    public let container: String?
    public let videoCodec: String?
    public let audioCodec: String?
    public let width: Int?
    public let height: Int?
    public let durationSec: Double?
    public let bitrateKbps: Int?
    public let hdr: VideoInfoHdr?
    public let audioTracks: [AudioTrack]
    public let subtitleTracks: [SubtitleTrack]
    public let hasSidecar: Bool

    public init(
        fileId: String,
        parsed: ParsedFilename,
        path: String,
        sizeBytes: Int,
        mtime: String,
        container: String? = nil,
        videoCodec: String? = nil,
        audioCodec: String? = nil,
        width: Int? = nil,
        height: Int? = nil,
        durationSec: Double? = nil,
        bitrateKbps: Int? = nil,
        hdr: VideoInfoHdr? = nil,
        audioTracks: [AudioTrack],
        subtitleTracks: [SubtitleTrack],
        hasSidecar: Bool
    ) {
        self.fileId = fileId
        self.parsed = parsed
        self.path = path
        self.sizeBytes = sizeBytes
        self.mtime = mtime
        self.container = container
        self.videoCodec = videoCodec
        self.audioCodec = audioCodec
        self.width = width
        self.height = height
        self.durationSec = durationSec
        self.bitrateKbps = bitrateKbps
        self.hdr = hdr
        self.audioTracks = audioTracks
        self.subtitleTracks = subtitleTracks
        self.hasSidecar = hasSidecar
    }
}

public struct SubtitleResult: Codable, Sendable, Hashable {
    public let provider: SubtitleResultProvider
    public let id: String
    public let language: String
    public let title: String
    public let release: String?
    public let downloads: Int?
    public let downloadToken: String

    public init(
        provider: SubtitleResultProvider,
        id: String,
        language: String,
        title: String,
        release: String? = nil,
        downloads: Int? = nil,
        downloadToken: String
    ) {
        self.provider = provider
        self.id = id
        self.language = language
        self.title = title
        self.release = release
        self.downloads = downloads
        self.downloadToken = downloadToken
    }
}

/// Row of the companion tracks table. Every field except id, userId, filepath and filename is nullable.
public struct Track: Codable, Sendable, Hashable {
    public let id: Int?
    public let userId: String?
    public let filepath: String?
    public let filename: String?
    public let artist: String?
    public let title: String?
    public let album: String?
    public let remix: String?
    public let label: String?
    public let bpm: Double?
    public let keyCamelot: String?
    public let keyMusical: String?
    public let duration: Int?
    public let energy: Int?
    public let genre: String?
    public let subgenre: String?
    public let mood: String?
    public let color: String?
    public let vocalType: String?
    public let setPosition: String?
    public let mixability: Int?
    public let isProcessed: Bool?
    public let fileSize: Int?
    public let format: String?
    public let bitrate: Int?
    public let sampleRate: Int?
    public let addedAt: String?
    public let analyzedAt: String?
    public let rating: Int?
    public let isFavorite: Bool?
    /// JSON-encoded string array.
    public let tags: String?
    public let artworkUrl: String?
    public let musicbrainzId: String?
    public let releaseMbid: String?
    public let isrc: String?
    public let year: Int?
    public let comment: String?
    public let lyrics: String?
    public let syncedLyrics: String?
    public let isHidden: Bool?
    public let sourceUrl: String?
    public let sourcePlatform: String?
    public let sourceId: String?
    public let relatedTrackId: Int?
    public let deviceId: String?
    public let isOfflineAvailable: Bool?
    public let stemsStatus: String?
    public let stemsVocalsPath: String?
    public let stemsDrumsPath: String?
    public let stemsBassPath: String?
    public let stemsMelodyPath: String?
    public let stemsAnalyzedAt: String?
    public let stemsModel: String?
    public let stemsError: String?
    public let loudnessLufs: Double?
    public let loudnessTruePeakDbfs: Double?
    public let loudnessRangeLu: Double?
    public let acoustidFingerprint: String?
    public let acoustidId: String?
    public let bpmConfidence: Double?
    public let keyConfidence: Double?
    /// JSON-encoded number array.
    public let beats: String?
    /// JSON-encoded number array.
    public let downbeats: String?
    /// JSON-encoded array.
    public let chordProgression: String?
    /// JSON-encoded array.
    public let structureSegments: String?
    public let dspAnalyzedAt: String?
    public let sha256: String?
    /// JSON-encoded map of column to ISO-8601 timestamp.
    public let fieldVersions: String?

    public init(
        id: Int? = nil,
        userId: String? = nil,
        filepath: String? = nil,
        filename: String? = nil,
        artist: String? = nil,
        title: String? = nil,
        album: String? = nil,
        remix: String? = nil,
        label: String? = nil,
        bpm: Double? = nil,
        keyCamelot: String? = nil,
        keyMusical: String? = nil,
        duration: Int? = nil,
        energy: Int? = nil,
        genre: String? = nil,
        subgenre: String? = nil,
        mood: String? = nil,
        color: String? = nil,
        vocalType: String? = nil,
        setPosition: String? = nil,
        mixability: Int? = nil,
        isProcessed: Bool? = nil,
        fileSize: Int? = nil,
        format: String? = nil,
        bitrate: Int? = nil,
        sampleRate: Int? = nil,
        addedAt: String? = nil,
        analyzedAt: String? = nil,
        rating: Int? = nil,
        isFavorite: Bool? = nil,
        tags: String? = nil,
        artworkUrl: String? = nil,
        musicbrainzId: String? = nil,
        releaseMbid: String? = nil,
        isrc: String? = nil,
        year: Int? = nil,
        comment: String? = nil,
        lyrics: String? = nil,
        syncedLyrics: String? = nil,
        isHidden: Bool? = nil,
        sourceUrl: String? = nil,
        sourcePlatform: String? = nil,
        sourceId: String? = nil,
        relatedTrackId: Int? = nil,
        deviceId: String? = nil,
        isOfflineAvailable: Bool? = nil,
        stemsStatus: String? = nil,
        stemsVocalsPath: String? = nil,
        stemsDrumsPath: String? = nil,
        stemsBassPath: String? = nil,
        stemsMelodyPath: String? = nil,
        stemsAnalyzedAt: String? = nil,
        stemsModel: String? = nil,
        stemsError: String? = nil,
        loudnessLufs: Double? = nil,
        loudnessTruePeakDbfs: Double? = nil,
        loudnessRangeLu: Double? = nil,
        acoustidFingerprint: String? = nil,
        acoustidId: String? = nil,
        bpmConfidence: Double? = nil,
        keyConfidence: Double? = nil,
        beats: String? = nil,
        downbeats: String? = nil,
        chordProgression: String? = nil,
        structureSegments: String? = nil,
        dspAnalyzedAt: String? = nil,
        sha256: String? = nil,
        fieldVersions: String? = nil
    ) {
        self.id = id
        self.userId = userId
        self.filepath = filepath
        self.filename = filename
        self.artist = artist
        self.title = title
        self.album = album
        self.remix = remix
        self.label = label
        self.bpm = bpm
        self.keyCamelot = keyCamelot
        self.keyMusical = keyMusical
        self.duration = duration
        self.energy = energy
        self.genre = genre
        self.subgenre = subgenre
        self.mood = mood
        self.color = color
        self.vocalType = vocalType
        self.setPosition = setPosition
        self.mixability = mixability
        self.isProcessed = isProcessed
        self.fileSize = fileSize
        self.format = format
        self.bitrate = bitrate
        self.sampleRate = sampleRate
        self.addedAt = addedAt
        self.analyzedAt = analyzedAt
        self.rating = rating
        self.isFavorite = isFavorite
        self.tags = tags
        self.artworkUrl = artworkUrl
        self.musicbrainzId = musicbrainzId
        self.releaseMbid = releaseMbid
        self.isrc = isrc
        self.year = year
        self.comment = comment
        self.lyrics = lyrics
        self.syncedLyrics = syncedLyrics
        self.isHidden = isHidden
        self.sourceUrl = sourceUrl
        self.sourcePlatform = sourcePlatform
        self.sourceId = sourceId
        self.relatedTrackId = relatedTrackId
        self.deviceId = deviceId
        self.isOfflineAvailable = isOfflineAvailable
        self.stemsStatus = stemsStatus
        self.stemsVocalsPath = stemsVocalsPath
        self.stemsDrumsPath = stemsDrumsPath
        self.stemsBassPath = stemsBassPath
        self.stemsMelodyPath = stemsMelodyPath
        self.stemsAnalyzedAt = stemsAnalyzedAt
        self.stemsModel = stemsModel
        self.stemsError = stemsError
        self.loudnessLufs = loudnessLufs
        self.loudnessTruePeakDbfs = loudnessTruePeakDbfs
        self.loudnessRangeLu = loudnessRangeLu
        self.acoustidFingerprint = acoustidFingerprint
        self.acoustidId = acoustidId
        self.bpmConfidence = bpmConfidence
        self.keyConfidence = keyConfidence
        self.beats = beats
        self.downbeats = downbeats
        self.chordProgression = chordProgression
        self.structureSegments = structureSegments
        self.dspAnalyzedAt = dspAnalyzedAt
        self.sha256 = sha256
        self.fieldVersions = fieldVersions
    }
}

public struct Playlist: Codable, Sendable, Hashable {
    public let id: Int
    public let userId: String?
    public let name: String
    public let description: String?
    public let type: String?
    public let createdAt: String?
    public let externalId: String?
    public let updatedAt: String?

    public init(
        id: Int,
        userId: String? = nil,
        name: String,
        description: String? = nil,
        type: String? = nil,
        createdAt: String? = nil,
        externalId: String? = nil,
        updatedAt: String? = nil
    ) {
        self.id = id
        self.userId = userId
        self.name = name
        self.description = description
        self.type = type
        self.createdAt = createdAt
        self.externalId = externalId
        self.updatedAt = updatedAt
    }
}

public struct PreRemuxJob: Codable, Sendable, Hashable {
    public let fileId: String
    public let sourcePath: String
    public let sidecarPath: String
    public let status: PreRemuxJobStatus
    public let progress: Double
    public let durationSec: Double?
    public let error: String?
    public let enqueuedAt: Int
    public let startedAt: Int?
    public let finishedAt: Int?

    public init(
        fileId: String,
        sourcePath: String,
        sidecarPath: String,
        status: PreRemuxJobStatus,
        progress: Double,
        durationSec: Double? = nil,
        error: String? = nil,
        enqueuedAt: Int,
        startedAt: Int? = nil,
        finishedAt: Int? = nil
    ) {
        self.fileId = fileId
        self.sourcePath = sourcePath
        self.sidecarPath = sidecarPath
        self.status = status
        self.progress = progress
        self.durationSec = durationSec
        self.error = error
        self.enqueuedAt = enqueuedAt
        self.startedAt = startedAt
        self.finishedAt = finishedAt
    }
}

public struct MediaStatus: Codable, Sendable, Hashable {
    public let configured: Bool
    public let tmdb: Bool
    public let motn: Bool
    public let region: String
    public let language: String
    public let revision: Int
    public let libraryEtag: Int
    public let libraryCount: Int
    public let serverId: String?
    public let serverName: String
    public let sync: [String: JSONValue]?

    public init(
        configured: Bool,
        tmdb: Bool,
        motn: Bool,
        region: String,
        language: String,
        revision: Int,
        libraryEtag: Int,
        libraryCount: Int,
        serverId: String? = nil,
        serverName: String,
        sync: [String: JSONValue]? = nil
    ) {
        self.configured = configured
        self.tmdb = tmdb
        self.motn = motn
        self.region = region
        self.language = language
        self.revision = revision
        self.libraryEtag = libraryEtag
        self.libraryCount = libraryCount
        self.serverId = serverId
        self.serverName = serverName
        self.sync = sync
    }
}

public struct MediaEtag: Codable, Sendable, Hashable {
    /// Bumps on every progress/play write.
    public let revision: Int
    /// Bumps on every library index change.
    public let libraryEtag: Int

    public init(
        revision: Int,
        libraryEtag: Int
    ) {
        self.revision = revision
        self.libraryEtag = libraryEtag
    }
}

public struct NextEpisode: Codable, Sendable, Hashable {
    public let season: Int
    public let episode: Int
    public let positionSec: Double

    public init(
        season: Int,
        episode: Int,
        positionSec: Double
    ) {
        self.season = season
        self.episode = episode
        self.positionSec = positionSec
    }
}

public struct TitleCard: Codable, Sendable, Hashable {
    public let kind: MediaKind
    public let tmdbId: Int
    public let title: String
    public let originalTitle: String?
    public let overview: String?
    public let posterPath: String?
    public let backdropPath: String?
    public let releaseDate: String?
    public let voteAverage: Double?
    public let voteCount: Int?
    public let popularity: Double?
    public let genreIds: [Int]
    /// Present in this server's library_index.
    public let inLibrary: Bool?
    /// Watched fraction (continue rows).
    public let progress: Double?
    public let reason: String?
    /// Minimum viewer age from certifications (RO CNC scale; 19 = adult-only). Null = unrated.
    public let age: Int?
    public let nextEpisode: NextEpisode?

    public init(
        kind: MediaKind,
        tmdbId: Int,
        title: String,
        originalTitle: String? = nil,
        overview: String? = nil,
        posterPath: String? = nil,
        backdropPath: String? = nil,
        releaseDate: String? = nil,
        voteAverage: Double? = nil,
        voteCount: Int? = nil,
        popularity: Double? = nil,
        genreIds: [Int],
        inLibrary: Bool? = nil,
        progress: Double? = nil,
        reason: String? = nil,
        age: Int? = nil,
        nextEpisode: NextEpisode? = nil
    ) {
        self.kind = kind
        self.tmdbId = tmdbId
        self.title = title
        self.originalTitle = originalTitle
        self.overview = overview
        self.posterPath = posterPath
        self.backdropPath = backdropPath
        self.releaseDate = releaseDate
        self.voteAverage = voteAverage
        self.voteCount = voteCount
        self.popularity = popularity
        self.genreIds = genreIds
        self.inLibrary = inLibrary
        self.progress = progress
        self.reason = reason
        self.age = age
        self.nextEpisode = nextEpisode
    }
}

public struct HomeRow: Codable, Sendable, Hashable {
    /// Stable row id (continue, trending, because:<tmdbId>, provider:<id>, …).
    public let id: String
    public let title: [String: JSONValue]
    public let kind: HomeRowKind
    public let items: [TitleCard]
    public let reason: String?

    public init(
        id: String,
        title: [String: JSONValue],
        kind: HomeRowKind,
        items: [TitleCard],
        reason: String? = nil
    ) {
        self.id = id
        self.title = title
        self.kind = kind
        self.items = items
        self.reason = reason
    }
}

public struct MediaHome: Codable, Sendable, Hashable {
    public let region: String
    public let profile: String
    /// TMDB key present; rows are empty when false.
    public let configured: Bool
    public let revision: Int
    public let libraryEtag: Int
    /// Device id of this server (attribution in multi-server setups).
    public let serverId: String?
    public let serverName: String
    public let rows: [HomeRow]

    public init(
        region: String,
        profile: String,
        configured: Bool,
        revision: Int,
        libraryEtag: Int,
        serverId: String? = nil,
        serverName: String,
        rows: [HomeRow]
    ) {
        self.region = region
        self.profile = profile
        self.configured = configured
        self.revision = revision
        self.libraryEtag = libraryEtag
        self.serverId = serverId
        self.serverName = serverName
        self.rows = rows
    }
}

public struct Person: Codable, Sendable, Hashable {
    public let id: Int
    public let name: String
    public let role: String
    public let profilePath: String?

    public init(
        id: Int,
        name: String,
        role: String,
        profilePath: String? = nil
    ) {
        self.id = id
        self.name = name
        self.role = role
        self.profilePath = profilePath
    }
}

public struct SeasonSummary: Codable, Sendable, Hashable {
    public let seasonNumber: Int
    public let name: String
    public let episodeCount: Int
    public let airDate: String?
    public let posterPath: String?

    public init(
        seasonNumber: Int,
        name: String,
        episodeCount: Int,
        airDate: String? = nil,
        posterPath: String? = nil
    ) {
        self.seasonNumber = seasonNumber
        self.name = name
        self.episodeCount = episodeCount
        self.airDate = airDate
        self.posterPath = posterPath
    }
}

public struct TitleDetails: Codable, Sendable, Hashable {
    public let kind: MediaKind
    public let tmdbId: Int
    public let title: String
    public let originalTitle: String?
    public let overview: String?
    public let posterPath: String?
    public let backdropPath: String?
    public let releaseDate: String?
    public let voteAverage: Double?
    public let voteCount: Int?
    public let popularity: Double?
    public let genreIds: [Int]
    /// Present in this server's library_index.
    public let inLibrary: Bool?
    /// Watched fraction (continue rows).
    public let progress: Double?
    public let reason: String?
    /// Minimum viewer age from certifications (RO CNC scale; 19 = adult-only). Null = unrated.
    public let age: Int?
    public let nextEpisode: NextEpisode?
    public let runtime: Int?
    public let status: String?
    public let tagline: String?
    public let genres: [[String: JSONValue]]
    public let keywords: [[String: JSONValue]]
    public let cast: [Person]
    public let crew: [Person]
    public let collectionId: Int?
    public let numberOfSeasons: Int?
    public let numberOfEpisodes: Int?
    public let externalIds: [String: JSONValue]
    public let videos: [[String: JSONValue]]
    public let logoPath: String?
    public let certification: String?
    /// Certification per country code.
    public let ratings: [String: String]?
    public let seasons: [SeasonSummary]?
    public let recommendations: [TitleCard]
    public let similar: [TitleCard]
    /// Raw TMDB watch/providers.results keyed by region.
    public let watchProviders: [String: JSONValue]

    public init(
        kind: MediaKind,
        tmdbId: Int,
        title: String,
        originalTitle: String? = nil,
        overview: String? = nil,
        posterPath: String? = nil,
        backdropPath: String? = nil,
        releaseDate: String? = nil,
        voteAverage: Double? = nil,
        voteCount: Int? = nil,
        popularity: Double? = nil,
        genreIds: [Int],
        inLibrary: Bool? = nil,
        progress: Double? = nil,
        reason: String? = nil,
        age: Int? = nil,
        nextEpisode: NextEpisode? = nil,
        runtime: Int? = nil,
        status: String? = nil,
        tagline: String? = nil,
        genres: [[String: JSONValue]],
        keywords: [[String: JSONValue]],
        cast: [Person],
        crew: [Person],
        collectionId: Int? = nil,
        numberOfSeasons: Int? = nil,
        numberOfEpisodes: Int? = nil,
        externalIds: [String: JSONValue],
        videos: [[String: JSONValue]],
        logoPath: String? = nil,
        certification: String? = nil,
        ratings: [String: String]? = nil,
        seasons: [SeasonSummary]? = nil,
        recommendations: [TitleCard],
        similar: [TitleCard],
        watchProviders: [String: JSONValue]
    ) {
        self.kind = kind
        self.tmdbId = tmdbId
        self.title = title
        self.originalTitle = originalTitle
        self.overview = overview
        self.posterPath = posterPath
        self.backdropPath = backdropPath
        self.releaseDate = releaseDate
        self.voteAverage = voteAverage
        self.voteCount = voteCount
        self.popularity = popularity
        self.genreIds = genreIds
        self.inLibrary = inLibrary
        self.progress = progress
        self.reason = reason
        self.age = age
        self.nextEpisode = nextEpisode
        self.runtime = runtime
        self.status = status
        self.tagline = tagline
        self.genres = genres
        self.keywords = keywords
        self.cast = cast
        self.crew = crew
        self.collectionId = collectionId
        self.numberOfSeasons = numberOfSeasons
        self.numberOfEpisodes = numberOfEpisodes
        self.externalIds = externalIds
        self.videos = videos
        self.logoPath = logoPath
        self.certification = certification
        self.ratings = ratings
        self.seasons = seasons
        self.recommendations = recommendations
        self.similar = similar
        self.watchProviders = watchProviders
    }
}

/// How to open a title on a provider — exact deep link when known, otherwise the provider's search page; native intents for TVs.
public struct LaunchData: Codable, Sendable, Hashable {
    public let web: String
    public let search: String
    public let android: [String: JSONValue]?
    public let tizen: [String: JSONValue]?

    public init(
        web: String,
        search: String,
        android: [String: JSONValue]? = nil,
        tizen: [String: JSONValue]? = nil
    ) {
        self.web = web
        self.search = search
        self.android = android
        self.tizen = tizen
    }
}

public struct Offer: Codable, Sendable, Hashable {
    /// TMDB watch-provider id.
    public let providerId: Int
    public let name: String
    /// TMDB logo path.
    public let logo: String?
    public let type: OfferType
    /// Exact deep link (Movie of the Night); absent with TMDB/JustWatch data.
    public let link: String?
    public let launch: LaunchData

    public init(
        providerId: Int,
        name: String,
        logo: String? = nil,
        type: OfferType,
        link: String? = nil,
        launch: LaunchData
    ) {
        self.providerId = providerId
        self.name = name
        self.logo = logo
        self.type = type
        self.link = link
        self.launch = launch
    }
}

public struct Availability: Codable, Sendable, Hashable {
    public let offers: [Offer]
    public let source: AvailabilitySource
    /// Data-source credits that must be shown (JustWatch, Movie of the Night).
    public let attribution: [String]
    public let fetchedAt: Int?

    public init(
        offers: [Offer],
        source: AvailabilitySource,
        attribution: [String],
        fetchedAt: Int? = nil
    ) {
        self.offers = offers
        self.source = source
        self.attribution = attribution
        self.fetchedAt = fetchedAt
    }
}

public struct VersionInfo: Codable, Sendable, Hashable {
    public let resolution: VersionInfoResolution?
    public let hdr: VersionInfoHdr?
    public let edition: String?
    public let remux: Bool
    public let label: String
    public let rank: Int

    public init(
        resolution: VersionInfoResolution? = nil,
        hdr: VersionInfoHdr? = nil,
        edition: String? = nil,
        remux: Bool,
        label: String,
        rank: Int
    ) {
        self.resolution = resolution
        self.hdr = hdr
        self.edition = edition
        self.remux = remux
        self.label = label
        self.rank = rank
    }
}

public struct VersionedFile: Codable, Sendable, Hashable {
    /// Same id as /video/direct/{fileId}.
    public let serverFileId: String
    public let kind: MediaKind
    /// Null when the title could not be matched (or no TMDB key).
    public let tmdbId: Int?
    public let season: Int?
    public let episode: Int?
    public let path: String
    public let size: Int
    public let mtime: Int
    public let updatedAt: Int
    /// Library etag at which this row was last written.
    public let rev: Int?
    public let version: VersionInfo

    public init(
        serverFileId: String,
        kind: MediaKind,
        tmdbId: Int? = nil,
        season: Int? = nil,
        episode: Int? = nil,
        path: String,
        size: Int,
        mtime: Int,
        updatedAt: Int,
        rev: Int? = nil,
        version: VersionInfo
    ) {
        self.serverFileId = serverFileId
        self.kind = kind
        self.tmdbId = tmdbId
        self.season = season
        self.episode = episode
        self.path = path
        self.size = size
        self.mtime = mtime
        self.updatedAt = updatedAt
        self.rev = rev
        self.version = version
    }
}

public struct ProgressEntry: Codable, Sendable, Hashable {
    public let profileId: String
    public let kind: MediaKind
    public let tmdbId: Int
    public let season: Int
    public let episode: Int
    public let positionSec: Double
    public let durationSec: Double
    public let completed: Bool
    public let updatedAt: Int
    /// Revision at which this row was last written.
    public let rev: Int?

    public init(
        profileId: String,
        kind: MediaKind,
        tmdbId: Int,
        season: Int,
        episode: Int,
        positionSec: Double,
        durationSec: Double,
        completed: Bool,
        updatedAt: Int,
        rev: Int? = nil
    ) {
        self.profileId = profileId
        self.kind = kind
        self.tmdbId = tmdbId
        self.season = season
        self.episode = episode
        self.positionSec = positionSec
        self.durationSec = durationSec
        self.completed = completed
        self.updatedAt = updatedAt
        self.rev = rev
    }
}

public struct MediaTitleResponse: Codable, Sendable, Hashable {
    public let title: TitleDetails
    public let availability: Availability
    public let files: [VersionedFile]
    public let progress: [ProgressEntry]
    public let nextUp: NextEpisode?
    public let inWatchlist: Bool?
    public let serverId: String?
    public let serverName: String

    public init(
        title: TitleDetails,
        availability: Availability,
        files: [VersionedFile],
        progress: [ProgressEntry],
        nextUp: NextEpisode? = nil,
        inWatchlist: Bool? = nil,
        serverId: String? = nil,
        serverName: String
    ) {
        self.title = title
        self.availability = availability
        self.files = files
        self.progress = progress
        self.nextUp = nextUp
        self.inWatchlist = inWatchlist
        self.serverId = serverId
        self.serverName = serverName
    }
}

public struct MediaSearchPage: Codable, Sendable, Hashable {
    public let page: Int
    public let totalPages: Int
    public let results: [TitleCard]

    public init(
        page: Int,
        totalPages: Int,
        results: [TitleCard]
    ) {
        self.page = page
        self.totalPages = totalPages
        self.results = results
    }
}

public struct LibraryIndexRow: Codable, Sendable, Hashable {
    /// Same id as /video/direct/{fileId}.
    public let serverFileId: String
    public let kind: MediaKind
    /// Null when the title could not be matched (or no TMDB key).
    public let tmdbId: Int?
    public let season: Int?
    public let episode: Int?
    public let path: String
    public let size: Int
    public let mtime: Int
    public let updatedAt: Int
    /// Library etag at which this row was last written.
    public let rev: Int?

    public init(
        serverFileId: String,
        kind: MediaKind,
        tmdbId: Int? = nil,
        season: Int? = nil,
        episode: Int? = nil,
        path: String,
        size: Int,
        mtime: Int,
        updatedAt: Int,
        rev: Int? = nil
    ) {
        self.serverFileId = serverFileId
        self.kind = kind
        self.tmdbId = tmdbId
        self.season = season
        self.episode = episode
        self.path = path
        self.size = size
        self.mtime = mtime
        self.updatedAt = updatedAt
        self.rev = rev
    }
}

public struct LibraryIndex: Codable, Sendable, Hashable {
    /// Current libraryEtag; pass back as since.
    public let revision: Int
    public let full: Bool
    public let items: [LibraryIndexRow]
    /// File ids removed since `since` (empty on a full response).
    public let removed: [String]
    public let serverId: String?
    public let serverName: String

    public init(
        revision: Int,
        full: Bool,
        items: [LibraryIndexRow],
        removed: [String],
        serverId: String? = nil,
        serverName: String
    ) {
        self.revision = revision
        self.full = full
        self.items = items
        self.removed = removed
        self.serverId = serverId
        self.serverName = serverName
    }
}

public struct ProgressInput: Codable, Sendable, Hashable {
    /// Required unless ?profile= is given.
    public let profileId: String?
    public let kind: MediaKind
    public let tmdbId: Int
    public let season: Int?
    public let episode: Int?
    public let positionSec: Double
    public let durationSec: Double?
    public let completed: Bool?
    /// Epoch ms; defaults to server time.
    public let updatedAt: Int?

    public init(
        profileId: String? = nil,
        kind: MediaKind,
        tmdbId: Int,
        season: Int? = nil,
        episode: Int? = nil,
        positionSec: Double,
        durationSec: Double? = nil,
        completed: Bool? = nil,
        updatedAt: Int? = nil
    ) {
        self.profileId = profileId
        self.kind = kind
        self.tmdbId = tmdbId
        self.season = season
        self.episode = episode
        self.positionSec = positionSec
        self.durationSec = durationSec
        self.completed = completed
        self.updatedAt = updatedAt
    }
}

public struct ProgressList: Codable, Sendable, Hashable {
    public let revision: Int
    public let entries: [ProgressEntry]

    public init(
        revision: Int,
        entries: [ProgressEntry]
    ) {
        self.revision = revision
        self.entries = entries
    }
}

public struct TrackPlayInput: Codable, Sendable, Hashable {
    public let profileId: String?
    public let trackKey: String
    public let durationSec: Double?
    public let completed: Bool?
    public let playedAt: Int?

    public init(
        profileId: String? = nil,
        trackKey: String,
        durationSec: Double? = nil,
        completed: Bool? = nil,
        playedAt: Int? = nil
    ) {
        self.profileId = profileId
        self.trackKey = trackKey
        self.durationSec = durationSec
        self.completed = completed
        self.playedAt = playedAt
    }
}

public struct TrackPlay: Codable, Sendable, Hashable {
    public let id: Int
    public let profileId: String
    public let trackKey: String
    public let playedAt: Int
    public let durationSec: Double
    public let completed: Bool
    public let rev: Int?

    public init(
        id: Int,
        profileId: String,
        trackKey: String,
        playedAt: Int,
        durationSec: Double,
        completed: Bool,
        rev: Int? = nil
    ) {
        self.id = id
        self.profileId = profileId
        self.trackKey = trackKey
        self.playedAt = playedAt
        self.durationSec = durationSec
        self.completed = completed
        self.rev = rev
    }
}

public struct ProviderCatalog: Codable, Sendable, Hashable {
    public let region: String
    public let fetchedAt: Int
    public let providers: [[String: JSONValue]]

    public init(
        region: String,
        fetchedAt: Int,
        providers: [[String: JSONValue]]
    ) {
        self.region = region
        self.fetchedAt = fetchedAt
        self.providers = providers
    }
}

public struct SeasonEpisode: Codable, Sendable, Hashable {
    public let seasonNumber: Int
    public let episodeNumber: Int
    public let name: String
    public let overview: String?
    public let stillPath: String?
    public let airDate: String?
    public let runtime: Int?
    public let voteAverage: Double?
    public let files: [VersionedFile]
    public let progress: ProgressEntry?

    public init(
        seasonNumber: Int,
        episodeNumber: Int,
        name: String,
        overview: String? = nil,
        stillPath: String? = nil,
        airDate: String? = nil,
        runtime: Int? = nil,
        voteAverage: Double? = nil,
        files: [VersionedFile],
        progress: ProgressEntry? = nil
    ) {
        self.seasonNumber = seasonNumber
        self.episodeNumber = episodeNumber
        self.name = name
        self.overview = overview
        self.stillPath = stillPath
        self.airDate = airDate
        self.runtime = runtime
        self.voteAverage = voteAverage
        self.files = files
        self.progress = progress
    }
}

public struct MediaSeasonResponse: Codable, Sendable, Hashable {
    public let tmdbId: Int
    public let seasonNumber: Int
    public let name: String
    public let overview: String?
    public let posterPath: String?
    public let episodes: [SeasonEpisode]
    public let serverId: String?

    public init(
        tmdbId: Int,
        seasonNumber: Int,
        name: String,
        overview: String? = nil,
        posterPath: String? = nil,
        episodes: [SeasonEpisode],
        serverId: String? = nil
    ) {
        self.tmdbId = tmdbId
        self.seasonNumber = seasonNumber
        self.name = name
        self.overview = overview
        self.posterPath = posterPath
        self.episodes = episodes
        self.serverId = serverId
    }
}

public struct Profile: Codable, Sendable, Hashable {
    public let id: String
    public let name: String
    public let avatar: String?
    public let color: String?
    public let kind: ProfileKind
    /// Max viewer age allowed (null = unrestricted).
    public let maxAge: Int?
    public let hasPin: Bool
    public let prefs: [String: JSONValue]
    public let sort: Int
    public let createdAt: Int
    public let updatedAt: Int

    public init(
        id: String,
        name: String,
        avatar: String? = nil,
        color: String? = nil,
        kind: ProfileKind,
        maxAge: Int? = nil,
        hasPin: Bool,
        prefs: [String: JSONValue],
        sort: Int,
        createdAt: Int,
        updatedAt: Int
    ) {
        self.id = id
        self.name = name
        self.avatar = avatar
        self.color = color
        self.kind = kind
        self.maxAge = maxAge
        self.hasPin = hasPin
        self.prefs = prefs
        self.sort = sort
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

public struct ProfileInput: Codable, Sendable, Hashable {
    public let name: String?
    public let avatar: String?
    public let color: String?
    public let kind: ProfileInputKind?
    public let maxAge: Int?
    /// Set a 4-digit PIN; null clears it.
    public let pin: String?
    /// Merged into stored prefs.
    public let prefs: [String: JSONValue]?
    public let sort: Int?

    public init(
        name: String? = nil,
        avatar: String? = nil,
        color: String? = nil,
        kind: ProfileInputKind? = nil,
        maxAge: Int? = nil,
        pin: String? = nil,
        prefs: [String: JSONValue]? = nil,
        sort: Int? = nil
    ) {
        self.name = name
        self.avatar = avatar
        self.color = color
        self.kind = kind
        self.maxAge = maxAge
        self.pin = pin
        self.prefs = prefs
        self.sort = sort
    }
}

public struct WatchlistEntry: Codable, Sendable, Hashable {
    public let profileId: String
    public let kind: MediaKind
    public let tmdbId: Int
    public let addedAt: Int
    public let rev: Int?

    public init(
        profileId: String,
        kind: MediaKind,
        tmdbId: Int,
        addedAt: Int,
        rev: Int? = nil
    ) {
        self.profileId = profileId
        self.kind = kind
        self.tmdbId = tmdbId
        self.addedAt = addedAt
        self.rev = rev
    }
}

public struct HubMedia: Codable, Sendable, Hashable {
    public let fileId: String?
    public let kind: String?
    public let tmdbId: Int?
    public let season: Int?
    public let episode: Int?
    public let title: String?
    public let posterPath: String?
    public let durationSec: Double?
    public let channelId: String?

    public init(
        fileId: String? = nil,
        kind: String? = nil,
        tmdbId: Int? = nil,
        season: Int? = nil,
        episode: Int? = nil,
        title: String? = nil,
        posterPath: String? = nil,
        durationSec: Double? = nil,
        channelId: String? = nil
    ) {
        self.fileId = fileId
        self.kind = kind
        self.tmdbId = tmdbId
        self.season = season
        self.episode = episode
        self.title = title
        self.posterPath = posterPath
        self.durationSec = durationSec
        self.channelId = channelId
    }
}

public struct HubNowPlaying: Codable, Sendable, Hashable {
    public let playing: Bool
    public let positionSec: Double
    public let durationSec: Double?
    public let media: HubMedia?
    public let at: Int

    public init(
        playing: Bool,
        positionSec: Double,
        durationSec: Double? = nil,
        media: HubMedia? = nil,
        at: Int
    ) {
        self.playing = playing
        self.positionSec = positionSec
        self.durationSec = durationSec
        self.media = media
        self.at = at
    }
}

public struct HubDevice: Codable, Sendable, Hashable {
    public let deviceId: String
    public let name: String
    public let platform: String
    /// Since 3.9.0 (absent on older servers).
    public let formFactor: FormFactor?
    /// Since 3.9.0. May be offered as a "Play on" target; phones only when caps include `playback`.
    public let playbackTarget: Bool?
    public let caps: [String]
    public let profileId: String?
    public let app: String?
    public let connectedAt: Int
    public let guest: Bool
    public let nowPlaying: HubNowPlaying?

    public init(
        deviceId: String,
        name: String,
        platform: String,
        formFactor: FormFactor? = nil,
        playbackTarget: Bool? = nil,
        caps: [String],
        profileId: String? = nil,
        app: String? = nil,
        connectedAt: Int,
        guest: Bool,
        nowPlaying: HubNowPlaying? = nil
    ) {
        self.deviceId = deviceId
        self.name = name
        self.platform = platform
        self.formFactor = formFactor
        self.playbackTarget = playbackTarget
        self.caps = caps
        self.profileId = profileId
        self.app = app
        self.connectedAt = connectedAt
        self.guest = guest
        self.nowPlaying = nowPlaying
    }
}

public struct HubAck: Codable, Sendable, Hashable {
    public let ok: Bool
    public let seq: String?
    public let error: String?
    public let from: String?
    public let state: [String: JSONValue]?

    public init(
        ok: Bool,
        seq: String? = nil,
        error: String? = nil,
        from: String? = nil,
        state: [String: JSONValue]? = nil
    ) {
        self.ok = ok
        self.seq = seq
        self.error = error
        self.from = from
        self.state = state
    }
}

public struct HubRoom: Codable, Sendable, Hashable {
    public let id: String
    public let name: String
    public let phase: HubRoomPhase
    public let media: HubMedia?
    public let anchor: [String: JSONValue]
    public let hostConnId: String?
    public let members: [[String: JSONValue]]

    public init(
        id: String,
        name: String,
        phase: HubRoomPhase,
        media: HubMedia? = nil,
        anchor: [String: JSONValue],
        hostConnId: String? = nil,
        members: [[String: JSONValue]]
    ) {
        self.id = id
        self.name = name
        self.phase = phase
        self.media = media
        self.anchor = anchor
        self.hostConnId = hostConnId
        self.members = members
    }
}

public struct AlbumCard: Codable, Sendable, Hashable {
    public let id: String
    public let name: String
    public let artist: String?
    public let artistId: String?
    public let year: Int?
    public let genre: String?
    public let songCount: Int
    public let durationSec: Double
    public let coverArt: String
    /// Relative to the server origin; append the Subsonic apiKey.
    public let coverUrlPath: String

    public init(
        id: String,
        name: String,
        artist: String? = nil,
        artistId: String? = nil,
        year: Int? = nil,
        genre: String? = nil,
        songCount: Int,
        durationSec: Double,
        coverArt: String,
        coverUrlPath: String
    ) {
        self.id = id
        self.name = name
        self.artist = artist
        self.artistId = artistId
        self.year = year
        self.genre = genre
        self.songCount = songCount
        self.durationSec = durationSec
        self.coverArt = coverArt
        self.coverUrlPath = coverUrlPath
    }
}

public struct TrackCard: Codable, Sendable, Hashable {
    public let id: String
    public let title: String
    public let artist: String?
    public let artistId: String?
    public let album: String?
    public let albumId: String
    public let track: Int?
    public let disc: Int?
    public let year: Int?
    public let genre: String?
    public let durationSec: Double
    public let format: String
    public let bitrate: Int?
    public let sampleRate: Int?
    public let hasLyrics: Bool
    public let hasSyncedLyrics: Bool
    public let plays: Int?
    public let coverArt: String
    public let coverUrlPath: String
    public let streamUrlPath: String

    public init(
        id: String,
        title: String,
        artist: String? = nil,
        artistId: String? = nil,
        album: String? = nil,
        albumId: String,
        track: Int? = nil,
        disc: Int? = nil,
        year: Int? = nil,
        genre: String? = nil,
        durationSec: Double,
        format: String,
        bitrate: Int? = nil,
        sampleRate: Int? = nil,
        hasLyrics: Bool,
        hasSyncedLyrics: Bool,
        plays: Int? = nil,
        coverArt: String,
        coverUrlPath: String,
        streamUrlPath: String
    ) {
        self.id = id
        self.title = title
        self.artist = artist
        self.artistId = artistId
        self.album = album
        self.albumId = albumId
        self.track = track
        self.disc = disc
        self.year = year
        self.genre = genre
        self.durationSec = durationSec
        self.format = format
        self.bitrate = bitrate
        self.sampleRate = sampleRate
        self.hasLyrics = hasLyrics
        self.hasSyncedLyrics = hasSyncedLyrics
        self.plays = plays
        self.coverArt = coverArt
        self.coverUrlPath = coverUrlPath
        self.streamUrlPath = streamUrlPath
    }
}

public struct PlaylistCard: Codable, Sendable, Hashable {
    public let id: String
    public let name: String
    public let songCount: Int
    public let durationSec: Double
    public let coverArt: String?
    public let coverUrlPath: String?

    public init(
        id: String,
        name: String,
        songCount: Int,
        durationSec: Double,
        coverArt: String? = nil,
        coverUrlPath: String? = nil
    ) {
        self.id = id
        self.name = name
        self.songCount = songCount
        self.durationSec = durationSec
        self.coverArt = coverArt
        self.coverUrlPath = coverUrlPath
    }
}

public struct GenreCard: Codable, Sendable, Hashable {
    public let name: String
    public let songCount: Int
    public let albumCount: Int

    public init(
        name: String,
        songCount: Int,
        albumCount: Int
    ) {
        self.name = name
        self.songCount = songCount
        self.albumCount = albumCount
    }
}

public struct MusicHome: Codable, Sendable, Hashable {
    public let profileId: String
    public let recent: [AlbumCard]
    public let newest: [AlbumCard]
    public let mostPlayed: [TrackCard]
    public let playlists: [PlaylistCard]
    public let genres: [GenreCard]
    public let randomAlbums: [AlbumCard]

    public init(
        profileId: String,
        recent: [AlbumCard],
        newest: [AlbumCard],
        mostPlayed: [TrackCard],
        playlists: [PlaylistCard],
        genres: [GenreCard],
        randomAlbums: [AlbumCard]
    ) {
        self.profileId = profileId
        self.recent = recent
        self.newest = newest
        self.mostPlayed = mostPlayed
        self.playlists = playlists
        self.genres = genres
        self.randomAlbums = randomAlbums
    }
}

public struct ArtistCard: Codable, Sendable, Hashable {
    public let id: String
    public let name: String
    public let albumCount: Int
    public let songCount: Int
    public let coverArt: String
    public let coverUrlPath: String

    public init(
        id: String,
        name: String,
        albumCount: Int,
        songCount: Int,
        coverArt: String,
        coverUrlPath: String
    ) {
        self.id = id
        self.name = name
        self.albumCount = albumCount
        self.songCount = songCount
        self.coverArt = coverArt
        self.coverUrlPath = coverUrlPath
    }
}

public struct ArtistPage: Codable, Sendable, Hashable {
    public let total: Int
    public let offset: Int
    public let limit: Int
    public let items: [ArtistCard]

    public init(
        total: Int,
        offset: Int,
        limit: Int,
        items: [ArtistCard]
    ) {
        self.total = total
        self.offset = offset
        self.limit = limit
        self.items = items
    }
}

public struct ArtistDetail: Codable, Sendable, Hashable {
    public let artist: ArtistCard
    public let albums: [AlbumCard]
    public let topTracks: [TrackCard]
    public let similar: [ArtistCard]

    public init(
        artist: ArtistCard,
        albums: [AlbumCard],
        topTracks: [TrackCard],
        similar: [ArtistCard]
    ) {
        self.artist = artist
        self.albums = albums
        self.topTracks = topTracks
        self.similar = similar
    }
}

public struct AlbumDetail: Codable, Sendable, Hashable {
    public let album: AlbumCard
    public let tracks: [TrackCard]

    public init(
        album: AlbumCard,
        tracks: [TrackCard]
    ) {
        self.album = album
        self.tracks = tracks
    }
}

public struct MusicSearch: Codable, Sendable, Hashable {
    public let query: String
    public let artists: [ArtistCard]
    public let albums: [AlbumCard]
    public let tracks: [TrackCard]

    public init(
        query: String,
        artists: [ArtistCard],
        albums: [AlbumCard],
        tracks: [TrackCard]
    ) {
        self.query = query
        self.artists = artists
        self.albums = albums
        self.tracks = tracks
    }
}

public struct MusicQueue: Codable, Sendable, Hashable {
    public let profileId: String
    public let trackIds: [String]
    public let index: Int
    public let positionSec: Double
    public let shuffle: Bool
    public let `repeat`: MusicQueueRepeat
    public let updatedAt: Int

    public init(
        profileId: String,
        trackIds: [String],
        index: Int,
        positionSec: Double,
        shuffle: Bool,
        `repeat`: MusicQueueRepeat,
        updatedAt: Int
    ) {
        self.profileId = profileId
        self.trackIds = trackIds
        self.index = index
        self.positionSec = positionSec
        self.shuffle = shuffle
        self.repeat = `repeat`
        self.updatedAt = updatedAt
    }
}

public struct MusicQueueInput: Codable, Sendable, Hashable {
    public let trackIds: [String]
    public let index: Int?
    public let positionSec: Double?
    public let shuffle: Bool?
    public let `repeat`: MusicQueueInputRepeat?

    public init(
        trackIds: [String],
        index: Int? = nil,
        positionSec: Double? = nil,
        shuffle: Bool? = nil,
        `repeat`: MusicQueueInputRepeat? = nil
    ) {
        self.trackIds = trackIds
        self.index = index
        self.positionSec = positionSec
        self.shuffle = shuffle
        self.repeat = `repeat`
    }
}

public struct LyricLine: Codable, Sendable, Hashable {
    public let timeMs: Int
    public let text: String

    public init(
        timeMs: Int,
        text: String
    ) {
        self.timeMs = timeMs
        self.text = text
    }
}

public struct Lyrics: Codable, Sendable, Hashable {
    public let trackId: String
    public let synced: [LyricLine]?
    public let plain: String?
    public let source: LyricsSource

    public init(
        trackId: String,
        synced: [LyricLine]? = nil,
        plain: String? = nil,
        source: LyricsSource
    ) {
        self.trackId = trackId
        self.synced = synced
        self.plain = plain
        self.source = source
    }
}

/// Minutes per local day for the last 7 days (oldest first), from live progress writes and music plays.
public struct WeeklyUsage: Codable, Sendable, Hashable {
    public let profileId: String
    public let days: [String]
    public let watchMin: [Int]
    public let listenMin: [Int]
    public let totalWatchMin: Int
    public let totalListenMin: Int

    public init(
        profileId: String,
        days: [String],
        watchMin: [Int],
        listenMin: [Int],
        totalWatchMin: Int,
        totalListenMin: Int
    ) {
        self.profileId = profileId
        self.days = days
        self.watchMin = watchMin
        self.listenMin = listenMin
        self.totalWatchMin = totalWatchMin
        self.totalListenMin = totalListenMin
    }
}

public struct MediaStats: Codable, Sendable, Hashable {
    public let year: Int
    public let profileId: String
    public let watch: [String: JSONValue]
    public let listen: [String: JSONValue]
    public let weekly: WeeklyUsage?

    public init(
        year: Int,
        profileId: String,
        watch: [String: JSONValue],
        listen: [String: JSONValue],
        weekly: WeeklyUsage? = nil
    ) {
        self.year = year
        self.profileId = profileId
        self.watch = watch
        self.listen = listen
        self.weekly = weekly
    }
}

public struct LiveTvChannel: Codable, Sendable, Hashable {
    public let id: String
    public let sourceId: String
    public let number: String?
    public let name: String
    public let logo: String?
    public let group: String?
    public let tvgId: String?
    public let archiveDays: Int
    public let catchup: Bool
    public let hidden: Bool
    public let sort: Int?
    public let favourite: Bool

    public init(
        id: String,
        sourceId: String,
        number: String? = nil,
        name: String,
        logo: String? = nil,
        group: String? = nil,
        tvgId: String? = nil,
        archiveDays: Int,
        catchup: Bool,
        hidden: Bool,
        sort: Int? = nil,
        favourite: Bool
    ) {
        self.id = id
        self.sourceId = sourceId
        self.number = number
        self.name = name
        self.logo = logo
        self.group = group
        self.tvgId = tvgId
        self.archiveDays = archiveDays
        self.catchup = catchup
        self.hidden = hidden
        self.sort = sort
        self.favourite = favourite
    }
}

public struct LiveTvProgramme: Codable, Sendable, Hashable {
    public let channelId: String
    public let start: Int
    public let stop: Int
    public let title: String
    public let subtitle: String?
    public let description: String?
    public let category: String?
    public let episodeNum: String?
    public let icon: String?

    public init(
        channelId: String,
        start: Int,
        stop: Int,
        title: String,
        subtitle: String? = nil,
        description: String? = nil,
        category: String? = nil,
        episodeNum: String? = nil,
        icon: String? = nil
    ) {
        self.channelId = channelId
        self.start = start
        self.stop = stop
        self.title = title
        self.subtitle = subtitle
        self.description = description
        self.category = category
        self.episodeNum = episodeNum
        self.icon = icon
    }
}

public struct LiveTvRecording: Codable, Sendable, Hashable {
    public let id: String
    public let channelId: String
    public let channelName: String?
    public let title: String
    public let start: Int
    public let stop: Int
    public let paddingBeforeSec: Int?
    public let paddingAfterSec: Int?
    public let status: LiveTvRecordingStatus
    public let path: String?
    public let error: String?
    public let ruleId: String?
    public let createdAt: Int
    public let conflict: Bool

    public init(
        id: String,
        channelId: String,
        channelName: String? = nil,
        title: String,
        start: Int,
        stop: Int,
        paddingBeforeSec: Int? = nil,
        paddingAfterSec: Int? = nil,
        status: LiveTvRecordingStatus,
        path: String? = nil,
        error: String? = nil,
        ruleId: String? = nil,
        createdAt: Int,
        conflict: Bool
    ) {
        self.id = id
        self.channelId = channelId
        self.channelName = channelName
        self.title = title
        self.start = start
        self.stop = stop
        self.paddingBeforeSec = paddingBeforeSec
        self.paddingAfterSec = paddingAfterSec
        self.status = status
        self.path = path
        self.error = error
        self.ruleId = ruleId
        self.createdAt = createdAt
        self.conflict = conflict
    }
}

public struct LiveTvSource: Codable, Sendable, Hashable {
    public let id: String
    public let kind: LiveTvSourceKind
    public let name: String
    /// Credentials masked.
    public let url: String
    public let xmltvUrl: String?
    public let username: String?
    public let hasPassword: Bool
    public let enabled: Bool
    public let refreshHours: Int
    public let lastRefresh: Int?
    public let lastError: String?
    public let channelCount: Int
    public let guideRefreshedAt: Int?
    public let guideError: String?
    public let tunerLimit: Int
    public let createdAt: Int
    public let updatedAt: Int

    public init(
        id: String,
        kind: LiveTvSourceKind,
        name: String,
        url: String,
        xmltvUrl: String? = nil,
        username: String? = nil,
        hasPassword: Bool,
        enabled: Bool,
        refreshHours: Int,
        lastRefresh: Int? = nil,
        lastError: String? = nil,
        channelCount: Int,
        guideRefreshedAt: Int? = nil,
        guideError: String? = nil,
        tunerLimit: Int,
        createdAt: Int,
        updatedAt: Int
    ) {
        self.id = id
        self.kind = kind
        self.name = name
        self.url = url
        self.xmltvUrl = xmltvUrl
        self.username = username
        self.hasPassword = hasPassword
        self.enabled = enabled
        self.refreshHours = refreshHours
        self.lastRefresh = lastRefresh
        self.lastError = lastError
        self.channelCount = channelCount
        self.guideRefreshedAt = guideRefreshedAt
        self.guideError = guideError
        self.tunerLimit = tunerLimit
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

public struct APIError: Codable, Sendable, Hashable {
    public let error: String

    public init(
        error: String
    ) {
        self.error = error
    }
}

public enum AvailabilitySource: String, Codable, Sendable, CaseIterable {
    case motn
    case tmdb
    case none
    /// Any value this client does not know yet (newer server).
    case unknown

    public init(from decoder: any Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: raw) ?? .unknown
    }
}

public enum FormFactor: String, Codable, Sendable, CaseIterable {
    case tv
    case phone
    case web
    case desktop
    case unknown

    public init(from decoder: any Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: raw) ?? .unknown
    }
}

public enum HomeRowKind: String, Codable, Sendable, CaseIterable {
    case mixed
    case movie
    case tv
    /// Any value this client does not know yet (newer server).
    case unknown

    public init(from decoder: any Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: raw) ?? .unknown
    }
}

public enum HubRoomPhase: String, Codable, Sendable, CaseIterable {
    case idle
    case waiting
    case playing
    case paused
    /// Any value this client does not know yet (newer server).
    case unknown

    public init(from decoder: any Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: raw) ?? .unknown
    }
}

public enum LiveTvRecordingStatus: String, Codable, Sendable, CaseIterable {
    case scheduled
    case recording
    case done
    case failed
    case cancelled
    /// Any value this client does not know yet (newer server).
    case unknown

    public init(from decoder: any Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: raw) ?? .unknown
    }
}

public enum LiveTvSourceKind: String, Codable, Sendable, CaseIterable {
    case m3u
    case xtream
    case hdhomerun
    /// Any value this client does not know yet (newer server).
    case unknown

    public init(from decoder: any Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: raw) ?? .unknown
    }
}

public enum LyricsSource: String, Codable, Sendable, CaseIterable {
    case embedded
    case sidecar
    case lrclib
    case none
    /// Any value this client does not know yet (newer server).
    case unknown

    public init(from decoder: any Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: raw) ?? .unknown
    }
}

public enum MediaKind: String, Codable, Sendable, CaseIterable {
    case movie
    case tv
    /// Any value this client does not know yet (newer server).
    case unknown

    public init(from decoder: any Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: raw) ?? .unknown
    }
}

public enum MusicQueueInputRepeat: String, Codable, Sendable, CaseIterable {
    case off
    case all
    case one
    /// Any value this client does not know yet (newer server).
    case unknown

    public init(from decoder: any Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: raw) ?? .unknown
    }
}

public enum MusicQueueRepeat: String, Codable, Sendable, CaseIterable {
    case off
    case all
    case one
    /// Any value this client does not know yet (newer server).
    case unknown

    public init(from decoder: any Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: raw) ?? .unknown
    }
}

public enum OfferType: String, Codable, Sendable, CaseIterable {
    case subscription
    case rent
    case buy
    case free
    case ads
    /// Any value this client does not know yet (newer server).
    case unknown

    public init(from decoder: any Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: raw) ?? .unknown
    }
}

public enum PairStatus: String, Codable, Sendable, CaseIterable {
    case pending
    case approved
    case expired
    /// Any value this client does not know yet (newer server).
    case unknown

    public init(from decoder: any Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: raw) ?? .unknown
    }
}

public enum PreRemuxJobStatus: String, Codable, Sendable, CaseIterable {
    case queued
    case running
    case done
    case failed
    case skipped
    /// Any value this client does not know yet (newer server).
    case unknown

    public init(from decoder: any Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: raw) ?? .unknown
    }
}

public enum ProfileInputKind: String, Codable, Sendable, CaseIterable {
    case adult
    case kid
    /// Any value this client does not know yet (newer server).
    case unknown

    public init(from decoder: any Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: raw) ?? .unknown
    }
}

public enum ProfileKind: String, Codable, Sendable, CaseIterable {
    case adult
    case kid
    /// Any value this client does not know yet (newer server).
    case unknown

    public init(from decoder: any Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: raw) ?? .unknown
    }
}

public enum SubtitleResultProvider: String, Codable, Sendable, CaseIterable {
    case opensubtitles
    case addic7ed
    /// Any value this client does not know yet (newer server).
    case unknown

    public init(from decoder: any Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: raw) ?? .unknown
    }
}

public enum VersionInfoHdr: String, Codable, Sendable, CaseIterable {
    case dv = "DV"
    case hdr10Plus = "HDR10+"
    case hdr = "HDR"
    /// Any value this client does not know yet (newer server).
    case unknown

    public init(from decoder: any Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: raw) ?? .unknown
    }
}

public enum VersionInfoResolution: String, Codable, Sendable, CaseIterable {
    case _2160p = "2160p"
    case _1080p = "1080p"
    case _720p = "720p"
    case _480p = "480p"
    /// Any value this client does not know yet (newer server).
    case unknown

    public init(from decoder: any Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: raw) ?? .unknown
    }
}

public enum VideoFileHdr: String, Codable, Sendable, CaseIterable {
    case sdr
    case hdr10
    case hlg
    case dolby
    /// Any value this client does not know yet (newer server).
    case unknown

    public init(from decoder: any Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: raw) ?? .unknown
    }
}

public enum VideoInfoHdr: String, Codable, Sendable, CaseIterable {
    case sdr
    case hdr10
    case hlg
    case dolby
    /// Any value this client does not know yet (newer server).
    case unknown

    public init(from decoder: any Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: raw) ?? .unknown
    }
}
