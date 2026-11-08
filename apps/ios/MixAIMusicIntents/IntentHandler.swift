import Intents

/// Siri "Play <album / artist / song> in MixAI Music" (SiriKit media). Resolution here is offline-only (no server
/// token in the extension): the spoken name travels as the media search, the app resolves it against the server.
/// `handle` returns `.handleInApp`, so iOS launches the app in the background and calls its INPlayMediaIntent handler.
final class IntentHandler: INExtension, INPlayMediaIntentHandling {
    override func handler(for intent: INIntent) -> Any { self }

    func resolveMediaItems(for intent: INPlayMediaIntent) async -> [INPlayMediaMediaItemResolutionResult] {
        let search = intent.mediaSearch
        let name = search?.mediaName ?? search?.albumName ?? search?.artistName
        let kind: INMediaItemType
        switch search?.mediaType {
        case .album: kind = .album
        case .artist: kind = .artist
        case .song: kind = .song
        default: kind = name == nil ? .music : .unknown
        }
        // "mix" = nothing specific asked; otherwise `q:<type>:<name>` for the app to search.
        let id = name.map { "q:\(kind.rawValue):\($0)" } ?? "mix"
        let item = INMediaItem(identifier: id, title: name ?? String(localized: "music.start_mix"), type: kind, artwork: nil)
        return INPlayMediaMediaItemResolutionResult.successes(with: [item])
    }

    func handle(intent: INPlayMediaIntent) async -> INPlayMediaIntentResponse {
        INPlayMediaIntentResponse(code: .handleInApp, userActivity: nil)
    }
}
