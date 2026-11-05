import Foundation

// Response envelopes that server/openapi.yaml declares inline (the generator does not emit them).
// Port of tv-android core `Wp16Models.kt`; fields optional/defaulted so older servers still decode.

/// `GET /media/profiles`
public struct ProfilesPage: Codable, Sendable {
    public let revision: Int?
    public let profiles: [Profile]
}

/// `POST/PATCH /media/profiles[/{id}]`
public struct ProfileEnvelope: Codable, Sendable { public let profile: Profile }

/// `POST /media/profiles/{id}/unlock` 200
public struct ProfileUnlock: Codable, Sendable {
    public let token: String
    public let expiresAt: Int
}

/// `POST /media/profiles/{id}/unlock` 401 / 429 body
public struct ProfileUnlockError: Codable, Sendable {
    public let error: String?
    public let triesLeft: Int?
    public let retryAfterMs: Int?
}

/// `GET /media/watchlist`
public struct WatchlistPage: Codable, Sendable {
    public let revision: Int?
    public let entries: [WatchlistEntry]?
    public let items: [TitleCard]?
}

/// `GET /livetv/channels`
public struct LiveTvChannelList: Codable, Sendable { public let channels: [LiveTvChannel] }

/// `GET /livetv/now` item
public struct LiveTvNowNext: Codable, Sendable, Hashable {
    public let channelId: String
    public let now: LiveTvProgramme?
    public let next: LiveTvProgramme?
}

public struct LiveTvNowList: Codable, Sendable { public let channels: [LiveTvNowNext] }

/// `/media/progress` PUT answer.
struct RevisionAnswer: Codable, Sendable { let revision: Int? }

/// `{start,end}` seconds (`/video/intro`, `/video/recap`); `{}` when unknown.
public struct MarkerSpan: Codable, Sendable, Hashable {
    public let start: Double?
    public let end: Double?
}
