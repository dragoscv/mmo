import MixaiCore
import SwiftUI


/// "Who's watching?" row of large focusable avatars + a 4-digit PIN pad.
struct TVProfilePicker: View {
    @Environment(TVModel.self) private var model
    @State private var pinFor: Profile?

    var body: some View {
        VStack(spacing: 60) {
            Text("profiles.who").font(TVTheme.heading(64))
            if model.profiles.isEmpty {
                ProgressView()
            } else {
                HStack(spacing: 60) {
                    ForEach(model.profiles) { p in
                        Button { pick(p) } label: {
                            VStack(spacing: 18) {
                                TVAvatar(profile: p, size: 220)
                                Text(p.name).font(TVTheme.body(32, weight: .medium)).lineLimit(1)
                                if p.kind == .kid { Text("profiles.kid").font(TVTheme.body(22)).foregroundStyle(TVTheme.mutedForeground) }
                            }
                        }
                        .buttonStyle(.borderless)
                        .accessibilityLabel(Text(p.name))
                        .accessibilityHint(Text(p.hasPin ? "profiles.pin_hint" : "profiles.open_hint"))
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(TVTheme.background.ignoresSafeArea())
        .sheet(item: $pinFor) { p in TVPinPad(profile: p) }
        .task {
            if model.profiles.isEmpty, let ps = model.profileStore { model.profiles = (try? await ps.refresh()) ?? [] }
            #if DEBUG
            if let name = ProcessInfo.processInfo.environment["MIXAI_PROFILE"], let p = model.profiles.first(where: { $0.name == name }), !p.hasPin {
                await model.choose(p)
            }
            #endif
        }
    }

    private func pick(_ p: Profile) {
        if p.hasPin { pinFor = p } else { Task { await model.choose(p) } }
    }
}

struct TVAvatar: View {
    let profile: Profile?
    var size: CGFloat = 120

    var body: some View {
        let name = profile?.name ?? "?"
        ZStack {
            Circle().fill(TVTheme.brandGradient)
            Text(String(name.prefix(1)).uppercased()).font(TVTheme.heading(size * 0.45)).foregroundStyle(.white)
        }
        .frame(width: size, height: size)
        .overlay(alignment: .bottomTrailing) {
            if profile?.hasPin == true {
                Image(systemName: "lock.fill").font(.system(size: size * 0.18)).padding(size * 0.06).background(TVTheme.background, in: .circle)
            }
        }
        .accessibilityHidden(true)
    }
}

struct TVPinPad: View {
    @Environment(TVModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let profile: Profile
    @State private var pad = PinPad()
    @State private var message: String?
    @State private var busy = false

    var body: some View {
        VStack(spacing: 36) {
            TVAvatar(profile: profile, size: 120)
            Text("pin.enter \(profile.name)").font(TVTheme.heading(40))
            HStack(spacing: 24) {
                ForEach(0..<PinPad.length, id: \.self) { i in
                    Circle().fill(i < pad.digits.count ? TVTheme.primary : TVTheme.muted).frame(width: 28, height: 28)
                }
            }
            .accessibilityElement()
            .accessibilityLabel(Text("pin.progress \(pad.digits.count)"))
            if let message { Text(message).font(TVTheme.body(26)).foregroundStyle(TVTheme.destructive) }
            HStack(spacing: 18) {
                ForEach(0...9, id: \.self) { d in
                    Button { if let pin = pad.press(d) { submit(pin) } } label: {
                        Text("\(d)").font(TVTheme.heading(40, weight: .medium)).frame(width: 70, height: 70)
                    }
                }
                Button { pad.backspace() } label: { Image(systemName: "delete.left").frame(width: 70, height: 70) }
                    .accessibilityLabel(Text("pin.delete"))
            }
            .disabled(busy)
        }
        .padding(60)
    }

    private func submit(_ pin: String) {
        busy = true
        Task {
            defer { busy = false }
            guard let ps = model.profileStore else { return }
            switch await ps.unlock(profile, pin: pin) {
            case .ok(let p):
                model.unlocked(p)
                dismiss()
            case .wrongPin(let left):
                pad.clear()
                message = left.map { String(localized: "pin.wrong_left \($0)") } ?? String(localized: "pin.wrong")
            case .locked(let ms):
                pad.clear()
                message = String(localized: "pin.locked \(max(1, ms / 60_000))")
            case .failed(let m):
                pad.clear()
                message = m
            }
        }
    }
}
