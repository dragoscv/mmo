import AppIntents
import SwiftUI
import WidgetKit

// MARK: Configuration intent (pick a profile)

struct ProfileEntity: AppEntity, Sendable {
    let id: String
    let name: String

    static let typeDisplayRepresentation: TypeDisplayRepresentation = TypeDisplayRepresentation(name: "widget.continue.profile")
    static let defaultQuery = ProfileQuery()

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(name)")
    }

    init(id: String, name: String) {
        self.id = id
        self.name = name
    }

    init(row: WidgetSnapshot.ProfileRow) {
        self.init(id: row.profileId, name: row.profileName)
    }
}

struct ProfileQuery: EntityQuery, Sendable {
    init() {}

    func entities(for identifiers: [ProfileEntity.ID]) async throws -> [ProfileEntity] {
        let wanted = Set(identifiers)
        return WidgetSnapshot.load().profiles.filter { wanted.contains($0.profileId) }.map(ProfileEntity.init(row:))
    }

    func suggestedEntities() async throws -> [ProfileEntity] {
        WidgetSnapshot.load().profiles.map(ProfileEntity.init(row:))
    }

    func defaultResult() async -> ProfileEntity? {
        WidgetSnapshot.load().row(for: nil).map(ProfileEntity.init(row:))
    }
}

struct SelectProfileIntent: WidgetConfigurationIntent {
    static let title: LocalizedStringResource = "widget.continue.profile"
    static let description = IntentDescription("widget.continue.desc")

    @Parameter(title: "widget.continue.profile")
    var profile: ProfileEntity?

    init() {}
}

// MARK: Timeline

struct ContinueWatchingEntry: TimelineEntry {
    let date: Date
    let profileName: String?
    let items: [WidgetSnapshot.Item]
}

struct ContinueWatchingProvider: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> ContinueWatchingEntry {
        ContinueWatchingEntry(
            date: .now,
            profileName: nil,
            items: [
                WidgetSnapshot.Item(kind: "movie", tmdbId: 0, title: "MixAI", subtitle: nil, progress: 0.4, imageFile: nil),
            ])
    }

    func snapshot(for configuration: SelectProfileIntent, in context: Context) async -> ContinueWatchingEntry {
        Self.entry(for: configuration)
    }

    func timeline(for configuration: SelectProfileIntent, in context: Context) async -> Timeline<ContinueWatchingEntry> {
        let entry = Self.entry(for: configuration)
        return Timeline(entries: [entry], policy: .after(Date.now.addingTimeInterval(30 * 60)))
    }

    static func entry(for configuration: SelectProfileIntent) -> ContinueWatchingEntry {
        let snap = WidgetSnapshot.load()
        let row = snap.row(for: configuration.profile?.id)
        return ContinueWatchingEntry(date: .now, profileName: row?.profileName, items: row?.items ?? [])
    }
}

// MARK: Views

struct ContinueWatchingView: View {
    @Environment(\.widgetFamily) private var family
    let entry: ContinueWatchingEntry

    var body: some View {
        content
            .containerBackground(for: .widget) {
                if family == .accessoryRectangular { Color.clear } else { WidgetPalette.background }
            }
    }

    @ViewBuilder private var content: some View {
        if entry.items.isEmpty {
            emptyState
        } else {
            switch family {
            case .systemSmall: small(entry.items[0])
            case .systemMedium: grid(limit: 3, columns: 3)
            case .systemLarge: grid(limit: 6, columns: 3)
            case .accessoryRectangular: rectangular(entry.items[0])
            default: small(entry.items[0])
            }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 6) {
            if family != .accessoryRectangular {
                Image(systemName: "play.rectangle.on.rectangle")
                    .font(.title2)
                    .foregroundStyle(WidgetPalette.accent)
                    .accessibilityHidden(true)
            }
            Text("widget.continue.empty")
                .font(.caption)
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func small(_ item: WidgetSnapshot.Item) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            WidgetArtwork(file: item.imageFile)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            Text(item.title)
                .font(.caption.weight(.semibold))
                .lineLimit(1)
                .foregroundStyle(.white)
            ItemProgress(progress: item.progress)
        }
        .widgetURL(DeepLink.title(kind: item.kind, tmdbId: item.tmdbId))
        .accessibilityElement(children: .combine)
    }

    private func grid(limit: Int, columns: Int) -> some View {
        let items = Array(entry.items.prefix(limit))
        let cols = Array(repeating: GridItem(.flexible(), spacing: 8, alignment: .top), count: columns)
        return VStack(alignment: .leading, spacing: 6) {
            header
            LazyVGrid(columns: cols, alignment: .leading, spacing: 8) {
                ForEach(items) { item in
                    Link(destination: DeepLink.title(kind: item.kind, tmdbId: item.tmdbId)) {
                        PosterTile(item: item, compact: family == .systemMedium)
                    }
                }
            }
            Spacer(minLength: 0)
        }
    }

    private var header: some View {
        HStack(spacing: 4) {
            Text("widget.continue.title")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.white)
            Spacer(minLength: 4)
            if let name = entry.profileName {
                Text(verbatim: name)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
    }

    private func rectangular(_ item: WidgetSnapshot.Item) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("widget.continue.title")
                .font(.caption2)
                .foregroundStyle(.secondary)
            Text(item.title)
                .font(.headline)
                .lineLimit(1)
            if let progress = item.progress {
                ProgressView(value: min(max(progress, 0), 1))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .widgetURL(DeepLink.title(kind: item.kind, tmdbId: item.tmdbId))
        .accessibilityElement(children: .combine)
    }
}

struct PosterTile: View {
    let item: WidgetSnapshot.Item
    let compact: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            WidgetArtwork(file: item.imageFile)
                .frame(maxWidth: .infinity)
                .frame(height: compact ? 70 : 110)
                .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
            Text(item.title)
                .font(.caption2.weight(.semibold))
                .lineLimit(1)
                .foregroundStyle(.white)
            ItemProgress(progress: item.progress)
        }
        .accessibilityElement(children: .combine)
    }
}

struct ItemProgress: View {
    let progress: Double?

    var body: some View {
        if let progress {
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.white.opacity(0.2))
                    Capsule().fill(WidgetPalette.accent)
                        .frame(width: geo.size.width * min(max(progress, 0), 1))
                }
            }
            .frame(height: 3)
            .accessibilityHidden(true)
        }
    }
}

struct ContinueWatchingWidget: Widget {
    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: WidgetKinds.continueWatching, intent: SelectProfileIntent.self, provider: ContinueWatchingProvider()) { entry in
            ContinueWatchingView(entry: entry)
        }
        .configurationDisplayName("widget.continue.title")
        .description("widget.continue.desc")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .accessoryRectangular])
    }
}
