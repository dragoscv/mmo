import AppIntents
import Foundation

/// "Start listening" from Control Center, the Action button, the Lock Screen, Siri, Shortcuts and widgets. Apple
/// requires AudioRecordingIntent for any intent that starts the mic, plus a Live Activity for the whole recording
/// (ListenSession.start starts it).
struct StartListeningIntent: AudioRecordingIntent {
    static let title: LocalizedStringResource = "kb.intent.listen"
    static let description = IntentDescription("kb.intent.listen_desc")
    static let openAppWhenRun = false

    @MainActor func perform() async throws -> some IntentResult {
        await ListenSession.shared.start()
        return .result()
    }
}

struct StopListeningIntent: AppIntent {
    static let title: LocalizedStringResource = "kb.intent.stop"
    static let openAppWhenRun = false

    @MainActor func perform() async throws -> some IntentResult {
        ListenSession.shared.stop()
        return .result()
    }
}

/// Control Center toggle state + action (iOS 18+ ControlWidgetToggle needs a SetValueIntent).
struct ListeningToggleIntent: SetValueIntent, AudioRecordingIntent {
    static let title: LocalizedStringResource = "kb.intent.listen"
    @Parameter(title: "kb.intent.listening") var value: Bool

    @MainActor func perform() async throws -> some IntentResult {
        if value { await ListenSession.shared.start() } else { ListenSession.shared.stop() }
        return .result()
    }
}

/// Siri: "What key is this in MixAI?" — listens until key and tempo lock (max 30 s) and answers out loud.
struct WhatKeyIntent: AudioRecordingIntent {
    static let title: LocalizedStringResource = "kb.intent.what_key"
    static let openAppWhenRun = false

    @MainActor func perform() async throws -> some IntentResult & ProvidesDialog & ReturnsValue<String> {
        let s = ListenSession.shared
        if !s.listening { await s.start() }
        for _ in 0..<120 {
            if let r = s.reading, r.keyLocked, r.tempoLocked, let k = r.keyIndex, let b = s.bpm {
                let text = String(localized: "kb.a11y.what_key \(Harmony.longName(k)) \(Int(b.rounded()))")
                return .result(value: "\(Harmony.camelot(k)) \(Int(b.rounded()))", dialog: IntentDialog(stringLiteral: text))
            }
            try await Task.sleep(for: .milliseconds(250))
        }
        return .result(value: "", dialog: IntentDialog(stringLiteral: String(localized: "kb.intent.no_reading")))
    }
}

/// Siri: "Identify song with MixAI" — listens ~10 s and answers with title and artist (also saved to the set log).
struct IdentifySongIntent: AudioRecordingIntent {
    static let title: LocalizedStringResource = "kb.intent.identify"
    static let openAppWhenRun = false

    @MainActor func perform() async throws -> some IntentResult & ProvidesDialog & ReturnsValue<String> {
        let s = ListenSession.shared
        if !s.listening { await s.start() }
        s.identify()
        for _ in 0..<160 {
            switch s.songId {
            case .found(let m, _):
                let t = [m.title, m.artist].compactMap { $0 }.joined(separator: " \u{2014} ")
                return .result(value: t, dialog: IntentDialog(stringLiteral: t))
            case .noMatch: return .result(value: "", dialog: IntentDialog(stringLiteral: String(localized: "kb.songid.no_match")))
            case .offline: return .result(value: "", dialog: IntentDialog(stringLiteral: String(localized: "kb.songid.offline")))
            case .error(let r): return .result(value: "", dialog: IntentDialog(stringLiteral: String(localized: "kb.songid.error \(r)")))
            default: try await Task.sleep(for: .milliseconds(250))
            }
        }
        return .result(value: "", dialog: IntentDialog(stringLiteral: String(localized: "kb.songid.no_match")))
    }
}

/// Opens stage mode (booth display).
struct StageModeIntent: AppIntent {
    static let title: LocalizedStringResource = "kb.intent.stage"
    static let openAppWhenRun = true

    @MainActor func perform() async throws -> some IntentResult {
        Nav.shared.stage = true
        return .result()
    }
}

/// "Gig" Focus filter: while that Focus is on, stage mode uses night red and the app starts listening on launch.
struct GigFocusFilter: SetFocusFilterIntent {
    static let title: LocalizedStringResource = "kb.focus.title"
    static let description: IntentDescription? = IntentDescription("kb.focus.desc")

    @Parameter(title: "kb.focus.night", default: true) var night: Bool
    @Parameter(title: "kb.focus.autostart", default: true) var autostart: Bool

    var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "kb.focus.title") }

    @MainActor func perform() async throws -> some IntentResult {
        let s = ListenSession.shared
        s.prefs.stageNight = night
        KeyBpmGroup.defaults.set(autostart, forKey: "focus_autostart")
        if autostart, !s.listening { await s.start() }
        return .result()
    }
}

struct KeyBpmShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: WhatKeyIntent(), phrases: ["What key is this in \(.applicationName)", "\(.applicationName) what key"],
                    shortTitle: "kb.intent.what_key", systemImageName: "music.quarternote.3")
        AppShortcut(intent: IdentifySongIntent(), phrases: ["Identify song with \(.applicationName)", "\(.applicationName) identify"],
                    shortTitle: "kb.intent.identify", systemImageName: "shazam.logo")
        AppShortcut(intent: StartListeningIntent(), phrases: ["Start \(.applicationName)", "Listen with \(.applicationName)"],
                    shortTitle: "kb.intent.listen", systemImageName: "waveform")
        AppShortcut(intent: StageModeIntent(), phrases: ["\(.applicationName) stage mode"],
                    shortTitle: "kb.intent.stage", systemImageName: "rectangle.expand.vertical")
    }
}
