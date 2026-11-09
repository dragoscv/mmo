import Foundation
import Observation

/// One saved reading (same JSON shape as Android `LogEntry`, dates as epoch ms).
struct LogEntry: Codable, Equatable, Identifiable, Sendable {
    enum Source: String, Codable, Sendable { case mic, file }

    var at: Date
    var camelot: String
    var keyName: String
    var bpm: Double
    var keyConfidence: Double
    var source: Source
    var title: String?
    var artist: String?
    var isrc: String?
    var artworkUrl: String?
    var appleMusicUrl: String?
    var appleMusicId: String?
    var libraryTrackId: String?
    var libraryCamelot: String?
    var libraryBpm: Double?
    var libraryPath: String?

    var id: Date { at }
    var keyIndex: Int? { Harmony.fromCamelot(camelot) }

    init(at: Date, camelot: String, keyName: String, bpm: Double, keyConfidence: Double, source: Source, title: String? = nil) {
        self.at = at; self.camelot = camelot; self.keyName = keyName; self.bpm = bpm
        self.keyConfidence = keyConfidence; self.source = source; self.title = title
    }

    func with(_ m: SongMatch) -> LogEntry {
        var e = self
        e.title = m.title; e.artist = m.artist; e.isrc = m.isrc; e.artworkUrl = m.artworkUrl
        e.appleMusicUrl = m.appleMusicUrl; e.appleMusicId = m.appleMusicId; e.libraryTrackId = m.libraryTrackId
        e.libraryCamelot = m.libraryCamelot; e.libraryBpm = m.libraryBpm; e.libraryPath = m.libraryPath
        return e
    }

    enum CodingKeys: String, CodingKey {
        case at = "atMillis", camelot, keyName, bpm, keyConfidence, source, title, artist, isrc, artworkUrl, appleMusicUrl,
             appleMusicId, libraryTrackId, libraryCamelot, libraryBpm, libraryPath
    }

    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        at = Date(timeIntervalSince1970: Double(try c.decode(Int64.self, forKey: .at)) / 1000)
        camelot = try c.decode(String.self, forKey: .camelot)
        keyName = try c.decode(String.self, forKey: .keyName)
        bpm = try c.decode(Double.self, forKey: .bpm)
        keyConfidence = try c.decodeIfPresent(Double.self, forKey: .keyConfidence) ?? 0
        source = try c.decodeIfPresent(Source.self, forKey: .source) ?? .mic
        title = try c.decodeIfPresent(String.self, forKey: .title)
        artist = try c.decodeIfPresent(String.self, forKey: .artist)
        isrc = try c.decodeIfPresent(String.self, forKey: .isrc)
        artworkUrl = try c.decodeIfPresent(String.self, forKey: .artworkUrl)
        appleMusicUrl = try c.decodeIfPresent(String.self, forKey: .appleMusicUrl)
        appleMusicId = try c.decodeIfPresent(String.self, forKey: .appleMusicId)
        libraryTrackId = try c.decodeIfPresent(String.self, forKey: .libraryTrackId)
        libraryCamelot = try c.decodeIfPresent(String.self, forKey: .libraryCamelot)
        libraryBpm = try c.decodeIfPresent(Double.self, forKey: .libraryBpm)
        libraryPath = try c.decodeIfPresent(String.self, forKey: .libraryPath)
    }

    func encode(to e: Encoder) throws {
        var c = e.container(keyedBy: CodingKeys.self)
        try c.encode(Int64((at.timeIntervalSince1970 * 1000).rounded()), forKey: .at)
        try c.encode(camelot, forKey: .camelot); try c.encode(keyName, forKey: .keyName)
        try c.encode(bpm, forKey: .bpm); try c.encode(keyConfidence, forKey: .keyConfidence); try c.encode(source, forKey: .source)
        try c.encodeIfPresent(title, forKey: .title); try c.encodeIfPresent(artist, forKey: .artist); try c.encodeIfPresent(isrc, forKey: .isrc)
        try c.encodeIfPresent(artworkUrl, forKey: .artworkUrl); try c.encodeIfPresent(appleMusicUrl, forKey: .appleMusicUrl)
        try c.encodeIfPresent(appleMusicId, forKey: .appleMusicId); try c.encodeIfPresent(libraryTrackId, forKey: .libraryTrackId)
        try c.encodeIfPresent(libraryCamelot, forKey: .libraryCamelot); try c.encodeIfPresent(libraryBpm, forKey: .libraryBpm)
        try c.encodeIfPresent(libraryPath, forKey: .libraryPath)
    }
}

/// Set log: newest first, capped at 2000, app-private JSON (port of Android `SetLog`).
@MainActor @Observable
final class SetLog {
    static let shared = SetLog()
    static let cap = 2000
    static let dedupe: TimeInterval = 600

    private(set) var entries: [LogEntry] = []
    @ObservationIgnored private let url: URL

    init(url: URL? = nil) {
        self.url = url ?? {
            let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            return dir.appendingPathComponent("setlog.json")
        }()
        entries = (try? Data(contentsOf: self.url)).flatMap { try? JSONDecoder().decode([LogEntry].self, from: $0) } ?? []
    }

    func add(_ e: LogEntry) { entries = Array(([e] + entries).prefix(Self.cap)); write() }
    func remove(at: Date) { entries.removeAll { $0.at == at }; write() }
    func clear() { entries = []; try? FileManager.default.removeItem(at: url) }

