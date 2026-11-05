import Foundation

/// Stale-while-revalidate `/media/home` per profile (port of `MediaRepository.homeFlow`).
///
/// The last home per profile is kept as raw JSON on disk (`<dir>/home-<profile>.json`), so first paint needs no
/// network. Revalidation asks the cheap `/media/etag` and refetches only when `revision` or `libraryEtag` moved.
public actor HomeStore {
    public enum Update: Sendable {
        /// Disk copy (may be stale).
        case cached(MediaHome)
        /// Fresh from the server (or the cache was confirmed current: `changed == false`).
        case fresh(MediaHome, changed: Bool)
    }

    private let client: MmoClient
    private let directory: URL?
    private var memo: (profile: String, home: MediaHome)?

    public init(client: MmoClient, directory: URL?) {
        self.client = client
        self.directory = directory
    }

    public static func fileName(for profile: String) -> String {
        let safe = profile.unicodeScalars.map { u -> String in
            (u.isASCII && (CharacterSet.alphanumerics.contains(u) || u == "-" || u == "_")) ? String(u) : "_"
        }.joined()
        return "home-\(safe.isEmpty ? "default" : safe).json"
    }

    private func file(_ profile: String) -> URL? {
        directory?.appendingPathComponent(Self.fileName(for: profile))
    }

    /// Disk copy for `profile` (decoded once per profile per process).
    public func cached(profile: String) -> MediaHome? {
        if let m = memo, m.profile == profile { return m.home }
        guard let f = file(profile), let data = try? Data(contentsOf: f),
              let home = try? JSON.decoder.decode(MediaHome.self, from: data) else { return nil }
        memo = (profile, home)
        return home
    }

    /// `GET /media/home?profile=` → disk + memo.
    public func fetch(profile: String) async throws -> MediaHome {
        let data = try await client.request("GET", "/media/home?profile=\(MmoClient.enc(profile))")
        let home = try JSON.decoder.decode(MediaHome.self, from: data)
        write(profile, data)
        memo = (profile, home)
        return home
    }

    /// Cached first (when present), then fresh only when the etag moved. Errors after a cached emit are swallowed.
    public func updates(profile: String) -> AsyncThrowingStream<Update, Error> {
        AsyncThrowingStream { cont in
            let task = Task {
                let cached = self.cached(profile: profile)
                if let cached { cont.yield(.cached(cached)) }
                do {
                    if let cached {
                        let tag = try await self.client.get(MediaEtag.self, "/media/etag")
                        if tag.revision == cached.revision && tag.libraryEtag == cached.libraryEtag {
                            cont.yield(.fresh(cached, changed: false))
                            cont.finish()
                            return
                        }
                    }
                    let fresh = try await self.fetch(profile: profile)
                    cont.yield(.fresh(fresh, changed: true))
                    cont.finish()
                } catch {
                    if cached == nil { cont.finish(throwing: error) } else { cont.finish() }
                }
            }
            cont.onTermination = { _ in task.cancel() }
        }
    }

    public func invalidate() {
        memo = nil
    }

    private func write(_ profile: String, _ data: Data) {
        guard let f = file(profile) else { return }
        try? FileManager.default.createDirectory(at: f.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? data.write(to: f, options: .atomic)
    }
}

extension HomeRow {
    /// `title` is `{ro, en}`; pick by language, fall back to the other, then the id.
    public func localizedTitle(_ lang: String) -> String {
        let ro = title["ro"].flatMap(\.stringValue)
        let en = title["en"].flatMap(\.stringValue)
        return (lang.hasPrefix("ro") ? (ro ?? en) : (en ?? ro)) ?? id
    }
}

extension JSONValue {
    public var stringValue: String? { if case .string(let s) = self { return s } else { return nil } }
    public var doubleValue: Double? { if case .number(let n) = self { return n } else { return nil } }
    public var boolValue: Bool? { if case .bool(let b) = self { return b } else { return nil } }
    public subscript(_ key: String) -> JSONValue? { if case .object(let o) = self { return o[key] } else { return nil } }
}
