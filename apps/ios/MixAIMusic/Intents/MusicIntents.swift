import AppIntents
import MixaiCore
import MixaiUI

/// An album or artist on the server, for "Play <album> in MixAI Music" (Siri / Shortcuts / Spotlight).
struct MusicItemEntity: AppEntity {
    static let typeDisplayRepresentation: TypeDisplayRepresentation = "intent.music.item"
    static let defaultQuery = MusicItemQuery()

    enum Kind: String, Codable, Sendable { case album, artist }

    let id: String
    let kind: Kind
    let name: String
    let subtitle: String?

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(name)", subtitle: subtitle.map { "\($0)" })
    }
}

struct MusicItemQuery: EntityStringQuery {
    init() {}

    @MainActor
    func entities(matching string: String) async throws -> [MusicItemEntity] {
        let app = MusicAppModel.shared
        guard await app.waitUntilBooted(), let store = app.env.store, let r = try? await store.search(string) else { return [] }
        return r.albums.prefix(8).map { MusicItemEntity(id: $0.id, kind: .album, name: $0.name, subtitle: $0.artist) }
            + r.artists.prefix(5).map { MusicItemEntity(id: $0.id, kind: .artist, name: $0.name, subtitle: nil) }
    }

    @MainActor
    func entities(for identifiers: [String]) async throws -> [MusicItemEntity] {
        let app = MusicAppModel.shared
        guard await app.waitUntilBooted(), let store = app.env.store else { return [] }
        var out: [MusicItemEntity] = []
        for id in identifiers {
            if id.hasPrefix("al_"), let a = try? await store.album(id) {
                out.append(MusicItemEntity(id: id, kind: .album, name: a.album.name, subtitle: a.album.artist))
            } else if id.hasPrefix("ar_"), let a = try? await store.artist(id) {
                out.append(MusicItemEntity(id: id, kind: .artist, name: a.artist.name, subtitle: nil))
            }
        }
        return out
    }

    @MainActor
    func suggestedEntities() async throws -> [MusicItemEntity] {
        let app = MusicAppModel.shared
        guard await app.waitUntilBooted(), let store = app.env.store, let h = try? await store.home() else { return [] }
        return h.recent.prefix(8).map { MusicItemEntity(id: $0.id, kind: .album, name: $0.name, subtitle: $0.artist) }
    }
}

/// Plays an album in order, or an artist radio.
struct PlayMusicItemIntent: AudioPlaybackIntent {
    static let title: LocalizedStringResource = "intent.music.play_item"

    @Parameter(title: "intent.music.item")
    var item: MusicItemEntity

    init() {}
    init(item: MusicItemEntity) { self.item = item }

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let app = MusicAppModel.shared
        guard await app.waitUntilBooted(), let store = app.env.store else { return .result(dialog: "intent.no_server") }
        switch item.kind {
        case .album:
            guard let d = try? await store.album(item.id), !d.tracks.isEmpty else { return .result(dialog: "intent.music.not_found") }
            app.player.play(d.tracks, at: 0, store: store)
        case .artist:
            await app.player.startMix(seed: item.id, store: store)
        }
        return .result(dialog: "intent.music.playing \(item.name)")
    }
}

struct MusicShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: StartMixIntent(), phrases: [
            "Start a mix in \(.applicationName)",
            "Play my music in \(.applicationName)",
        ], shortTitle: "intent.music.mix", systemImageName: "sparkles")
        AppShortcut(intent: PlayMusicItemIntent(), phrases: [
            "Play \(\.$item) in \(.applicationName)",
        ], shortTitle: "intent.music.play_item", systemImageName: "play.circle")
    }
}

extension MusicAppModel: MusicIntentHandling {
    func intentToggle() async {
        if player.current == nil { _ = await waitUntilBooted() }
        player.toggle()
    }

    func intentNext() async { player.next() }

    func intentPrevious() async { player.previous() }

    func intentStartMix() async -> Bool {
        guard await waitUntilBooted(), let store = env.store else { return false }
        await player.startMix(store: store)
        return player.current != nil
    }
}
