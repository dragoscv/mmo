import Foundation

/// Lyrics → sections for the teleprompter. Section headers are lines like `[Chorus]`, `[Verse 2]` or `Chorus:`;
/// the section whose title matches the current part name is scrolled into view.
public struct LyricSection: Equatable, Sendable, Identifiable {
    public var id: Int
    public var title: String?
    public var lines: [String]
    public init(id: Int, title: String?, lines: [String]) { self.id = id; self.title = title; self.lines = lines }
}

public enum Teleprompter {
    public static func sections(_ lyrics: String?) -> [LyricSection] {
        guard let lyrics, !lyrics.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return [] }
        var out: [LyricSection] = []
        var title: String?
        var lines: [String] = []
        func flush() {
            while lines.last?.trimmingCharacters(in: .whitespaces).isEmpty == true { lines.removeLast() }
            if title != nil || !lines.isEmpty { out.append(LyricSection(id: out.count, title: title, lines: lines)) }
            lines = []
        }
        for raw in lyrics.replacingOccurrences(of: "\r\n", with: "\n").split(separator: "\n", omittingEmptySubsequences: false) {
            let line = String(raw)
            if let h = header(line) { flush(); title = h; continue }
            if lines.isEmpty && line.trimmingCharacters(in: .whitespaces).isEmpty { continue }
            lines.append(line)
        }
        flush()
        return out
    }

    static func header(_ line: String) -> String? {
        let t = line.trimmingCharacters(in: .whitespaces)
        if t.hasPrefix("["), t.hasSuffix("]"), t.count > 2 { return String(t.dropFirst().dropLast()).trimmingCharacters(in: .whitespaces) }
        if t.hasSuffix(":"), t.count > 1, t.count <= 24, !t.dropLast().contains(":") { return String(t.dropLast()).trimmingCharacters(in: .whitespaces) }
        return nil
    }

    /// Section for a part name: exact (case/diacritic-insensitive) title match, else the n-th section with a title
    /// that starts with the part's first word (`Chorus` part → first `Chorus 2` …), else nil.
    public static func section(for part: String?, in sections: [LyricSection]) -> Int? {
        guard let part, !part.isEmpty else { return nil }
        let p = fold(part)
        if let s = sections.first(where: { $0.title.map(fold) == p }) { return s.id }
        let word = p.split(separator: " ").first.map(String.init) ?? p
        return sections.first(where: { ($0.title.map(fold) ?? "").hasPrefix(word) })?.id
    }

    static func fold(_ s: String) -> String {
        s.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil).trimmingCharacters(in: .whitespaces)
    }
}
