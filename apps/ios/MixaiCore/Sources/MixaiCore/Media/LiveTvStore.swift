import Foundation

/// Where AVPlayer reads a channel from. `proxied` = through MMO Server (needs the device token header).
public struct LiveStream: Sendable, Equatable {
    public let url: String
    public let hls: Bool
    public let proxied: Bool
}

/// Live TV (`/livetv/*`). `/livetv` accepts ONLY the `x-device-token` header (no `?t=`).
public struct LiveTvStore: Sendable {
    public let client: MmoClient
    public let profile: String

    public init(client: MmoClient, profile: String) {
        self.client = client
        self.profile = profile.isEmpty ? "default" : profile
    }

    public func channels() async throws -> [LiveTvChannel] {
        try await client.get(LiveTvChannelList.self, "/livetv/channels?profile=\(MmoClient.enc(profile))").channels
    }

    public func nowNext() async throws -> [LiveTvNowNext] {
        try await client.get(LiveTvNowList.self, "/livetv/now").channels
    }

    public func setFavourite(_ id: String, _ on: Bool) async throws {
        let path = "/livetv/channels/\(MmoClient.enc(id))/favourite?profile=\(MmoClient.enc(profile))"
        if on { try await client.call("PUT", path, body: Data("{}".utf8)) } else { try await client.call("DELETE", path) }
    }

    public func proxiedURL(_ channelId: String) -> String { "\(client.baseURL)/livetv/stream/\(MmoClient.enc(channelId))?proxy=1" }

    /// Port of the TV/phone StreamResolver: HLS upstream → read the server's 302 ourselves (token header, no
    /// redirect following) and play the upstream playlist WITHOUT the token; anything else → the proxy + token.
    public func resolve(_ channelId: String) async throws -> LiveStream {
        let res = try await client.peekRedirect("/livetv/stream/\(MmoClient.enc(channelId))")
        if (300..<400).contains(res.status), let loc = res.header("Location") {
            let abs = URL(string: loc, relativeTo: URL(string: client.baseURL))?.absoluteString ?? loc
            if looksLikeHls(abs) { return LiveStream(url: abs, hls: true, proxied: false) }
        } else if !(200..<300).contains(res.status) {
            throw APIStatusError(status: res.status, body: String(res.text.prefix(200)))
        }
        return LiveStream(url: proxiedURL(channelId), hls: false, proxied: true)
    }
}

/// `.m3u8` path or `type|output|extension=m3u8|hls` query (same regex as Android).
public func looksLikeHls(_ url: String) -> Bool {
    url.range(of: #"\.m3u8($|[?#])|[?&](type|output|extension)=(m3u8|hls)"#, options: [.regularExpression, .caseInsensitive]) != nil
}
