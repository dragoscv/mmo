import Foundation

/// Identity of what is watched (progress key).
public struct MediaRef: Codable, Sendable, Hashable {
    public let kind: MediaKind
    public let tmdbId: Int
    public let season: Int?
    public let episode: Int?

    public init(kind: MediaKind, tmdbId: Int, season: Int? = nil, episode: Int? = nil) {
        self.kind = kind
        self.tmdbId = tmdbId
        self.season = season
        self.episode = episode
    }
}

/// What the primary button plays (port of phone `MediaUi.kt`).
public struct PlayTarget: Sendable, Hashable {
    public let fileId: String
    public let ref: MediaRef
    /// Absolute start in seconds; nil = from the beginning.
    public let resumeSec: Double?
    /// Minutes left when resuming.
    public let leftMin: Int?

    public init(fileId: String, ref: MediaRef, resumeSec: Double?, leftMin: Int?) {
        self.fileId = fileId
        self.ref = ref
        self.resumeSec = resumeSec
        self.leftMin = leftMin
    }
}

public enum PlayResolver {
    public static func isEpisode(_ f: VersionedFile) -> Bool { (f.season ?? 0) > 0 || (f.episode ?? 0) > 0 }

    public static func bestFile(_ files: [VersionedFile], preferred: String? = nil) -> VersionedFile? {
        files.first { $0.serverFileId == preferred } ?? files.max { $0.version.rank < $1.version.rank }
    }

    static func resume(_ p: ProgressEntry?) -> (Double?, Int?) {
        guard let p, !p.completed, p.positionSec > 0 else { return (nil, nil) }
        let left = p.durationSec > p.positionSec ? max(1, Int(((p.durationSec - p.positionSec) / 60).rounded())) : nil
        return (p.positionSec, left)
    }

    public static func episode(tmdbId: Int, season: Int, episode: Int, files: [VersionedFile], progress: ProgressEntry?, preferred: String? = nil) -> PlayTarget? {
        guard let f = bestFile(files, preferred: preferred) else { return nil }
        let (s, left) = resume(progress)
        return PlayTarget(fileId: f.serverFileId, ref: MediaRef(kind: .tv, tmdbId: tmdbId, season: season, episode: episode), resumeSec: s, leftMin: left)
    }

    public static func movie(_ d: MediaTitleResponse, preferred: String? = nil) -> PlayTarget? {
        let movies = d.files.filter { !isEpisode($0) }
        guard let f = bestFile(movies.isEmpty ? d.files : movies, preferred: preferred) else { return nil }
        let (s, left) = resume(d.progress.first { $0.season == 0 && $0.episode == 0 })
        return PlayTarget(fileId: f.serverFileId, ref: MediaRef(kind: d.title.kind == .unknown ? .movie : d.title.kind, tmdbId: d.title.tmdbId), resumeSec: s, leftMin: left)
    }

    /// Movies → best file; series → `nextUp`, else the earliest local episode not completed.
    public static func resolve(_ d: MediaTitleResponse, store: MediaStore, preferred: String? = nil) async -> PlayTarget? {
        guard d.title.kind == .tv else { return movie(d, preferred: preferred) }
        let id = d.title.tmdbId
        let eps = d.files.filter(isEpisode)
        if let nu = d.nextUp, nu.season > 0 {
            var files = eps.filter { $0.season == nu.season && $0.episode == nu.episode }
            if files.isEmpty {
                files = (try? await store.season(tmdbId: id, number: nu.season))?.episodes.first { $0.episodeNumber == nu.episode }?.files ?? []
            }
            if !files.isEmpty {
                let p = d.progress.first { $0.season == nu.season && $0.episode == nu.episode }
                if let t = episode(tmdbId: id, season: nu.season, episode: nu.episode, files: files, progress: p, preferred: preferred) {
                    if t.resumeSec == nil && nu.positionSec > 0 {
                        return PlayTarget(fileId: t.fileId, ref: t.ref, resumeSec: nu.positionSec, leftMin: t.leftMin)
                    }
                    return t
                }
            }
        }
        guard !eps.isEmpty else { return nil }
        let done = Set(d.progress.filter(\.completed).map { "\($0.season)x\($0.episode)" })
        let ordered = eps.sorted { ($0.season ?? 0, $0.episode ?? 0) < ($1.season ?? 0, $1.episode ?? 0) }
        guard let pick = ordered.first(where: { !done.contains("\($0.season ?? 0)x\($0.episode ?? 0)") }) ?? ordered.first else { return nil }
        let s = pick.season ?? 0, e = pick.episode ?? 0
        return episode(tmdbId: id, season: s, episode: e, files: eps.filter { $0.season == pick.season && $0.episode == pick.episode },
                       progress: d.progress.first { $0.season == s && $0.episode == e })
    }

    /// Technical chips (never localised).
    public static func formatChips(_ files: [VersionedFile]) -> [String] {
        var out: [String] = []
        if files.contains(where: { $0.version.resolution == ._2160p }) { out.append("4K") } else if files.contains(where: { $0.version.resolution == ._1080p }) { out.append("HD") }
        if files.contains(where: { $0.version.hdr == .dv }) { out.append("DV") }
        if files.contains(where: { $0.version.hdr == .hdr || $0.version.hdr == .hdr10Plus }) { out.append("HDR") }
        return out
    }

    public static func year(_ date: String?) -> String? {
        guard let d = date, d.count >= 4 else { return nil }
        let y = String(d.prefix(4))
        return y.allSatisfy(\.isNumber) ? y : nil
    }

    /// YouTube key of the best trailer (official Trailer first).
    public static func trailerKey(_ t: TitleDetails) -> String? {
        let yt = t.videos.filter { ($0["site"]?.stringValue ?? "").lowercased() == "youtube" && $0["key"]?.stringValue != nil }
        return (yt.first { $0["type"]?.stringValue == "Trailer" } ?? yt.first)?["key"]?.stringValue
    }
}
