import DecksFFI
import Foundation
import Observation

/// Music library over the Rust SQLite catalogue (`DecksLibrary`): folder scan through security-scoped
/// bookmarks, search, crates. The database lives in Application Support (inside the sandbox container).
@MainActor
@Observable
final class LibraryStore {
    private(set) var tracks: [LibraryTrack] = []
    private(set) var crates: [CrateRow] = []
    private(set) var folders: [URL] = []
    private(set) var scan: ScanStatus?
    /// Views call `refresh()` on change (no `didSet` on @Observable properties).
    var query = ""
    var selectedCrate: Int64?
    var lastError: String?

    /// The Rust catalogue handle (import, safety and grid views call the FFI on it directly).
    @ObservationIgnored private(set) var library: DecksLibrary?
    @ObservationIgnored private var scanId: UInt64?
    @ObservationIgnored private var scanQueue: [URL] = []
    @ObservationIgnored private var accessed: [URL] = []
    @ObservationIgnored private var pollTask: Task<Void, Never>?
    private static let bookmarksKey = "decks.library.bookmarks"

    init() {
        do {
            let dir = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
                .appendingPathComponent("MixAIDecks", isDirectory: true)
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            library = try DecksLibrary.open(path: dir.appendingPathComponent("decks-library").appendingPathExtension("sqlite").path)
        } catch {
            lastError = error.localizedDescription
            library = try? DecksLibrary.openInMemory()
        }
        restoreBookmarks()
        refresh()
    }

    var isScanning: Bool { scan?.state == .running || scanId != nil }

    // MARK: folders (security-scoped bookmarks)

    func addFolder(_ url: URL) {
        let ok = url.startAccessingSecurityScopedResource()
        do {
            let data = try url.bookmarkData(options: Self.bookmarkCreate, includingResourceValuesForKeys: nil, relativeTo: nil)
            var all = UserDefaults.standard.array(forKey: Self.bookmarksKey) as? [Data] ?? []
            all.append(data)
            UserDefaults.standard.set(all, forKey: Self.bookmarksKey)
        } catch {
            lastError = error.localizedDescription
        }
        if ok { accessed.append(url) }
        if !folders.contains(url) { folders.append(url) }
        enqueueScan(url)
    }

    func rescanAll() { folders.forEach(enqueueScan) }

    private static var bookmarkCreate: URL.BookmarkCreationOptions {
        #if os(macOS)
        [.withSecurityScope]
        #else
        []
        #endif
    }

    private static var bookmarkResolve: URL.BookmarkResolutionOptions {
        #if os(macOS)
        [.withSecurityScope]
        #else
        []
        #endif
    }

    private func restoreBookmarks() {
        let all = UserDefaults.standard.array(forKey: Self.bookmarksKey) as? [Data] ?? []
        var fresh: [Data] = []
        for data in all {
            var stale = false
            guard let url = try? URL(resolvingBookmarkData: data, options: Self.bookmarkResolve, relativeTo: nil, bookmarkDataIsStale: &stale) else { continue }
            if url.startAccessingSecurityScopedResource() { accessed.append(url) }
            if stale, let renewed = try? url.bookmarkData(options: Self.bookmarkCreate, includingResourceValuesForKeys: nil, relativeTo: nil) {
                fresh.append(renewed)
            } else {
                fresh.append(data)
            }
            folders.append(url)
        }
        UserDefaults.standard.set(fresh, forKey: Self.bookmarksKey)
    }

    // MARK: scan

    private func enqueueScan(_ url: URL) {
        scanQueue.append(url)
        startNextScan()
    }

    private func startNextScan() {
        guard scanId == nil, let library, !scanQueue.isEmpty else { return }
        let url = scanQueue.removeFirst()
        do {
            scanId = try library.scanFolder(folder: url.path)
            startPolling()
        } catch {
            lastError = error.localizedDescription
        }
    }

    private func startPolling() {
        guard pollTask == nil else { return }
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self, self.pollScan() else { break }
                try? await Task.sleep(for: .milliseconds(250))
            }
            self?.pollTask = nil
        }
    }

    /// Returns false when nothing is left to poll.
    private func pollScan() -> Bool {
        guard let id = scanId, let library else { return false }
        if let st = library.scanStatus(scanId: id) {
            scan = st
            if st.state != .running {
                scanId = nil
                if let e = st.error { lastError = e }
                refresh()
                startNextScan()
                return scanId != nil
            }
            if st.done % 25 == 0 { refresh() }
        }
        return true
    }

    // MARK: query

    func refresh() {
        guard let library else { return }
        do {
            crates = try library.crates()
            let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
            var list: [LibraryTrack]
            if let c = selectedCrate {
                list = try library.crateTracks(crateId: c)
                if !q.isEmpty {
                    let needle = q.lowercased()
                    list = list.filter { t in
                        [t.title, t.artist, t.album, t.genre, t.key].compactMap { $0?.lowercased() }.contains { $0.contains(needle) }
                    }
                }
            } else if q.isEmpty {
                list = try library.allTracks()
            } else {
                list = try library.search(query: q, limit: 500)
            }
            tracks = list
        } catch {
            lastError = error.localizedDescription
        }
    }

    // MARK: crates

    func createCrate(named name: String) {
        let n = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !n.isEmpty, let library else { return }
        do {
            _ = try library.createCrate(name: n, parentId: nil, isFolder: false)
            refresh()
        } catch {
            lastError = error.localizedDescription
        }
    }

    func deleteCrate(_ id: Int64) {
        guard let library else { return }
        do {
            _ = try library.deleteCrate(crateId: id)
            if selectedCrate == id { selectedCrate = nil }
            refresh()
        } catch {
            lastError = error.localizedDescription
        }
    }

    func add(_ track: LibraryTrack, toCrate id: Int64) {
        guard let library, let tid = track.id else { return }
        do {
            try library.addToCrate(crateId: id, trackId: tid)
            refresh()
        } catch {
            lastError = error.localizedDescription
        }
    }

    /// Library track id loaded on each deck (grid editor, WP19-37).
    private(set) var loadedTrackIds: [Int: String] = [:]

    func recordLoad(_ track: LibraryTrack, deck: Int) {
        guard let library, let tid = track.id else { return }
        loadedTrackIds[deck] = tid
        if session == nil { session = try? library.startSession(name: nil) }
        if let s = session { try? library.recordPlay(sessionId: s, trackId: tid, deck: UInt8(deck)) }
    }

    @ObservationIgnored private var session: Int64?
}
