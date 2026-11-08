import MixaiCore
import SwiftUI

/// AsyncImage with a token-coloured placeholder and fixed aspect.
public struct RemoteImage: View {
    let url: URL?
    var aspect: CGFloat
    var contentMode: ContentMode
    var placeholderSymbol: String

    public init(url: URL?, aspect: CGFloat = 2.0 / 3.0, contentMode: ContentMode = .fill, placeholderSymbol: String = "film") {
        self.url = url
        self.aspect = aspect
        self.contentMode = contentMode
        self.placeholderSymbol = placeholderSymbol
    }

    public var body: some View {
        Color.clear
            .aspectRatio(aspect, contentMode: .fit)
            .overlay {
                AsyncImage(url: url, transaction: Transaction(animation: .easeOut(duration: 0.25))) { phase in
                    switch phase {
                    case .success(let img): img.resizable().aspectRatio(contentMode: contentMode)
                    default: Rectangle().fill(Theme.card).overlay(Image(systemName: placeholderSymbol).foregroundStyle(Theme.mutedForeground.opacity(0.5)))
                    }
                }
            }
            .clipped()
            .accessibilityHidden(true)
    }
}

public struct ProfileAvatar: View {
    let profile: Profile?
    var size: CGFloat

    public init(profile: Profile?, size: CGFloat = 64) {
        self.profile = profile
        self.size = size
    }

    public var body: some View {
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
public struct StateView: View {
    public enum Kind { case loading, empty(LocalizedStringKey, LocalizedStringKey), error(String) }
    let kind: Kind
    var symbol: String
    var retry: (() -> Void)?

    public init(kind: Kind, symbol: String = "sparkles.tv", retry: (() -> Void)? = nil) {
        self.kind = kind
        self.symbol = symbol
        self.retry = retry
    }

    public var body: some View {
        VStack(spacing: 12) {
            switch kind {
            case .loading:
                ProgressView().controlSize(.large)
            case .empty(let t, let hint):
                Image(systemName: symbol).font(.system(size: 40)).foregroundStyle(Theme.mutedForeground)
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

public struct SectionHeader: View {
    let title: String
    public init(title: String) { self.title = title }
    public var body: some View {
        Text(title).font(Theme.heading(20)).padding(.horizontal, 20).accessibilityAddTraits(.isHeader)
    }
}
