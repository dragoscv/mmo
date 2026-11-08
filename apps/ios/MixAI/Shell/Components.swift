import MixaiCore
import SwiftUI

// RemoteImage / ProfileAvatar / StateView / SectionHeader live in MixaiUI (shared with MixAI Music).

/// Poster card used by rows / grids; zoom transition source keyed by kind+id.
struct PosterCard: View {
    @Environment(AppModel.self) private var app
    let card: TitleCard
    var width: CGFloat = 120
    let ns: Namespace.ID

    var body: some View {
        NavigationLink(value: Route.title(kind: card.kind, tmdbId: card.tmdbId, posterPath: card.posterPath)) {
            VStack(alignment: .leading, spacing: 6) {
                RemoteImage(url: app.client?.tmdbImageURL(size: TmdbSize.poster(Int(width * 2)), path: card.posterPath))
                    .frame(width: width)
                    .clipShape(.rect(cornerRadius: 12))
                    .overlay(alignment: .bottom) {
                        if let p = card.progress, p > 0 {
                            GeometryReader { g in
                                Capsule().fill(Theme.primary).frame(width: g.size.width * min(1, p), height: 3)
                            }
                            .frame(height: 3).padding(6)
                        }
                    }
                    .matchedTransitionSource(id: "\(card.kind.rawValue)-\(card.tmdbId)", in: ns)
                Text(card.title).font(Theme.body(13, weight: .medium)).lineLimit(1).frame(width: width, alignment: .leading)
            }
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text(card.title))
    }
}
