import Foundation

/// Folds case + diacritics (`Școala` → `scoala`) for spoken-title matching (Siri "Play <title> on <TV>").
public func foldTitle(_ s: String) -> String {
    s.folding(options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive], locale: nil)
        .replacingOccurrences(of: #"[^\p{L}\p{N} ]"#, with: " ", options: .regularExpression)
        .split(whereSeparator: \.isWhitespace).joined(separator: " ")
}

/// Best title for a spoken query: exact fold > title starts with the query (ignoring a leading article) > every
/// query word contained. Shorter titles win ties. nil when nothing matches.
public func bestMatch(_ query: String, in titles: [String]) -> String? {
    let q = foldTitle(query)
    guard !q.isEmpty else { return nil }
    let words = q.split(separator: " ").map(String.init)
    func strip(_ t: String) -> String {
        for a in ["the ", "a ", "an "] where t.hasPrefix(a) { return String(t.dropFirst(a.count)) }
        return t
    }
    var best: (score: Int, len: Int, title: String)?
    for t in titles {
        let f = foldTitle(t)
        let score: Int
        if f == q || strip(f) == q { score = 3 }
        else if strip(f).hasPrefix(q) || f.hasPrefix(q) { score = 2 }
        else if words.allSatisfy({ f.contains($0) }) { score = 1 }
        else { continue }
        if best == nil || score > best!.score || (score == best!.score && f.count < best!.len) { best = (score, f.count, t) }
    }
    return best?.title
}
