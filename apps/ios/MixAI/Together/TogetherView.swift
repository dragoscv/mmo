import MixaiCore
import SwiftUI
import UIKit

/// Watch Together: create / join, then the room (members, invite, synced controls, chat with moderation).
struct TogetherView: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        let t = app.together
        Group {
            if t.inRoom { TogetherRoomView() } else { TogetherLobbyView() }
        }
        .background(Theme.background)
        .navigationTitle("together.title")
        .safeAreaInset(edge: .top) {
            if t.state.kicked {
                Label("together.kicked", systemImage: "person.fill.xmark")
                    .font(Theme.body(14)).padding(10).frame(maxWidth: .infinity).background(Theme.destructive.opacity(0.25))
            }
        }
    }
}

private struct TogetherLobbyView: View {
    @Environment(AppModel.self) private var app
    @State private var name = ""
    @State private var invite = ""

    var body: some View {
        Form {
            Section {
                Text("together.intro").font(Theme.body(14)).foregroundStyle(Theme.mutedForeground)
            }
            Section("together.create") {
                TextField("together.room_name", text: $name)
                Button("together.create_action") { Task { await app.together.create(name: name) } }
                    .disabled(app.hub == nil)
            }
            Section("together.join") {
                TextField("together.invite_placeholder", text: $invite, axis: .vertical)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                Button("together.paste") { invite = UIPasteboard.general.string ?? invite }
                Button("together.join_action") { Task { await app.together.join(invite: invite) } }
                    .disabled(invite.trimmingCharacters(in: .whitespaces).isEmpty || app.hub == nil)
            }
            if let e = app.together.error {
                Section { Text(e).foregroundStyle(Theme.destructive).font(Theme.body(13)) }
            }
        }
        .scrollContentBackground(.hidden)
    }
}

private struct TogetherRoomView: View {
    @Environment(AppModel.self) private var app
    @State private var draft = ""
    @State private var reportTarget: RoomState.ChatLine?
    @State private var reportedToast = false

    var body: some View {
        let t = app.together
        let s = t.state
        List {
            Section {
                VStack(alignment: .leading, spacing: 6) {
                    Text(s.name.isEmpty ? String(localized: "together.title") : s.name).font(Theme.heading(20))
                    if let m = s.media?.title { Text("together.watching \(m)").font(Theme.body(13)).foregroundStyle(Theme.mutedForeground) }
                }
                if let inv = s.invite, let server = app.server, let url = togetherInviteURL(origin: app.origin, serverBaseURL: server.baseURL, invite: inv) {
                    HStack {
                        ShareLink(item: url) { Label("together.invite", systemImage: "square.and.arrow.up") }
                        Spacer()
                        Button { UIPasteboard.general.url = url } label: { Label("together.copy", systemImage: "doc.on.doc") }
                            .buttonStyle(.borderless)
                    }
                }
                if s.isHost {
                    Button { Task { await t.loadCurrent() } } label: { Label("together.load_now_playing", systemImage: "play.rectangle.on.rectangle") }
                }
                HStack(spacing: 14) {
                    Spacer()
                    controlButton("gobackward.10", "player.back10") { await t.localSeek(app.player.position - 10) }
                    controlButton(app.player.playing ? "pause.fill" : "play.fill", app.player.playing ? LocalizedStringKey("player.pause") : LocalizedStringKey("player.play")) {
                        if app.player.playing { await t.localPause() } else { await t.localPlay() }
                    }
                    controlButton("goforward.30", "player.fwd30") { await t.localSeek(app.player.position + 30) }
                    Spacer()
                }
                .disabled(app.player.request == nil)
                Button("together.leave", role: .destructive) { Task { await t.leave() } }
            }

            Section("together.members") {
                ForEach(s.members) { m in
                    HStack {
                        Text(m.name).font(Theme.body(15))
                        if m.connId == s.hostConnId { badge("together.host") }
                        if m.guest { badge("together.guest") }
                        if m.connId == s.me { badge("together.you") }
                        Spacer()
                        Image(systemName: m.ready ? "checkmark.circle.fill" : "circle.dotted")
                            .foregroundStyle(m.ready ? Theme.success : Theme.mutedForeground)
                            .accessibilityLabel(Text(m.ready ? LocalizedStringKey("together.ready") : LocalizedStringKey("together.not_ready")))
                    }
                    .swipeActions {
                        if m.connId != s.me {
                            if s.isHost { Button("together.kick", role: .destructive) { Task { await t.kick(m) } } }
                            if s.blockedDeviceIds.contains(m.deviceId) {
                                Button("together.unblock") { Task { await t.unblock(deviceId: m.deviceId) } }
                            } else {
                                Button("together.block") { Task { await t.block(m) } }.tint(Tokens.Dark.warning)
                            }
                        }
                    }
                }
                if !s.blockedDeviceIds.isEmpty {
                    ForEach(Array(s.blockedDeviceIds).sorted(), id: \.self) { d in
                        HStack {
                            Text("together.blocked_device").font(Theme.body(13)).foregroundStyle(Theme.mutedForeground)
                            Spacer()
                            Button("together.unblock") { Task { await t.unblock(deviceId: d) } }.buttonStyle(.borderless)
                        }
                    }
                }
            }

            Section("together.chat") {
                if s.chat.isEmpty { Text("together.chat_empty").font(Theme.body(13)).foregroundStyle(Theme.mutedForeground) }
                ForEach(s.chat) { line in
                    chatRow(line, mine: line.fromConnId == s.me)
                        .contextMenu {
                            if line.fromConnId != s.me {
                                Button { reportTarget = line } label: { Label("together.report", systemImage: "flag") }
                                    .disabled(s.reported.contains(line.id))
                                Button { Task { await t.block(connId: line.fromConnId) } } label: { Label("together.block_sender", systemImage: "hand.raised") }
                            }
                        }
                }
            }
            if let e = t.error { Section { Text(e).foregroundStyle(Theme.destructive).font(Theme.body(13)) } }
        }
        .scrollContentBackground(.hidden)
        .safeAreaInset(edge: .bottom) { composer }
        .confirmationDialog("together.report_reason", isPresented: Binding(get: { reportTarget != nil }, set: { if !$0 { reportTarget = nil } }), titleVisibility: .visible) {
            ForEach(RoomMessage.reportReasons, id: \.self) { r in
                Button(LocalizedStringKey(stringLiteral: "together.reason." + r)) {
                    if let line = reportTarget {
                        Task { await t.report(messageId: line.id, reason: r); reportedToast = true }
                    }
                    reportTarget = nil
                }
            }
        }
        .alert("together.reported", isPresented: $reportedToast) { Button("action.ok", role: .cancel) {} }
    }