    /// Applies `change` to the entry at `at`; when it becomes a duplicate of a song logged within 10 min, the older
    /// one survives. Returns the surviving entry's time (nil when `at` is gone).
    @discardableResult
    func update(at: Date, _ change: (LogEntry) -> LogEntry) -> Date? {
        guard let i = entries.firstIndex(where: { $0.at == at }) else { return nil }
        let updated = change(entries[i])
        if let dup = entries.first(where: { $0.at != at && Self.sameSong($0, updated) && abs($0.at.timeIntervalSince(at)) <= Self.dedupe }) {
            if dup.at < at { entries.remove(at: i); write(); return dup.at }
            entries.removeAll { $0.at == dup.at }
            if let j = entries.firstIndex(where: { $0.at == at }) { entries[j] = updated }
            write()
            return at
        }
        entries[i] = updated
        write()
        return at
    }

    nonisolated static func sameSong(_ a: LogEntry, _ b: LogEntry) -> Bool {
        if let x = a.isrc, let y = b.isrc { return x.caseInsensitiveCompare(y) == .orderedSame }
        guard let ta = a.title, let tb = b.title, a.source == .mic, b.source == .mic else { return false }
        return ta.caseInsensitiveCompare(tb) == .orderedSame && (a.artist ?? "").caseInsensitiveCompare(b.artist ?? "") == .orderedSame
    }

    private func write() { try? JSONEncoder().encode(entries).write(to: url, options: .atomic) }
}

/// Set exports, oldest first (identical formats to Android `TracklistExport` / `SetLogCsv`).
enum SetExport {
    static func label(_ e: LogEntry) -> String {
        if let t = e.title, e.source == .mic { return e.artist.map { "\($0) \u{2013} \(t)" } ?? t }
        return e.title ?? "ID \u{2013} ID"
    }

    private static let posix = Locale(identifier: "en_US_POSIX")
    private static func f(_ fmt: String, _ v: Double) -> String { String(format: fmt, locale: posix, v) }

    static func csv(_ entries: [LogEntry], tz: TimeZone = .current) -> String {
        let df = DateFormatter(); df.locale = posix; df.timeZone = tz; df.dateFormat = "yyyy-MM-dd'T'HH:mm:ss"
        func q(_ s: String?) -> String { s.map { "\"" + $0.replacingOccurrences(of: "\"", with: "\"\"") + "\"" } ?? "" }
        var out = "time,camelot,key,bpm,key_confidence,source,title,artist\r\n"
        for e in entries.reversed() {
            out += [df.string(from: e.at), e.camelot, q(e.keyName), f("%.1f", e.bpm), f("%.2f", e.keyConfidence), e.source.rawValue, q(e.title), q(e.artist)]
                .joined(separator: ",") + "\r\n"
        }
        return out
    }

    static func text(_ entries: [LogEntry]) -> String {
        let list = Array(entries.reversed())
        guard let first = list.first else { return "" }
        return list.enumerated().map { i, e in
            let s = Int(e.at.timeIntervalSince(first.at))
            let off = s >= 3600 ? String(format: "%d:%02d:%02d", s / 3600, s / 60 % 60, s % 60) : String(format: "%d:%02d", s / 60, s % 60)
            return String(format: "%02d", i + 1) + ". [\(off)] \(label(e)) (\(e.camelot) \u{00B7} \(f("%.0f", e.bpm)))"
        }.joined(separator: "\n") + "\n"
    }

    static func m3u8(_ entries: [LogEntry]) -> String {
        var out = "#EXTM3U\n"
        for e in entries.reversed() {
            let name = e.title == nil ? "ID (\(e.camelot) \u{00B7} \(f("%.0f", e.bpm)) BPM)" : label(e)
            out += "#EXTINF:-1,\(name.replacingOccurrences(of: "\n", with: " "))\n\(e.libraryPath ?? "# not in library")\n"
        }
        return out
    }

    static func rekordbox(_ entries: [LogEntry], playlist: String, tz: TimeZone = .current) -> String {
        func x(_ s: String) -> String {
            s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
                .replacingOccurrences(of: ">", with: "&gt;").replacingOccurrences(of: "\"", with: "&quot;")
        }
        let df = DateFormatter(); df.locale = posix; df.timeZone = tz; df.dateFormat = "yyyy-MM-dd"
        let list = Array(entries.reversed())
        var out = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<DJ_PLAYLISTS Version=\"1.0.0\">\n"
        out += "  <PRODUCT Name=\"MixAI Key &amp; BPM\" Version=\"1\" Company=\"MixAI\"/>\n"
        out += "  <COLLECTION Entries=\"\(list.count)\">\n"
        for (i, e) in list.enumerated() {
            let loc = e.libraryPath.map { p -> String in
                let s = p.replacingOccurrences(of: "\\", with: "/").drop { $0 == "/" }
                return "file://localhost/" + s.replacingOccurrences(of: " ", with: "%20")
            } ?? ""
            out += "    <TRACK TrackID=\"\(i + 1)\" Name=\"\(x(e.title ?? "ID"))\" Artist=\"\(x(e.artist ?? ""))\" AverageBpm=\"\(f("%.2f", e.bpm))\" Tonality=\"\(x(e.camelot))\" DateAdded=\"\(df.string(from: e.at))\" Comments=\"\(x(e.keyName))\" Location=\"\(x(loc))\"/>\n"
        }
        out += "  </COLLECTION>\n  <PLAYLISTS>\n    <NODE Type=\"0\" Name=\"ROOT\" Count=\"1\">\n"
        out += "      <NODE Name=\"\(x(playlist))\" Type=\"1\" KeyType=\"0\" Entries=\"\(list.count)\">\n"
        for i in list.indices { out += "        <TRACK Key=\"\(i + 1)\"/>\n" }
        out += "      </NODE>\n    </NODE>\n  </PLAYLISTS>\n</DJ_PLAYLISTS>\n"
        return out
    }
}
