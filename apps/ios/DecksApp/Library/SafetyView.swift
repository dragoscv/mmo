import DecksFFI
import SwiftUI

/// Library safety (WP19-40): protect toggle, snapshot list and one-click restore with a confirm
/// step, as `Section`s for a `Form` (Settings or a library sheet). Takes the `DecksLibrary` handle
/// and a `onRestored` closure (the owner refreshes its views) so `LibraryStore` stays untouched.
/// Snapshots live in `<Application Support>/MixAIDecks/snapshots`; policy in docs/decks/library-safety.md.
struct SafetyView: View {
    let library: DecksLibrary?
    var onRestored: () -> Void = {}

    @State private var isProtected = false
    @State private var snapshots: [LibrarySnapshot] = []
    @State private var pending: LibrarySnapshot?
    @State private var message: String?
    @State private var failed = false
    @State private var busy = false

    private var canSnapshot: Bool { library?.canSnapshot() ?? false }

    var body: some View {
        Section {
            Toggle(isOn: Binding(get: { isProtected }, set: { setProtected($0) })) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("safety.protect")
                    Text("safety.protect_hint").font(.caption).foregroundStyle(DecksTheme.muted)
                }
            }
            .disabled(library == nil || busy)
            if let message {
                Text(verbatim: message)
                    .font(.caption)
                    .foregroundStyle(failed ? DecksTheme.danger : DecksTheme.success)
            }
        } header: {
            HStack {
                Text("safety.title")
                if isProtected { ProtectBadgeView() }
            }
        }
        Section {
            if snapshots.isEmpty {
                Text("safety.none").foregroundStyle(DecksTheme.muted)
            }
            ForEach(snapshots, id: \.id) { s in
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(verbatim: "\(Self.date(s.createdAtMs)) · ").font(.body) + Text(reasonKey(s.reason))
                        Text("safety.counts \(Int64(s.tracks)) \(Int64(s.crates)) \(Int64(s.cues))")
                            .font(.caption).foregroundStyle(DecksTheme.muted)
                    }
                    Spacer()
                    Button("safety.restore") { pending = s }
                        .disabled(busy)
                }
                .accessibilityElement(children: .combine)
            }
            if canSnapshot {
                Button("safety.snapshot_now") { snapshotNow() }.disabled(busy)
            }
        } header: {
            Text("safety.snapshots")
        }
        .confirmationDialog(
            "safety.restore_confirm",
            isPresented: Binding(get: { pending != nil }, set: { if !$0 { pending = nil } }),
            titleVisibility: .visible,
            presenting: pending
        ) { s in
            Button("safety.restore_yes", role: .destructive) { restore(s) }
            Button("common.cancel", role: .cancel) { pending = nil }
        } message: { s in
            Text(verbatim: Self.date(s.createdAtMs))
        }
        .task { reload() }
    }

    private func reasonKey(_ reason: String) -> LocalizedStringKey {
        switch reason {
        case "auto": "safety.reason.auto"
        case "manual": "safety.reason.manual"
        case "pre-restore": "safety.reason.pre_restore"
        case let r where r.hasPrefix("before-schema"): "safety.reason.schema"
        case let r where r.hasPrefix("before-import") || r.hasPrefix("before-migrate"): "safety.reason.import"
        default: LocalizedStringKey(reason)
        }
    }

    private static func date(_ ms: Int64) -> String {
        Date(timeIntervalSince1970: TimeInterval(ms) / 1000).formatted(date: .abbreviated, time: .shortened)
    }

    private func reload() {
        guard let library else { return }
        isProtected = (try? library.isProtected()) ?? false
        snapshots = (try? library.listSnapshots()) ?? []
    }

    private func report(_ error: Error) {
        failed = true
        // Every DecksError case carries one `reason` field; read it without naming the cases.
        let payload = Mirror(reflecting: error).children.first?.value
        let reason = payload.flatMap { Mirror(reflecting: $0).children.first { $0.label == "reason" }?.value as? String }
        message = reason ?? error.localizedDescription
    }

    private func setProtected(_ on: Bool) {
        guard let library else { return }
        do {
            try library.setProtected(on: on)
            message = nil
        } catch {
            report(error)
        }
        reload()
    }

    private func snapshotNow() {
        guard let library else { return }
        busy = true
        Task.detached {
            let result = Result { try library.snapshotNow(reason: "manual") }
            await MainActor.run {
                busy = false
                if case let .failure(e) = result { report(e) } else { message = nil }
                reload()
            }
        }
    }

    private func restore(_ s: LibrarySnapshot) {
        guard let library else { return }
        pending = nil
        busy = true
        Task.detached {
            let result = Result { try library.restoreSnapshot(snapshotId: s.id) }
            await MainActor.run {
                busy = false
                switch result {
                case .success:
                    failed = false
                    message = String(localized: "safety.restored")
                    onRestored()
                case let .failure(e):
                    report(e)
                }
                reload()
            }
        }
    }
}

/// "Protected" pill for the library header (renders the label with the warning token colour).
struct ProtectBadgeView: View {
    var body: some View {
        Label("safety.protected", systemImage: "lock.fill")
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 8)
            .padding(.vertical, 2)
            .foregroundStyle(DecksTheme.foreground)
            .background(DecksTheme.warning.opacity(0.18), in: Capsule())
            .overlay(Capsule().stroke(DecksTheme.warning, lineWidth: 1))
            .accessibilityLabel(Text("safety.protected"))
    }
}