    private var composer: some View {
        VStack(spacing: 8) {
            HStack(spacing: 6) {
                ForEach(TogetherModel.reactions, id: \.self) { e in
                    Button(e) { Task { await app.together.react(e) } }.font(.title3).buttonStyle(.borderless)
                }
            }
            HStack {
                TextField("together.message_placeholder", text: $draft)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit(sendDraft)
                Button(action: sendDraft) { Image(systemName: "paperplane.fill") }
                    .accessibilityLabel(Text("together.send"))
                    .disabled(draft.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .padding(12)
        .background(.bar)
    }

    private func sendDraft() {
        let text = draft
        draft = ""
        Task { await app.together.sendChat(text) }
    }

    @ViewBuilder
    private func chatRow(_ line: RoomState.ChatLine, mine: Bool) -> some View {
        VStack(alignment: mine ? .trailing : .leading, spacing: 2) {
            Text(line.name).font(Theme.body(11, weight: .semibold)).foregroundStyle(Theme.mutedForeground)
            switch line.kind {
            case .chat(let text): Text(text).font(Theme.body(15))
            case .reaction(let e): Text(e).font(.largeTitle)
            }
            if line.masked { Text("together.filtered").font(Theme.body(11)).italic().foregroundStyle(Theme.mutedForeground) }
        }
        .frame(maxWidth: .infinity, alignment: mine ? .trailing : .leading)
        .accessibilityElement(children: .combine)
    }

    private func badge(_ key: LocalizedStringKey) -> some View {
        Text(key).font(Theme.body(10, weight: .semibold)).padding(.horizontal, 6).padding(.vertical, 2).glassCard(cornerRadius: 6)
    }

    private func controlButton(_ icon: String, _ label: LocalizedStringKey, action: @escaping @MainActor @Sendable () async -> Void) -> some View {
        Button { Task { await action() } } label: { Image(systemName: icon).font(.title2).frame(width: 44, height: 44) }
            .buttonStyle(.glass)
            .accessibilityLabel(Text(label))
    }
}
