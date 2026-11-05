import Foundation

/// One subtitle cue in ABSOLUTE media seconds.
public struct SubtitleCue: Sendable, Equatable {
    public let start: Double
    public let end: Double
    public let text: String
}

/// Minimal WebVTT parser for `/video/subs/{fileId}/{n}` (ffmpeg output: `MM:SS.mmm` or `HH:MM:SS.mmm`, tags stripped).
public enum WebVTT {
    public static func parse(_ text: String) -> [SubtitleCue] {
        var cues: [SubtitleCue] = []
        let blocks = text.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n\n")
        for block in blocks {
            let lines = block.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
            guard let i = lines.firstIndex(where: { $0.contains("-->") }) else { continue }
            let parts = lines[i].components(separatedBy: "-->")
            guard parts.count == 2, let s = time(parts[0]), let e = time(parts[1].split(separator: " ").first.map(String.init) ?? "") else { continue }
            let body = lines[(i + 1)...].joined(separator: "\n").replacingOccurrences(of: #"<[^>]+>"#, with: "", options: .regularExpression)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if !body.isEmpty && e > s { cues.append(SubtitleCue(start: s, end: e, text: body)) }
        }
        return cues.sorted { $0.start < $1.start }
    }

    /// `HH:MM:SS.mmm` | `MM:SS.mmm` (comma accepted) → seconds.
    public static func time(_ raw: String) -> Double? {
        let f = raw.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: ",", with: ".").split(separator: ":")
        guard (2...3).contains(f.count) else { return nil }
        var total = 0.0
        for part in f {
            guard let v = Double(part) else { return nil }
            total = total * 60 + v
        }
        return total
    }

    /// Text of the cues active at `t` (joined), nil when none.
    public static func active(_ cues: [SubtitleCue], at t: Double) -> String? {
        var lo = 0, hi = cues.count - 1, last = -1
        while lo <= hi {
            let mid = (lo + hi) / 2
            if cues[mid].start <= t { last = mid; lo = mid + 1 } else { hi = mid - 1 }
        }
        guard last >= 0 else { return nil }
        var texts: [String] = []
        var i = last
        while i >= 0 && i > last - 8 {
            if cues[i].start <= t && t < cues[i].end { texts.insert(cues[i].text, at: 0) }
            i -= 1
        }
        return texts.isEmpty ? nil : texts.joined(separator: "\n")
    }
}

/// PGS/VobSub/DVB are bitmaps — the server cannot turn them into WebVTT.
public let bitmapSubtitleCodecs: Set<String> = ["hdmv_pgs_subtitle", "pgssub", "dvd_subtitle", "dvdsub", "dvb_subtitle", "dvbsub", "xsub"]

/// Audio track label: "EN · AAC · 5.1 (Commentary)".
public func audioLabel(lang: String?, codec: String, channels: Int, title: String?) -> String {
    let ch: String = switch channels { case 1: "1.0"; case 2: "2.0"; case 6: "5.1"; case 8: "7.1"; default: channels > 0 ? "\(channels)ch" : "" }
    let main = [lang?.uppercased(), codec.uppercased(), ch].compactMap { $0 }.filter { !$0.isEmpty && $0 != "UND" }.joined(separator: " · ")
    if let title, !title.isEmpty { return "\(main) (\(title))" }
    return main.isEmpty ? "-" : main
}

/// `1:02:03` / `4:05`.
public func formatClock(_ seconds: Double) -> String {
    let total = max(0, Int(seconds.isFinite ? seconds : 0))
    let h = total / 3600, m = (total % 3600) / 60, s = total % 60
    return h > 0 ? String(format: "%d:%02d:%02d", h, m, s) : String(format: "%d:%02d", m, s)
}
