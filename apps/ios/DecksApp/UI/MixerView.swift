import SwiftUI

/// Two-channel mixer: gain, 3-band EQ, filter, PFL, channel faders with VU, crossfader, master, headphone mix.
struct MixerView: View {
    @Environment(DecksStore.self) private var store

    var body: some View {
        VStack(spacing: 10) {
            HStack(alignment: .top, spacing: 14) {
                channel(0)
                VStack(spacing: 10) {
                    Knob(label: "mixer.master",
                         value: Binding(get: { Double(store.snapshot?.masterVolume ?? 1) }, set: { _ in }),
                         defaultValue: 1) { store.setMasterVolume($0) }
                    Knob(label: "mixer.headphone_mix",
                         value: Binding(get: { store.headphoneMix }, set: { _ in })) { store.setHeadphoneMix($0) }
                    VuMeter(level: store.snapshot?.masterVu ?? 0).frame(height: 90)
                        .accessibilityLabel(Text("mixer.master_vu"))
                }
                channel(1)
            }
            Fader(label: "mixer.crossfader",
                  value: Binding(get: { store.crossfaderNorm }, set: { _ in }),
                  vertical: false, tint: DecksTheme.foreground, length: 200) { store.setCrossfader($0) }
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 14).fill(DecksTheme.surface))
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text("mixer.title"))
    }

    private func channel(_ i: Int) -> some View {
        let tint = DecksTheme.deck(i)
        let d = store.deck(i)
        return VStack(spacing: 8) {
            Knob(label: "mixer.gain", value: Binding(get: { store.gainNorm(i) }, set: { _ in }), tint: tint) { store.setGain(i, $0) }
            Knob(label: "mixer.eq.high", value: Binding(get: { store.eq[i][0] }, set: { _ in }), tint: tint) { store.setEq(i, band: 0, $0) }
            Knob(label: "mixer.eq.mid", value: Binding(get: { store.eq[i][1] }, set: { _ in }), tint: tint) { store.setEq(i, band: 1, $0) }
            Knob(label: "mixer.eq.low", value: Binding(get: { store.eq[i][2] }, set: { _ in }), tint: tint) { store.setEq(i, band: 2, $0) }
            Knob(label: "mixer.filter", value: Binding(get: { store.filter[i] }, set: { _ in }), tint: tint) { store.setFilter(i, $0) }
            PadButton(title: "mixer.pfl", systemImage: "headphones", active: d?.pfl == true, tint: tint, width: 44, height: 28) {
                store.togglePfl(i)
            }
            .accessibilityLabel(Text("mixer.pfl"))
            HStack(alignment: .bottom, spacing: 4) {
                Fader(label: "mixer.volume", value: Binding(get: { Double(d?.volume ?? 1) }, set: { _ in }), tint: tint, length: 110) {
                    store.setVolume(i, $0)
                }
                VuMeter(level: d?.vu ?? 0).frame(height: 110).padding(.bottom, 18)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text(i == 0 ? LocalizedStringKey("mixer.channel.a") : LocalizedStringKey("mixer.channel.b")))
    }
}
