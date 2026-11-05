import AppIntents
import Foundation
import MixaiCore

/// Intents reach the running app through this (set at boot; App Intents run in the app process).
@MainActor
enum IntentBridge {
    static weak var app: AppModel?

    static var current: AppModel { app ?? AppModel.shared }
}

/// A MixAI TV (hub device with `playbackTarget`).
struct TVEntity: AppEntity {
    static let typeDisplayRepresentation: TypeDisplayRepresentation = TypeDisplayRepresentation(name: "intent.tv.type")
    static let defaultQuery = TVQuery()

    let id: String
    let name: String

    var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: LocalizedStringResource(stringLiteral: name)) }
}

struct TVQuery: EntityQuery {
    @MainActor
    func entities(for identifiers: [String]) async throws -> [TVEntity] {
        await Self.all().filter { identifiers.contains($0.id) }
    }

    @MainActor
    func suggestedEntities() async throws -> [TVEntity] { await Self.all() }

    @MainActor
    static func all() async -> [TVEntity] {
        let app = IntentBridge.current
        _ = await app.waitUntilBooted()
        var list = app.playbackTargets
        if list.isEmpty, let phone = app.phone, let devs = try? await phone.hubDevices() {
            list = devs.filter { $0.playbackTarget == true && $0.deviceId != Prefs.deviceId }
        }
        return list.map { TVEntity(id: $0.deviceId, name: $0.name) }
    }
}

struct ResumeLastIntent: AppIntent {
    static let title: LocalizedStringResource = "intent.resume.title"
    static let description: IntentDescription? = IntentDescription("intent.resume.description")
    static let openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let app = IntentBridge.current
        guard await app.waitUntilBooted() else { return .result(dialog: "intent.no_server") }
        return await app.resumeLast() ? .result(dialog: "intent.resume.ok") : .result(dialog: "intent.resume.none")
    }
}

struct PlayOnTVIntent: AppIntent {
    static let title: LocalizedStringResource = "intent.playon.title"
    static let description: IntentDescription? = IntentDescription("intent.playon.description")

    @Parameter(title: "intent.playon.param_title")
    var title: String

    @Parameter(title: "intent.playon.param_tv")
    var tv: TVEntity

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let app = IntentBridge.current
        guard await app.waitUntilBooted(), let media = app.media, let phone = app.phone else { return .result(dialog: "intent.no_server") }
        // Library titles first (the TV can only play what is on the server), TMDB search as the source of ids.
        let results = (try? await media.search(title))?.results ?? []
        let inLibrary = results.filter { $0.inLibrary == true }
        let pool = inLibrary.isEmpty ? results : inLibrary
        guard let name = bestMatch(title, in: pool.map(\.title)), let card = pool.first(where: { $0.title == name }),
              let detail = try? await media.title(kind: card.kind, tmdbId: card.tmdbId),
              let target = await PlayResolver.resolve(detail, store: media) else {
            return .result(dialog: "intent.playon.not_found")
        }
        var args: [String: JSONValue] = [
            "fileId": .string(target.fileId), "startSec": .number(target.resumeSec ?? 0), "title": .string(detail.title.title),
            "kind": .string(target.ref.kind.rawValue), "tmdbId": .number(Double(target.ref.tmdbId)),
        ]
        if let s = target.ref.season { args["season"] = .number(Double(s)) }
        if let e = target.ref.episode { args["episode"] = .number(Double(e)) }
        let ack = try? await phone.command(target: tv.id, action: "play", args: args)
        guard ack?.ok == true else { return .result(dialog: "intent.playon.failed") }
        return .result(dialog: "intent.playon.ok \(detail.title.title) \(tv.name)")
    }
}

struct OpenLiveTVIntent: AppIntent {
    static let title: LocalizedStringResource = "intent.live.title"
    static let description: IntentDescription? = IntentDescription("intent.live.description")
    static let openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult {
        IntentBridge.current.selectedTab = 4
        return .result()
    }
}

struct MixAIShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: ResumeLastIntent(), phrases: [
            "Resume last in \(.applicationName)",
            "Continue watching in \(.applicationName)",
        ], shortTitle: "intent.resume.short", systemImageName: "play.circle")
        AppShortcut(intent: PlayOnTVIntent(), phrases: [
            "Play on TV with \(.applicationName)",
            "Play on \(\.$tv) with \(.applicationName)",
        ], shortTitle: "intent.playon.short", systemImageName: "tv")
        AppShortcut(intent: OpenLiveTVIntent(), phrases: [
            "Open Live TV in \(.applicationName)",
        ], shortTitle: "intent.live.short", systemImageName: "dot.radiowaves.left.and.right")
    }
}
