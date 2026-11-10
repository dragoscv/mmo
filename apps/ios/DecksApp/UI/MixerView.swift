import DecksFFI
import SwiftUI

/// Two-channel mixer at a layout tier (WP19-34). Full: gain, 3-band EQ, filter, PFL, channel faders with VU,
/// master, headphone mix. Compact: EQ + PFL + faders. Icon: PFL + faders. The crossfader is its own layout panel
/// ([CrossfaderView]); `withCrossfader` keeps it here when the layout has no crossfader area.
struct MixerView: View {
    var tier: LayoutTier = .full
    var withCrossfader = true
    @Environment(DecksStore.self) private var store

    var body: some View {
        VStack(spacing: 10) {
            HStack(alignment: .top, spacing: 14) {
                channel(0)
                VStack(spacing: 10) {
                    if tier == .full {
                        Knob(label: "mixer.master",
                             value: Binding(get: { Double(store.snapshot?.masterVolume ?? 1) }, set: { _ in }),
                             defaultValue: 1) { store.setMasterVolume($0) }
                        Knob(label: "mixer.headphone_mix",
                             value: Binding(get: { store.headphoneMix }, set: { _ in })) { store.setHeadphoneMix($0) }
                    }
                    VuMeter(level: store.snapshot?.masterVu ?? 0).frame(height: tier == .icon ? 60 : 90)
                        .accessibilityLabel(Text("mixer.master_vu"))
                }
                channel(1)
            }
            if withCrossfader {
                Fader(label: "mixer.crossfader",
                      value: Binding(get: { store.crossfaderNorm }, set: { _ in }),
                      vertical: false, tint: DecksTheme.foreground, length: tier == .full ? 200 : 120) { store.setCrossfader($0) }
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(RoundedRectangle(cornerRadius: 14).fill(DecksTheme.surface))
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text("mixer.title"))
    }

    private func channel(_ i: Int) -> some View {
        let tint = DecksTheme.deck(i)
        let d = store.deck(i)
        let faderLength: CGFloat = tier == .full ? 110 : (tier == .compact ? 80 : 56)
        return VStack(spacing: 8) {
            if tier == .full {
                Knob(label: "mixer.gain", value: Binding(get: { store.gainNorm(i) }, set: { _ in }), tint: tint) { store.setGain(i, $0) }
            }
            if tier != .icon {
                let k: CGFloat = tier == .full ? 38 : 28
                Knob(label: "mixer.eq.high", value: Binding(get: { store.eq[i][0] }, set: { _ in }), tint: tint, size: k) { store.setEq(i, band: 0, $0) }
                Knob(label: "mixer.eq.mid", value: Binding(get: { store.eq[i][1] }, set: { _ in }), tint: tint, size: k) { store.setEq(i, band: 1, $0) }
                Knob(label: "mixer.eq.low", value: Binding(get: { store.eq[i][2] }, set: { _ in }), tint: tint, size: k) { store.setEq(i, band: 2, $0) }
            }
            if tier == .full {
                Knob(label: "mixer.filter", value: Binding(get: { store.filter[i] }, set: { _ in }), tint: tint) { store.setFilter(i, $0) }
            }
            PadButton(title: "mixer.pfl", systemImage: "headphones", active: d?.pfl == true, tint: tint, width: 44, height: 28) {
                store.togglePfl(i)
            }
            .accessibilityLabel(Text("mixer.pfl"))
            HStack(alignment: .bottom, spacing: 4) {
                Fader(label: "mixer.volume", value: Binding(get: { Double(d?.volume ?? 1) }, set: { _ in }), tint: tint, length: faderLength) {
                    store.setVolume(i, $0)
                }
                VuMeter(level: d?.vu ?? 0).frame(height: faderLength).padding(.bottom, 18)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text(i == 0 ? LocalizedStringKey("mixer.channel.a") : LocalizedStringKey("mixer.channel.b")))
    }
}

/// The crossfader as its own layout panel (WP19-34).
struct CrossfaderView: View {
    var tier: LayoutTier = .full
    @Environment(DecksStore.self) private var store

    var body: some View {
        GeometryReader { g in
            Fader(label: "mixer.crossfader",
                  value: Binding(get: { store.crossfaderNorm }, set: { _ in }),
                  vertical: false, tint: DecksTheme.foreground, length: max(80, g.size.width - 24)) { store.setCrossfader($0) }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .padding(tier == .icon ? 4 : 10)
        .background(RoundedRectangle(cornerRadius: 14).fill(DecksTheme.surface))
    }
}
