import AVFoundation
import AVKit
import MixaiCore
import SwiftUI

/// Full-screen AVPlayerViewController (Siri Remote scrubbing, audio/subtitle menus, info panel come from AVKit) on the
/// server's HLS remux (`-c copy`). Progress is saved every 10 s, on pause and on exit; Live TV resolves via MixaiCore.
struct TVPlayerView: UIViewControllerRepresentable {
    @Environment(TVModel.self) private var model
    let request: TVPlayRequest

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIViewController(context: Context) -> AVPlayerViewController {
        let vc = AVPlayerViewController()
        vc.delegate = context.coordinator
        context.coordinator.start(request, model: model, vc: vc)
        return vc
    }

    func updateUIViewController(_ vc: AVPlayerViewController, context: Context) {}

    static func dismantleUIViewController(_ vc: AVPlayerViewController, coordinator: Coordinator) {
        coordinator.stop()
    }

    @MainActor
    final class Coordinator: NSObject, AVPlayerViewControllerDelegate {
        private var player: AVPlayer?
        private var timeObserver: Any?
        private var endObserver: NSObjectProtocol?
        private weak var model: TVModel?
        private var ref: MediaRef?
        /// HLS sessions start at `start=` → the stream clock is relative to that offset.
        private var offset: Double = 0
        private var lastSave = Date.distantPast
        private var durationHint: Double = 0

        func start(_ r: TVPlayRequest, model: TVModel, vc: AVPlayerViewController) {
            self.model = model
            switch r.source {
            case .file(let fid, let ref, let startSec):
                guard let client = model.client else { return }
                self.ref = ref
                offset = max(0, startSec.rounded(.down))
                guard let url = URL(string: client.hlsURL(fileId: fid, startSec: Int(offset))) else { return }
                attach(AVPlayerItem(url: url), title: r.title, subtitle: r.subtitle, vc: vc)
                Task {
                    if let info = try? await model.media?.fileInfo(fileId: fid), let d = info.durationSec { durationHint = d }
                }
            case .live(let channelId):
                guard let live = model.liveTv else { return }
                Task {
                    guard let s = try? await live.resolve(channelId), let url = URL(string: s.url) else { return }
                    let asset = s.proxied ? AVURLAsset(url: url, options: ["AVURLAssetHTTPHeaderFieldsKey": live.client.authHeaders]) : AVURLAsset(url: url)
                    attach(AVPlayerItem(asset: asset), title: r.title, subtitle: nil, vc: vc)
                }
            }
        }

        private func attach(_ item: AVPlayerItem, title: String, subtitle: String?, vc: AVPlayerViewController) {
            var meta: [AVMetadataItem] = [metadata(.commonIdentifierTitle, title)]
            if let subtitle { meta.append(metadata(.iTunesMetadataTrackSubTitle, subtitle)) }
            item.externalMetadata = meta
            item.preferredForwardBufferDuration = 20
            let p = AVPlayer(playerItem: item)
            player = p
            vc.player = p
            timeObserver = p.addPeriodicTimeObserver(forInterval: CMTime(seconds: 2, preferredTimescale: 600), queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.tick() }
            }
            endObserver = NotificationCenter.default.addObserver(forName: AVPlayerItem.didPlayToEndTimeNotification, object: item, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.save(completed: true) }
            }
            p.play()
        }

        private func metadata(_ id: AVMetadataIdentifier, _ value: String) -> AVMetadataItem {
            let m = AVMutableMetadataItem()
            m.identifier = id
            m.value = value as NSString
            m.extendedLanguageTag = "und"
            return m.copy() as! AVMetadataItem
        }

        private var position: Double {
            let t = player?.currentTime().seconds ?? 0
            return offset + (t.isFinite ? t : 0)
        }

        private var duration: Double {
            if durationHint > 0 { return durationHint }
            let d = player?.currentItem?.duration.seconds ?? 0
            return d.isFinite && d > 0 ? offset + d : 0
        }

        private func tick() {
            guard player?.timeControlStatus == .playing || Date().timeIntervalSince(lastSave) > 30 else { return }
            if Date().timeIntervalSince(lastSave) >= 10 { save(completed: nil) }
        }

        private func save(completed: Bool?) {
            guard let ref, let progress = model?.progress, duration > 0 else { return }
            lastSave = .now
            let pos = position, dur = duration
            let done = completed ?? (pos / dur > 0.92)
            Task { await progress.save(ref, positionSec: pos, durationSec: dur, completed: done ? true : nil) }
        }

        func stop() {
            save(completed: nil)
            if let o = timeObserver { player?.removeTimeObserver(o) }
            timeObserver = nil
            endObserver.map(NotificationCenter.default.removeObserver)
            endObserver = nil
            player?.pause()
            player = nil
            Task { await model?.homeStore?.invalidate() }
        }

        nonisolated func playerViewControllerShouldDismiss(_ playerViewController: AVPlayerViewController) -> Bool { true }

        nonisolated func playerViewControllerDidEndDismissalTransition(_ playerViewController: AVPlayerViewController) {
            Task { @MainActor in self.model?.playing = nil }
        }
    }
}
