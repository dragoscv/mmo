@preconcurrency import AVFoundation
import Foundation
import Observation
import UIKit
import WidgetKit

/// Persisted preferences (port of Android DataStore `keybpm`). Shared group defaults so widgets/intents can read them.
@MainActor @Observable
final class KeyBpmPrefs {
    @ObservationIgnored private let d = KeyBpmGroup.defaults

    var tracklistMode: Bool { didSet { d.set(tracklistMode, forKey: "tracklist_mode") } }
    var driftAlarm: Bool { didSet { d.set(driftAlarm, forKey: "drift_alarm") } }
    var announceKey: Bool { didSet { d.set(announceKey, forKey: "announce_key") } }
    var stageNight: Bool { didSet { d.set(stageNight, forKey: "stage_night") } }
    /// iOS: keep listening when the app goes to the background (owner D: off by default + Live Activity).
    var background: Bool { didSet { d.set(background, forKey: "background") } }
    var notation: Notation { didSet { d.set(notation.rawValue, forKey: "notation") } }

    init() {
        tracklistMode = d.bool(forKey: "tracklist_mode")
        driftAlarm = d.bool(forKey: "drift_alarm")
        announceKey = d.bool(forKey: "announce_key")
        stageNight = d.bool(forKey: "stage_night")
        background = d.bool(forKey: "background")
        notation = Notation(rawValue: d.string(forKey: "notation") ?? "") ?? .camelot
    }
}

/// Spoken + haptic key announcements (a11y "announce key changes", Siri "What key is this?", drift alarm buzz).
@MainActor
final class KeyAnnouncer {
    private let synth = AVSpeechSynthesizer()
    private let heavy = UINotificationFeedbackGenerator()

    func keyChanged(_ key: Int) {
        heavy.notificationOccurred(.warning)
        speak(String(localized: "a11y.key_now \(Harmony.longName(key))"))
    }

    func whatKey(_ key: Int, bpm: Double) {
        speak(String(localized: "a11y.key_now \(String(localized: "a11y.what_key \(Harmony.longName(key)) \(Int(bpm.rounded()))"))"))
    }

    func driftBuzz() { heavy.notificationOccurred(.error) }

    private func speak(_ text: String) {
        let u = AVSpeechUtterance(string: text)
        u.voice = AVSpeechSynthesisVoice(language: Locale.current.language.languageCode?.identifier == "ro" ? "ro-RO" : nil)
        synth.speak(u)
    }
}

/// Reloads the widgets / complications that show the last reading.
enum WidgetBridge {
    static func reload() { WidgetCenter.shared.reloadAllTimelines() }
}

/// iOS 27 Music Understanding (WWDC26): Apple's on-device key detection as a second opinion on files (WP18-23).
/// Compiled only with an SDK that has the framework; returns nil everywhere else.
enum AppleMusicUnderstanding {
    static func key(of url: URL) async -> Int? {
        #if canImport(MusicUnderstanding)
        if #available(iOS 27.0, *) { return await MUBridge.key(of: url) }
        #endif
        return nil
    }
}

#if canImport(MusicUnderstanding)
import MusicUnderstanding

@available(iOS 27.0, *)
private enum MUBridge {
    static func key(of url: URL) async -> Int? {
        do {
            let session = MusicUnderstandingSession(asset: AVURLAsset(url: url))
            let result = try await session.analyze(for: [.key])
            guard let ranged = result.key?.keys.max(by: { $0.timeRange.duration < $1.timeRange.duration }) else { return nil }
            let k = ranged.value
            return Harmony.index(k.tonic.pitchClass, minor: k.mode == .minor)
        } catch {
            return nil
        }
    }
}
#endif
