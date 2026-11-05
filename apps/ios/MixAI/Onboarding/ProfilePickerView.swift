import MixaiCore
import SwiftUI

/// "Who's watching?" grid + 4-digit PIN pad.
struct ProfilePickerView: View {
    @Environment(AppModel.self) private var app
    @State private var pinFor: Profile?
    @State private var loading = false

    private let columns = [GridItem(.adaptive(minimum: 110), spacing: 20)]

    var body: some View {
        ZStack {
            Theme.background.ignoresSafeArea()
            VStack(spacing: 28) {
                Text("profiles.who").font(Theme.heading(30)).padding(.top, 48)
                if app.profiles.isEmpty {
                    StateView(kind: .loading)
                } else {
                    ScrollView {
                        LazyVGrid(columns: columns, spacing: 24) {
                            ForEach(app.profiles, id: \.id) { p in
                                Button { pick(p) } label: {
                                    VStack(spacing: 10) {
                                        ProfileAvatar(profile: p, size: 88)
                                        Text(p.name).font(Theme.body(16, weight: .medium)).lineLimit(1)
                                        if p.kind == .kid { Text("profiles.kid").font(Theme.body(12)).foregroundStyle(Theme.mutedForeground) }
                                    }
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel(Text(p.name))
                                .accessibilityHint(Text(p.hasPin ? "profiles.pin_hint" : "profiles.open_hint"))
                            }
                        }
                        .padding(24)
                    }
                }
            }
        }
        .sheet(item: $pinFor) { p in PinPadView(profile: p).presentationDetents([.medium, .large]) }
        .task {
            if app.profiles.isEmpty, let ps = app.profileStore { app.profiles = (try? await ps.refresh()) ?? [] }
        }
    }

    private func pick(_ p: Profile) {
        if p.hasPin { pinFor = p } else { Task { await app.choose(p) } }
    }
}

extension Profile: @retroactive Identifiable {}

struct PinPadView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let profile: Profile
    @State private var pad = PinPad()
    @State private var message: String?
    @State private var busy = false

    var body: some View {
        VStack(spacing: 22) {
            ProfileAvatar(profile: profile, size: 64).padding(.top, 24)
            Text("pin.enter \(profile.name)").font(Theme.heading(20))
            HStack(spacing: 16) {
                ForEach(0..<PinPad.length, id: \.self) { i in
                    Circle().fill(i < pad.digits.count ? Theme.primary : Theme.muted).frame(width: 16, height: 16)
                }
            }
            .accessibilityElement()
            .accessibilityLabel(Text("pin.progress \(pad.digits.count)"))
            if let message { Text(message).font(Theme.body(14)).foregroundStyle(Theme.destructive) }
            LazyVGrid(columns: Array(repeating: GridItem(.fixed(76), spacing: 18), count: 3), spacing: 14) {
                ForEach(1...9, id: \.self) { key($0) }
                Color.clear.frame(width: 72, height: 72)
                key(0)
                Button { pad.backspace() } label: { Image(systemName: "delete.left").font(.title2).frame(width: 72, height: 72) }
                    .accessibilityLabel(Text("pin.delete"))
            }
            .disabled(busy)
            Spacer()
        }
        .frame(maxWidth: .infinity)
        .background(Theme.background)
    }

    private func key(_ d: Int) -> some View {
        Button {
            if let pin = pad.press(d) { submit(pin) }
        } label: {
            Text("\(d)").font(Theme.heading(28, weight: .medium)).frame(width: 72, height: 72)
        }
        .buttonStyle(.glass)
        .clipShape(.circle)
    }

    private func submit(_ pin: String) {
        busy = true
        Task {
            defer { busy = false }
            guard let ps = app.profileStore else { return }
            switch await ps.unlock(profile, pin: pin) {
            case .ok(let p):
                app.unlocked(p)
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
