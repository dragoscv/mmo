import SwiftUI

struct NowPlayingView: View {
    @Environment(WatchModel.self) private var model

    private var active: WatchContext? {
        guard let ctx = model.context, ctx.source != "none", ctx.title != nil else { return nil }
        return ctx
    }

    var body: some View {
        Group {
            if let ctx = active {
                playing(ctx)
            } else {
                empty
            }
        }
        .navigationTitle(Text("watch.now_playing"))
    }

    private func playing(_ ctx: WatchContext) -> some View {
        ScrollView {
            VStack(spacing: 8) {
                VStack(spacing: 2) {
                    Text(verbatim: ctx.title ?? "")
                        .font(.headline)
                        .lineLimit(2)
                        .multilineTextAlignment(.center)
                    if let subtitle = ctx.subtitle {
                        Text(verbatim: subtitle)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                .accessibilityElement(children: .combine)

                if ctx.durationSec > 0 {
                    ProgressView(value: min(max(ctx.positionSec / ctx.durationSec, 0), 1))
                        .tint(WatchPalette.accent)
                }

                HStack(spacing: 6) {
                    if ctx.source == "music" {
                        control("backward.end.fill", label: "watch.previous") { model.send(WatchCommand(action: .previous)) }
                    } else {
                        control("gobackward.10", label: "watch.back10") { model.send(WatchCommand(action: .skipBack)) }
                    }
                    Button {
                        model.send(WatchCommand(action: .toggle))
                    } label: {
                        Image(systemName: ctx.playing ? "pause.fill" : "play.fill")
                            .font(.title2)
                            .frame(maxWidth: .infinity, minHeight: 44)
                    }
                    .buttonStyle(.borderedProminent)
                    .accessibilityLabel(Text(ctx.playing ? LocalizedStringKey("watch.pause") : LocalizedStringKey("watch.play")))
                    if ctx.source == "music" {
                        control("forward.end.fill", label: "watch.next") { model.send(WatchCommand(action: .next)) }
                    } else {
                        control("goforward.30", label: "watch.fwd30") { model.send(WatchCommand(action: .skipForward)) }
                    }
                }

                if ctx.source == "music" {
                    HStack(spacing: 6) {
                        control("gobackward.10", label: "watch.back10") { model.send(WatchCommand(action: .skipBack)) }
                        control("goforward.30", label: "watch.fwd30") { model.send(WatchCommand(action: .skipForward)) }
                    }
                }
            }
        }
    }

    private func control(_ symbol: String, label: LocalizedStringKey, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .frame(maxWidth: .infinity, minHeight: 36)
        }
        .accessibilityLabel(Text(label))
    }

    private var empty: some View {
        ScrollView {
            VStack(spacing: 8) {
                Image(systemName: "iphone")
                    .font(.title2)
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)
                Text("watch.nothing_playing")
                    .font(.headline)
                    .multilineTextAlignment(.center)
            }
            .padding(.top, 8)
        }
    }
}
