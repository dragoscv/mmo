import Foundation
import Testing
@testable import MixaiCore

private func t(_ bpm: Double?, conf: Double? = nil, first: Double? = nil) -> TrackCard {
    TrackCard(id: "tr_x", title: "x", albumId: "al_\(bpm ?? 0)", durationSec: 200, format: "mp3", hasLyrics: false,
              hasSyncedLyrics: false, bpm: bpm, bpmConfidence: conf, firstBeatSec: first, coverArt: "c",
              coverUrlPath: "/c", streamUrlPath: "/s")
}

/// Same cases as Android `AutomixPlanTest`, so both apps mix alike (WP17-44).
@Suite struct AutomixTests {
    let on = AudioPrefs(crossfadeMs: 8000, normalize: false, automix: true)

    @Test func rateWithinSixPercentFoldingHalfAndDouble() {
        #expect(abs(AudioPlan.rateFor(t(128), t(124))! - Float(128.0 / 124.0)) < 1e-4)
        #expect(AudioPlan.rateFor(t(128), t(64)) == 1)
        #expect(AudioPlan.rateFor(t(87), t(174)) == 1)
        #expect(AudioPlan.rateFor(t(128), t(118)) == nil)
        #expect(AudioPlan.rateFor(t(128), t(nil)) == nil)
        #expect(AudioPlan.rateFor(t(128, conf: 0.2), t(126)) == nil)
        #expect(AudioPlan.rateFor(t(500), t(126)) == nil)
    }

    @Test func beatMatchedPlanEntersOnDownbeatAndSnapsToBars() {
        let p = AudioPlan.mixPlan(on, fadeMs: 8000, cur: t(120), next: t(122, first: 0.48))
        #expect(p.beatMatched)
        #expect(p.incomingStartMs == 480)
        #expect(abs(p.incomingRate - Float(120.0 / 122.0)) < 1e-4)
        #expect(p.fadeMs == 8000)
        #expect(AudioPlan.mixPlan(on, fadeMs: 7900, cur: t(120), next: t(120)).fadeMs == 6000)
        #expect(AudioPlan.mixPlan(on, fadeMs: 1500, cur: t(120), next: t(120)).fadeMs == 1500)
    }

    @Test func fallsBackToPlainCrossfade() {
        var off = on; off.automix = false
        let a = AudioPlan.mixPlan(off, fadeMs: 6000, cur: t(120), next: t(121, first: 1))
        #expect(!a.beatMatched && a.incomingStartMs == 0 && a.incomingRate == 1 && a.fadeMs == 6000)
        #expect(!AudioPlan.mixPlan(on, fadeMs: 6000, cur: t(120), next: t(nil, first: 1)).beatMatched)
        #expect(AudioPlan.mixPlan(on, fadeMs: 0, cur: t(120), next: t(120)).fadeMs == 0)
        #expect(AudioPlan.mixPlan(on, fadeMs: 6000, cur: t(120), next: t(120, first: 12)).incomingStartMs == 0)
    }

    @Test func fadeStartsOnOutgoingDownbeat() {
        #expect(AudioPlan.fadeStartMs(curDurMs: 200_000, cur: t(120, first: 0.5), fadeMs: 8000) == 190_500)
        #expect(AudioPlan.fadeStartMs(curDurMs: 200_000, cur: t(120), fadeMs: 8000) == 192_000)
    }

    @Test func rateGlidesBack() {
        #expect(AudioPlan.glideRate(from: 0.98, elapsedMs: 0, glideMs: 4000) == 0.98)
        #expect(abs(AudioPlan.glideRate(from: 0.98, elapsedMs: 2000, glideMs: 4000) - 0.99) < 1e-6)
        #expect(AudioPlan.glideRate(from: 0.98, elapsedMs: 5000, glideMs: 4000) == 1)
    }

    @Test func prefsDecodeOldBlobsWithAutomixOnByDefault() throws {
        let p = try JSONDecoder().decode(AudioPrefs.self, from: Data(#"{"crossfadeMs":6000,"normalize":true}"#.utf8))
        #expect(p == AudioPrefs(crossfadeMs: 6000, normalize: true, automix: true))
        let q = try JSONDecoder().decode(AudioPrefs.self, from: Data(#"{"crossfadeMs":0,"normalize":false,"automix":false}"#.utf8))
        #expect(!q.automix)
    }
}
