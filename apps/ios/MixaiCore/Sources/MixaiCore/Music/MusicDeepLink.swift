import Foundation

/// Canonical `mixai-music://` link set (WP17-45). Same grammar as Android `MusicNavigator.parseLink` and the desktop
/// `links.rs`: `album/<id>`, `artist/<id>`, `now-playing` | `nowplaying`, `search[?q=]`, `downloads`, `mix`,
/// `play?ids=a,b&index=n` (ids win over q, index clamped), `play?q=` (blank = mix).
public enum MusicDeepLink: Equatable, Sendable {
    case home
    case album(String)
    case artist(String)
    case nowPlaying
    case search(String)
    case downloads
    case mix
    case playIds([String], index: Int)
    case playQuery(String)

    public static func parse(_ url: URL) -> MusicDeepLink? {
        guard url.scheme?.lowercased() == "mixai-music" else { return nil }
        let id = url.pathComponents.first { $0 != "/" && !$0.isEmpty }
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        func q(_ name: String) -> String? { items.first { $0.name == name }?.value }
        switch url.host?.lowercased() {
        case "home": return .home
        case "album": return id.map { .album($0) }
        case "artist": return id.map { .artist($0) }
        case "now-playing", "nowplaying": return .nowPlaying
        case "search": return .search(q("q")?.trimmingCharacters(in: .whitespaces) ?? "")
        case "downloads": return .downloads
        case "mix": return .mix
        case "play":
            let ids = (q("ids") ?? "").split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
                .filter { !$0.isEmpty }.prefix(500)
            if !ids.isEmpty {
                let index = min(max(Int(q("index") ?? "") ?? 0, 0), ids.count - 1)
                return .playIds(Array(ids), index: index)
            }
            let query = q("q")?.trimmingCharacters(in: .whitespaces) ?? ""
            return query.isEmpty ? .mix : .playQuery(query)
        default: return nil
        }
    }
}
