import SwiftUI

struct RemoteView: View {
    @Environment(WatchModel.self) private var model

    var body: some View {
        Group {
            if let tvs = model.context?.tvs, !tvs.isEmpty {
                List(tvs) { tv in
                    NavigationLink(value: tv.id) { TvRow(tv: tv) }
                }
            } else {
                ScrollView {
                    VStack(spacing: 8) {
                        Image(systemName: "tv")
                            .font(.title2)
                            .foregroundStyle(.secondary)
                            .accessibilityHidden(true)
                        Text("watch.no_tvs")
                            .font(.headline)
                            .multilineTextAlignment(.center)
                    }
                    .padding(.top, 8)
                }
            }
        }
        .navigationTitle(Text("watch.remote"))
        .navigationDestination(for: String.self) { id in RemotePadView(tvId: id) }
    }
}

struct TvRow: View {
    let tv: WatchContext.Tv

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: tv.playing ? "play.tv.fill" : "tv")
                .foregroundStyle(tv.playing ? WatchPalette.accent : .secondary)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 0) {
                Text(verbatim: tv.name).lineLimit(1)
                if let np = tv.nowPlaying {
                    Text(verbatim: np)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
        }
        .accessibilityElement(children: .combine)
    }
}

struct RemotePadView: View {
    @Environment(WatchModel.self) private var model
    let tvId: String

    private var tv: WatchContext.Tv? { model.context?.tvs.first { $0.id == tvId } }

    var body: some View {
        ScrollView {
            VStack(spacing: 6) {
                if let np = tv?.nowPlaying {
                    Text(verbatim: np)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .multilineTextAlignment(.center)
                }
                HStack(spacing: 6) {
                    pad("gobackward.10", label: "watch.back10", action: .skipBack)
                    Button {
                        model.send(WatchCommand(action: .toggle, target: tvId))
                    } label: {
                        Image(systemName: "playpause.fill")
                            .font(.title3)
                            .frame(maxWidth: .infinity, minHeight: 40)
                    }
                    .buttonStyle(.borderedProminent)
                    .accessibilityLabel(Text("watch.play_pause"))
                    pad("goforward.30", label: "watch.fwd30", action: .skipForward)
                }
                HStack(spacing: 6) {
                    pad("speaker.minus.fill", label: "watch.volume_down", action: .volumeDown)
                    pad("speaker.plus.fill", label: "watch.volume_up", action: .volumeUp)
                }
                pad("house.fill", label: "watch.home", action: .navigateHome)
            }
        }
        .navigationTitle(Text(verbatim: tv?.name ?? ""))
    }

    private func pad(_ symbol: String, label: LocalizedStringKey, action: WatchCommand.Action) -> some View {
        Button {
            model.send(WatchCommand(action: action, target: tvId))
        } label: {
            Image(systemName: symbol)
                .frame(maxWidth: .infinity, minHeight: 36)
        }
        .accessibilityLabel(Text(label))
    }
}
