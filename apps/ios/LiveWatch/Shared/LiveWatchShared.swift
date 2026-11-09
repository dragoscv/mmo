import Foundation
import LiveCore

/// Snapshot shared between the watch app and its complication through the App Group `group.ro.mixai.live`.
enum LiveWatchStore {
    static let group = "group.ro.mixai.live"
    static let complicationKind = "ro.mixai.live.part"
    private static let key = "liveWatchSnapshot"

    static var defaults: UserDefaults { UserDefaults(suiteName: group) ?? .standard }

    static func load() -> WatchLink.Snapshot? {
        guard let data = defaults.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(WatchLink.Snapshot.self, from: data)
    }

    /// Returns true when the stored content changed (the caller then reloads the complication).
    @discardableResult
    static func save(_ s: WatchLink.Snapshot) -> Bool {
        if let old = load(), old.sameContent(s) { return false }
        guard let data = try? JSONEncoder().encode(s) else { return false }
        defaults.set(data, forKey: key)
        return true
    }
}
