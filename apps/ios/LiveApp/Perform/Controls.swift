import LiveCore
import SwiftUI
import UIKit

/// PANIC: hold for 0.8 s to fire (mute + reset tails), so a stray touch on stage cannot cut the show.
struct PanicButton: View {
    let enabled: Bool
    let action: () -> Void
    @State private var holding = false

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 14, style: .continuous).fill(LiveTheme.danger.opacity(enabled ? 1 : 0.35))
            GeometryReader { g in
                RoundedRectangle(cornerRadius: 14, style: .continuous).fill(LiveTheme.dangerForeground.opacity(0.25))
                    .frame(width: holding ? g.size.width : 0)
                    .animation(holding ? .linear(duration: 0.8) : .easeOut(duration: 0.15), value: holding)
            }
            VStack(spacing: 2) {
                Text("live.perform.panic").font(.headline.weight(.heavy))
                Text("live.perform.panic_hold").font(.caption2)
            }
            .foregroundStyle(LiveTheme.dangerForeground)
        }
        .frame(minHeight: 56)
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .onLongPressGesture(minimumDuration: 0.8, perform: {
            holding = false
            UINotificationFeedbackGenerator().notificationOccurred(.warning)
            action()
        }, onPressingChanged: { holding = $0 && enabled })
        .disabled(!enabled)
        .accessibilityElement()
        .accessibilityLabel(Text("live.perform.panic"))
        .accessibilityHint(Text("live.perform.panic_hint"))
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { action() }
    }
}

/// Square toggle (MUTE / BYPASS) that shows the engine state.
struct StateToggle: View {
    let title: LocalizedStringKey
    let systemImage: String
    let on: Bool
    let tint: Color
    let enabled: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 4) {
                Image(systemName: systemImage).font(.title3)
                Text(title).font(.caption.weight(.bold))
            }
            .frame(maxWidth: .infinity, minHeight: 56)
            .foregroundStyle(on ? LiveTheme.background : LiveTheme.foreground)
            .background(on ? tint : LiveTheme.raised, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.4)
        .accessibilityLabel(Text(title))
        .accessibilityValue(Text(LocalizedStringKey(on ? "live.common.on" : "live.common.off")))
    }
}

/// Large transport-style button (prev / next / tap).
struct PadButton: View {
    let title: LocalizedStringKey
    let systemImage: String
    let enabled: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 4) {
                Image(systemName: systemImage).font(.title2)
                Text(title).font(.caption.weight(.semibold))
            }
            .frame(maxWidth: .infinity, minHeight: 64)
            .foregroundStyle(LiveTheme.foreground)
            .background(LiveTheme.raised, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.4)
        .accessibilityLabel(Text(title))
    }
}

/// Labelled slider that shows the engine value until the user drags, then sends throttled changes.
struct LiveSlider: View {
    let title: LocalizedStringKey
    let value: Float
    let range: ClosedRange<Float>
    let step: Float
    let format: (Float) -> String
    let enabled: Bool
    let onChange: (Float) -> Void

    @State private var local: Float?

    var body: some View {
        let shown = local ?? value
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text(title).font(.subheadline)
                Spacer()
                Text(verbatim: format(shown)).font(.subheadline.monospacedDigit()).foregroundStyle(LiveTheme.muted)
            }
            Slider(value: Binding(get: { Double(shown) }, set: { v in
                let f = (Float(v) / step).rounded() * step
                local = f
                onChange(f)
            }), in: Double(range.lowerBound)...Double(range.upperBound), onEditingChanged: { editing in
                if !editing { local = nil }
            })
            .disabled(!enabled)
            .accessibilityLabel(Text(title))
            .accessibilityValue(Text(verbatim: format(shown)))
        }
    }
}
