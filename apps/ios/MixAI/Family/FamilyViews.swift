import Charts
import MixaiCore
import SwiftUI

/// Settings section for a kid profile: today vs daily cap + 7-day chart.
struct KidsCapView: View {
    @Environment(AppModel.self) private var app
    @State private var usage: ProfileUsage?
    @State private var failed = false

    var body: some View {
        Section("family.today") {
            if let u = usage {
                LabeledContent("family.watched", value: String(localized: "family.minutes \(u.watchMin)"))
                LabeledContent("family.listened", value: String(localized: "family.minutes \(u.listenMin)"))
                if let cap = u.dailyCapMin {
                    LabeledContent("family.cap", value: String(localized: "family.minutes \(cap)"))
                    LabeledContent("family.remaining", value: String(localized: "family.minutes \(u.remainingMin ?? 0)"))
                    if u.overCap { Label("family.over_cap", systemImage: "hourglass.bottomhalf.filled").foregroundStyle(Theme.destructive) }
                } else {
                    Text("family.no_cap").font(Theme.body(13)).foregroundStyle(Theme.mutedForeground)
                }
                if let w = u.week, !w.days.isEmpty {
                    WeekChart(days: w.days, watch: w.watchMin, listen: w.listenMin, cap: u.dailyCapMin).frame(height: 160)
                }
            } else if failed {
                Text("family.unavailable").font(Theme.body(13)).foregroundStyle(Theme.mutedForeground)
            } else {
                ProgressView()
            }
        }
        .task(id: app.profileId) {
            failed = false
            usage = try? await app.phone?.usage(profileId: app.profileId)
            failed = usage == nil
        }
    }
}

/// Stacked watch/listen minutes per day, optional cap rule.
struct WeekChart: View {
    let days: [String]
    let watch: [Int]
    let listen: [Int]
    var cap: Int?

    var body: some View {
        Chart {
            ForEach(Array(days.enumerated()), id: \.offset) { i, d in
                BarMark(x: .value("day", Self.short(d)), y: .value("min", watch.indices.contains(i) ? watch[i] : 0))
                    .foregroundStyle(by: .value("kind", String(localized: "family.watch")))
                BarMark(x: .value("day", Self.short(d)), y: .value("min", listen.indices.contains(i) ? listen[i] : 0))
                    .foregroundStyle(by: .value("kind", String(localized: "family.listen")))
            }
            if let cap {
                RuleMark(y: .value("cap", cap)).foregroundStyle(Theme.destructive).lineStyle(StrokeStyle(lineWidth: 1, dash: [4, 3]))
            }
        }
        .chartForegroundStyleScale([String(localized: "family.watch"): Theme.primary, String(localized: "family.listen"): Tokens.Dark.warning])
    }

    /// `2026-11-05` → `05.11`.
    static func short(_ day: String) -> String {
        let p = day.split(separator: "-")
        return p.count == 3 ? "\(p[2]).\(p[1])" : day
    }
}

/// Adults: weekly minutes per profile + today vs cap.
struct FamilyStatsView: View {
    @Environment(AppModel.self) private var app
    @State private var stats: FamilyStats?
    @State private var error: String?

    var body: some View {
        Group {
            if let s = stats {
                List {
                    Section("family.week") {
                        Chart(s.profiles) { r in
                            BarMark(x: .value("min", r.weeklyWatchMin + r.weeklyListenMin), y: .value("profile", r.name))
                                .foregroundStyle(r.overCap ? Theme.destructive : Theme.primary)
                        }
                        .frame(height: CGFloat(max(1, s.profiles.count)) * 36 + 20)
                    }
                    ForEach(s.profiles) { r in
                        Section {
                            LabeledContent("family.today_watch", value: String(localized: "family.minutes \(r.todayWatchMin)"))
                            if let cap = r.dailyCapMin { LabeledContent("family.cap", value: String(localized: "family.minutes \(cap)")) }
                            LabeledContent("family.week_total", value: String(localized: "family.minutes \(r.weeklyWatchMin + r.weeklyListenMin)"))
                            WeekChart(days: r.days, watch: r.watchMin, listen: r.listenMin, cap: r.dailyCapMin).frame(height: 120)
                        } header: {
                            HStack {
                                Text(r.name)
                                if r.kind == "kid" { Text("profiles.kid") }
                                if r.overCap { Label("family.over_cap", systemImage: "hourglass.bottomhalf.filled").foregroundStyle(Theme.destructive) }
                            }
                        }
                    }
                }
                .scrollContentBackground(.hidden)
            } else if let error {
                StateView(kind: .error(error)) { Task { await load() } }
            } else {
                StateView(kind: .loading)
            }
        }
        .background(Theme.background)
        .navigationTitle("family.title")
        .task { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        guard let phone = app.phone else { return }
        error = nil
        do { stats = try await phone.familyStats() } catch { self.error = error.localizedDescription }
    }
}

/// One-shot Plex import (watched state, ratings, watchlist). The token is sent once and never stored.
struct PlexImportView: View {
    @Environment(AppModel.self) private var app
    @State private var serverUrl = ""
    @State private var token = ""
    @State private var running = false
    @State private var result: PlexImportResult?
    @State private var error: String?

    var body: some View {
        Form {
            Section {
                Text("plex.intro").font(Theme.body(14)).foregroundStyle(Theme.mutedForeground)
            }
            Section {
                TextField("plex.server_url", text: $serverUrl)
                    .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                SecureField("plex.token", text: $token)
                Button { Task { await run() } } label: {
                    if running { ProgressView() } else { Text("plex.import") }
                }
                .disabled(serverUrl.isEmpty || token.isEmpty || running)
            } footer: { Text("plex.token_note") }
            if let r = result {
                Section("plex.result") {
                    LabeledContent("plex.sections", value: "\(r.sections)")
                    LabeledContent("plex.movies", value: "\(r.watchedMovies)")
                    LabeledContent("plex.episodes", value: "\(r.watchedEpisodes)")
                    LabeledContent("plex.ratings", value: "\(r.ratings)")
                    LabeledContent("plex.watchlist", value: "\(r.watchlist)")
                    LabeledContent("plex.unmatched", value: "\(r.unmatched)")
                    ForEach(r.errors, id: \.self) { Text($0).font(Theme.body(12)).foregroundStyle(Theme.destructive) }
                }
            }
            if let error { Section { Text(error).foregroundStyle(Theme.destructive) } }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.background)
        .navigationTitle("plex.title")
    }

    private func run() async {
        guard let phone = app.phone else { return }
        running = true
        error = nil
        defer { running = false; token = "" }
        do {
            result = try await phone.importPlex(serverUrl: serverUrl, token: token)
            await app.homeStore?.invalidate()
        } catch {
            self.error = error.localizedDescription
        }
    }
}
