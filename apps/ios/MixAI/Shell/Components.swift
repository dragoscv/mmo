import MixaiCore
import SwiftUI

/// AsyncImage with a token-coloured placeholder and fixed aspect.
struct RemoteImage: View {
    let url: URL?
    var aspect: CGFloat = 2.0 / 3.0
    var contentMode: ContentMode = .fill

    var body: some View {
        Color.clear
            .aspectRatio(aspect, contentMode: .fit)
            .overlay {
                AsyncImage(url: url, transaction: Transaction(animation: .easeOut(duration: 0.25))) { phase in
                    switch phase {
                    case .success(let img): img.resizable().aspectRatio(contentMode: contentMode)
                    default: Rectangle().fill(Theme.card).overlay(Image(systemName: "film").foregroundStyle(Theme.mutedForeground.opacity(0.5)))
                    }
                }
            }
            .clipped()
            .accessibilityHidden(true)
    }
}

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

struct ProfileAvatar: View {
    let profile: Profile?
    var size: CGFloat = 64

    var body: some View {
        let name = profile?.name ?? "?"
        ZStack {
            Circle().fill(Theme.brandGradient)
            Text(String(name.prefix(1)).uppercased()).font(Theme.heading(size * 0.45)).foregroundStyle(.white)
        }
        .frame(width: size, height: size)
        .overlay(alignment: .bottomTrailing) {
            if profile?.hasPin == true {
                Image(systemName: "lock.fill").font(.system(size: size * 0.22)).padding(size * 0.06).background(Theme.background, in: .circle)
            }
        }
        .accessibilityHidden(true)
    }
}

/// Loading / empty / error states shared by every screen.
struct StateView: View {
    enum Kind { case loading, empty(LocalizedStringKey, LocalizedStringKey), error(String) }
    let kind: Kind
    var retry: (() -> Void)?

    var body: some View {
        VStack(spacing: 12) {
            switch kind {
            case .loading:
                ProgressView().controlSize(.large)
            case .empty(let t, let hint):
                Image(systemName: "sparkles.tv").font(.system(size: 40)).foregroundStyle(Theme.mutedForeground)
                Text(t).font(Theme.heading(20))
                Text(hint).font(Theme.body(15)).foregroundStyle(Theme.mutedForeground).multilineTextAlignment(.center)
            case .error(let msg):
                Image(systemName: "wifi.exclamationmark").font(.system(size: 40)).foregroundStyle(Theme.destructive)
                Text("state.error").font(Theme.heading(20))
                Text(msg).font(Theme.body(14)).foregroundStyle(Theme.mutedForeground).multilineTextAlignment(.center)
            }
            if let retry, case .error = kind {
                Button("action.retry", action: retry).buttonStyle(.glassProminent)
            }
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

struct SectionHeader: View {
    let title: String
    var body: some View {
        Text(title).font(Theme.heading(20)).padding(.horizontal, 20).accessibilityAddTraits(.isHeader)
    }
}
