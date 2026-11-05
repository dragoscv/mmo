import SwiftUI
import UIKit
import WidgetKit

@main
struct MixAIWidgetsBundle: WidgetBundle {
    var body: some Widget {
        ContinueWatchingWidget()
        NowPlayingWidget()
        DownloadLiveActivity()
        RecordingLiveActivity()
    }
}

/// MixAI colours for the extension (the app's Theme/Tokens are app-target only).
enum WidgetPalette {
    static let background = Color(red: 0.05, green: 0.04, blue: 0.09)
    static let accent = Color(red: 0.62, green: 0.42, blue: 1.0)
}

/// Widgets cannot use AsyncImage: thumbnails are read synchronously from the App Group.
enum WidgetImage {
    static func load(_ file: String?) -> UIImage? {
        guard let url = AppGroup.imageURL(file) else { return nil }
        return UIImage(contentsOfFile: url.path)
    }
}

/// Poster/cover thumbnail with a neutral fallback.
struct WidgetArtwork: View {
    let file: String?
    var symbol: String = "film"

    var body: some View {
        if let image = WidgetImage.load(file) {
            Image(uiImage: image)
                .resizable()
                .aspectRatio(contentMode: .fill)
        } else {
            ZStack {
                WidgetPalette.accent.opacity(0.18)
                Image(systemName: symbol)
                    .font(.title3)
                    .foregroundStyle(WidgetPalette.accent)
            }
            .accessibilityHidden(true)
        }
    }
}
