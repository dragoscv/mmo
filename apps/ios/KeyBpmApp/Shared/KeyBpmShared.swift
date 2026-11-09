import Foundation

// Shared contracts of MixAI Key & BPM on Apple platforms (WP18-05): compiled into the iPhone app, the widgets/Live
// Activity extension and the watch app. No UIKit / AppKit / KeyBpmFFI here.

/// App Group shared by the iPhone app, the widgets extension and (via WatchConnectivity copy) the watch.
enum KeyBpmGroup {
    static let id = "group.ro.mixai.keybpm"
    static var defaults: UserDefaults { UserDefaults(suiteName: id) ?? .standard }
}

/// Key notation toggle (named Notation: KeyBpmFFI exports its own KeyNotation) (Camelot "8A" / Open Key "1m" / musical "Am").
enum Notation: String, CaseIterable, Codable, Sendable {
    case camelot, openKey, musical

    func label(_ key: Int) -> String {
        switch self {
        case .camelot: Harmony.camelot(key)
        case .openKey: Harmony.openKey(key)
        case .musical: Harmony.musicalName(key)
        }
    }
}

/// Last locked reading, written by the app (and the watch on its side), read by widgets / complications / intents.
struct LastReading: Codable, Equatable, Sendable {
    var keyIndex: Int?
    var bpm: Double?
    var at: Date
    var title: String?
    var artist: String?

    static let storageKey = "keybpm.last"

    static func load(_ d: UserDefaults = KeyBpmGroup.defaults) -> LastReading? {
        d.data(forKey: storageKey).flatMap { try? JSONDecoder().decode(LastReading.self, from: $0) }
    }

    /// Saves unless nothing meaningful changed (same key, BPM within 0.5); returns true when written.
    @discardableResult
    static func save(_ r: LastReading, _ d: UserDefaults = KeyBpmGroup.defaults) -> Bool {
        if let old = load(d), old.keyIndex == r.keyIndex, old.title == r.title,
           abs((old.bpm ?? 0) - (r.bpm ?? 0)) < 0.5 { return false }
        guard let data = try? JSONEncoder().encode(r) else { return false }
        d.set(data, forKey: storageKey)
        return true
    }
}

/// Phone ↔ watch live line protocol, identical to Android `WearLink` v1 (`v1;listening;key;keyLocked;bpm;tempoLocked;
/// nextBeatMs;atMillis;title`). Carried over WatchConnectivity as `["line": String]`.
enum WearLink {
    static let lineKey = "line"
    static let kindKey = "kind"   // "live" (sendMessage) | "last" (applicationContext)

    struct Reading: Equatable, Sendable {
        var listening: Bool
        var keyIndex: Int?
        var keyLocked = false
        var bpm: Double?
        var tempoLocked = false
        var nextBeatMs: Int?
        var atMillis: Int64 = 0
        var title: String?
    }

    static func encode(_ r: Reading) -> String {
        let bpm = r.bpm.map { String(format: "%.2f", locale: Locale(identifier: "en_US_POSIX"), $0) } ?? ""
        let title = r.title.map { String($0.replacingOccurrences(of: ";", with: ",").prefix(120)) } ?? ""
        return [
            "v1", r.listening ? "1" : "0", r.keyIndex.map(String.init) ?? "", r.keyLocked ? "1" : "0", bpm,
            r.tempoLocked ? "1" : "0", r.nextBeatMs.map(String.init) ?? "", String(r.atMillis), title,
        ].joined(separator: ";")
    }

    static func decode(_ line: String) -> Reading? {
        let p = line.split(separator: ";", omittingEmptySubsequences: false).map(String.init)
        guard p.count >= 8, p[0] == "v1" else { return nil }
        let key = Int(p[2]).flatMap { (0...23).contains($0) ? $0 : nil }
        let bpm = Double(p[4]).flatMap { $0 > 0 ? $0 : nil }
        let title = p.count > 8 && !p[8].trimmingCharacters(in: .whitespaces).isEmpty ? p[8] : nil
        return Reading(listening: p[1] == "1", keyIndex: key, keyLocked: p[3] == "1", bpm: bpm, tempoLocked: p[5] == "1",
                       nextBeatMs: Int(p[6]), atMillis: Int64(p[7]) ?? 0, title: title)
    }

    /// Same throttle as Android: state changes now, BPM moves ≥ 0.3, otherwise a 2 s heartbeat; never < 500 ms apart.
    static func shouldSend(prev: Reading?, next: Reading, sinceLastMs: Int64, minGapMs: Int64 = 500, heartbeatMs: Int64 = 2000) -> Bool {
        guard let prev else { return true }
        if prev.listening != next.listening { return true }
        if sinceLastMs < minGapMs { return false }
        if prev.keyIndex != next.keyIndex || prev.keyLocked != next.keyLocked || prev.tempoLocked != next.tempoLocked { return true }
        if (prev.bpm == nil) != (next.bpm == nil) { return true }
        if let a = prev.bpm, let b = next.bpm, abs(a - b) >= 0.3 { return true }
        if prev.title != next.title { return true }
        return sinceLastMs >= heartbeatMs
    }
}
