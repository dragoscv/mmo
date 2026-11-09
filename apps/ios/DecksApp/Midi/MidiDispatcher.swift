import DecksFFI
import Foundation
import Observation

/// Turns mapping-engine actions (`MappedAction`, docs/decks/mapping-format.md) into engine / library calls.
/// Values arrive already scaled by the binding (`value` 0…1 for faders/knobs, −1…1 for tempo).
@MainActor
final class MidiDispatcher {
    private let store: DecksStore
    private let library: LibraryStore
    private let browser: BrowserCursor

    init(store: DecksStore, library: LibraryStore, browser: BrowserCursor) {
        self.store = store
        self.library = library
        self.browser = browser
    }

    func handle(_ a: MappedAction) {
        let deck = Int(a.deck ?? 0)
        guard deck < DecksStore.deckCount || a.group == "library" || a.group == "clock" else { return }
        let pressed = a.pressed ?? true
        let v = Double(a.value ?? 0)
        switch (a.group, a.kind) {
        case ("deck", "play_pause"): store.togglePlay(deck)
        case ("deck", "cue"): store.cue(deck, pressed: pressed)
        case ("deck", "sync"): store.syncTap(deck)
        case ("deck", "sync_off"): if store.deck(deck)?.syncLock == true { store.toggleSyncLock(deck) }
        case ("deck", "tempo"): store.setTempoFader(deck, v)
        case ("deck", "key_lock"): store.toggleKeyLock(deck)
        case ("deck", "key_shift"): store.shiftKey(deck, by: params(a)["semitones"] as? Double ?? 0)
        case ("deck", "hot_cue"):
            if pressed, let slot = a.slot, slot < 8 { store.hotCue(deck, slot: Int(slot)) }
        case ("deck", "hot_cue_delete"):
            if let slot = a.slot { store.deleteHotCue(deck, slot: Int(slot)) }
        case ("deck", "auto_loop"):
            if let beats = params(a)["beats"] as? Double { store.loopBeats[deck] = beats }
            store.loopToggleAuto(deck)
        case ("deck", "loop_exit"): if store.deck(deck)?.loopActive == true { store.loopToggleAuto(deck) }
        case ("deck", "loop_halve"): store.loopHalve(deck)
        case ("deck", "loop_double"): store.loopDouble(deck)
        case ("deck", "loop_active_toggle"): store.loopToggleAuto(deck)
        case ("deck", "beat_jump"):
            let beats = params(a)["beats"] as? Double ?? store.jumpBeats[deck]
            store.jumpBeats[deck] = abs(beats)
            store.beatJump(deck, forward: beats >= 0)
        case ("deck", "jog_scratch"), ("deck", "jog_search"):
            store.jog(deck, delta: Double(a.delta ?? 0) * 4, touching: true)
        case ("deck", "jog_bend"):
            store.jog(deck, delta: Double(a.delta ?? 0), touching: true)
        case ("deck", "jog_touch"):
            if !pressed { store.jog(deck, delta: 0, touching: false) }
        case ("mixer", "volume"): store.setVolume(deck, v)
        case ("mixer", "trim"): store.setGain(deck, v)
        case ("mixer", "eq"):
            let band = params(a)["band"] as? String
            store.setEq(deck, band: band == "high" ? 0 : (band == "mid" ? 1 : 2), v)
        case ("mixer", "filter"): store.setFilter(deck, v)
        case ("mixer", "crossfader"): store.setCrossfader(v)
        case ("mixer", "master_volume"): store.setMasterVolume(v)
        case ("mixer", "headphone_mix"): store.setHeadphoneMix(v)
        case ("mixer", "headphone_cue"):
            let ch = (params(a)["channel"] as? Int) ?? deck
            if ch < DecksStore.deckCount { store.togglePfl(ch) }
        case ("library", "scroll"), ("library", "scroll_fast"):
            let step = Int((a.delta ?? 0).rounded()) * (a.kind == "scroll_fast" ? 10 : 1)
            browser.move(by: step, in: library.tracks)
        case ("library", "load"):
            if let t = browser.current(in: library.tracks) {
                store.load(deck: deck, path: t.path)
                library.recordLoad(t, deck: deck)
            }
        case ("library", "zoom_waveform"):
            store.zoomSeconds = min(32, max(2, store.zoomSeconds * ((a.delta ?? 0) > 0 ? 0.8 : 1.25)))
        default:
            break
        }
    }

    private func params(_ a: MappedAction) -> [String: Any] {
        guard let data = a.paramsJson.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
        var out: [String: Any] = [:]
        for (k, v) in obj {
            if let n = v as? NSNumber {
                // beats / semitones are read as Double, channel / slot as Int.
                out[k] = (k == "beats" || k == "semitones") ? n.doubleValue as Any : n.intValue as Any
            } else {
                out[k] = v
            }
        }
        return out
    }
}

/// Keyboard / controller browse cursor over the visible track list.
@MainActor
@Observable
final class BrowserCursor {
    var selection: String?

    func move(by step: Int, in tracks: [LibraryTrack]) {
        guard !tracks.isEmpty else { return }
        let idx = tracks.firstIndex { $0.rowId == selection } ?? -1
        let next = min(tracks.count - 1, max(0, idx + step))
        selection = tracks[next].rowId
    }

    func current(in tracks: [LibraryTrack]) -> LibraryTrack? {
        tracks.first { $0.rowId == selection }
    }
}
