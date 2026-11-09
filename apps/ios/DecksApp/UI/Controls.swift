import SwiftUI

/// Rotary knob (0…1): vertical drag, double-tap resets to `defaultValue`, VoiceOver adjustable (±5 %).
struct Knob: View {
    let label: LocalizedStringKey
    @Binding var value: Double
    var defaultValue: Double = 0.5
    var tint: Color = DecksTheme.accent
    var size: CGFloat = 38
    var onChange: (Double) -> Void = { _ in }
    @State private var start: Double?

    var body: some View {
        VStack(spacing: 3) {
            ZStack {
                Circle().fill(DecksTheme.raised)
                Circle().trim(from: 0.125, to: 0.875).stroke(DecksTheme.border, style: StrokeStyle(lineWidth: 3, lineCap: .round))
                    .rotationEffect(.degrees(90))
                Circle().trim(from: 0.125, to: 0.125 + 0.75 * value).stroke(tint, style: StrokeStyle(lineWidth: 3, lineCap: .round))
                    .rotationEffect(.degrees(90))
                Capsule().fill(DecksTheme.foreground).frame(width: 2, height: size * 0.32)
                    .offset(y: -size * 0.18)
                    .rotationEffect(.degrees(-135 + 270 * value))
            }
            .frame(width: size, height: size)
            .contentShape(Circle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { g in
                        let s = start ?? value
                        if start == nil { start = value }
                        set(s - Double(g.translation.height) / 160)
                    }
                    .onEnded { _ in start = nil }
            )
            .onTapGesture(count: 2) { set(defaultValue) }
            Text(label).font(.caption2).foregroundStyle(DecksTheme.muted).lineLimit(1)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(label))
        .accessibilityValue(Text(verbatim: "\(Int((value * 100).rounded())) %"))
        .accessibilityAdjustableAction { dir in
            switch dir {
            case .increment: set(value + 0.05)
            case .decrement: set(value - 0.05)
            @unknown default: break
            }
        }
    }

    private func set(_ v: Double) {
        let c = min(1, max(0, v))
        value = c
        onChange(c)
    }
}

/// Vertical or horizontal fader (0…1) built on Slider so it gets keyboard and VoiceOver support for free.
struct Fader: View {
    let label: LocalizedStringKey
    @Binding var value: Double
    var vertical = true
    var tint: Color = DecksTheme.accent
    var length: CGFloat = 120
    var onChange: (Double) -> Void = { _ in }

    var body: some View {
        let slider = Slider(value: Binding(get: { value }, set: { value = $0; onChange($0) }), in: 0...1)
            .tint(tint)
            .accessibilityLabel(Text(label))
        if vertical {
            VStack(spacing: 4) {
                slider
                    .frame(width: length)
                    .rotationEffect(.degrees(-90))
                    .frame(width: 32, height: length)
                Text(label).font(.caption2).foregroundStyle(DecksTheme.muted)
            }
        } else {
            VStack(spacing: 2) {
                slider.frame(width: length)
                Text(label).font(.caption2).foregroundStyle(DecksTheme.muted)
            }
        }
    }
}

/// Square pad / toggle button (play, cue, hot cue, loop, sync…).
struct PadButton: View {
    let title: LocalizedStringKey
    var systemImage: String?
    var active = false
    var tint: Color = DecksTheme.accent
    var width: CGFloat? = nil
    var height: CGFloat = 36
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            Group {
                if let systemImage {
                    Image(systemName: systemImage).font(.system(size: 15, weight: .semibold))
                } else {
                    Text(title).font(.system(size: 12, weight: .bold)).lineLimit(1).minimumScaleFactor(0.7)
                }
            }
            .frame(maxWidth: width ?? .infinity, minHeight: height)
            .frame(width: width)
            .foregroundStyle(active ? DecksTheme.accentForeground : DecksTheme.foreground)
            .background(RoundedRectangle(cornerRadius: 8).fill(active ? tint : DecksTheme.raised))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(active ? tint : DecksTheme.border, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(title))
        .accessibilityAddTraits(active ? .isSelected : [])
    }
}

/// Momentary button that reports press and release (CUE behaves like a CDJ).
struct MomentaryButton: View {
    let title: LocalizedStringKey
    var tint: Color = DecksTheme.warning
    var active = false
    var onChange: (Bool) -> Void
    @State private var down = false

    var body: some View {
        Text(title)
            .font(.system(size: 12, weight: .bold))
            .frame(maxWidth: .infinity, minHeight: 40)
            .foregroundStyle(down || active ? DecksTheme.accentForeground : DecksTheme.foreground)
            .background(RoundedRectangle(cornerRadius: 8).fill(down || active ? tint : DecksTheme.raised))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(tint, lineWidth: 1))
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { _ in if !down { down = true; onChange(true) } }
                    .onEnded { _ in down = false; onChange(false) }
            )
            .accessibilityElement()
            .accessibilityLabel(Text(title))
            .accessibilityAddTraits(.isButton)
            .accessibilityAction { onChange(true); onChange(false) }
    }
}

/// VU meter (0…1, vertical).
struct VuMeter: View {
    let level: Float
    var body: some View {
        GeometryReader { g in
            ZStack(alignment: .bottom) {
                RoundedRectangle(cornerRadius: 2).fill(DecksTheme.raised)
                RoundedRectangle(cornerRadius: 2)
                    .fill(LinearGradient(colors: [DecksTheme.success, DecksTheme.warning, DecksTheme.danger], startPoint: .bottom, endPoint: .top))
                    .frame(height: g.size.height * CGFloat(min(1, max(0, level))))
            }
        }
        .frame(width: 6)
        .accessibilityHidden(true)
    }
}
