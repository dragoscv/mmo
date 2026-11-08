import AppIntents
import Foundation

// Compiled into the app AND the widget extension: widget / Control Center buttons resolve these by type, and
// because they are `AudioPlaybackIntent`s the system runs `perform()` in the APP process (no UI launch), where
// `MusicIntentHandler.shared` is set. In the extension the handler is nil and perform() is never called there.

/// Implemented by the app (MusicAppModel); nil inside extensions.
@MainActor
protocol MusicIntentHandling: AnyObject {
    func intentToggle() async
    func intentNext() async
    func intentPrevious() async
    func intentStartMix() async -> Bool
}

@MainActor
enum MusicIntentHandler {
    static weak var shared: MusicIntentHandling?
}

struct TogglePlaybackIntent: AudioPlaybackIntent {
    static let title: LocalizedStringResource = "intent.music.toggle"
    static let isDiscoverable = false

    init() {}

    @MainActor
    func perform() async throws -> some IntentResult {
        await MusicIntentHandler.shared?.intentToggle()
        return .result()
    }
}

struct NextTrackIntent: AudioPlaybackIntent {
    static let title: LocalizedStringResource = "intent.music.next"
    static let isDiscoverable = false

    init() {}

    @MainActor
    func perform() async throws -> some IntentResult {
        await MusicIntentHandler.shared?.intentNext()
        return .result()
    }
}

struct PreviousTrackIntent: AudioPlaybackIntent {
    static let title: LocalizedStringResource = "intent.music.previous"
    static let isDiscoverable = false

    init() {}

    @MainActor
    func perform() async throws -> some IntentResult {
        await MusicIntentHandler.shared?.intentPrevious()
        return .result()
    }
}

/// "Start a mix" from Siri, Shortcuts, Spotlight, the Action button and the idle widget.
struct StartMixIntent: AudioPlaybackIntent {
    static let title: LocalizedStringResource = "intent.music.mix"
    static let description = IntentDescription("intent.music.mix_desc")

    init() {}

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let ok = await MusicIntentHandler.shared?.intentStartMix() ?? false
        return .result(dialog: ok ? "intent.music.mix_ok" : "intent.no_server")
    }
}
