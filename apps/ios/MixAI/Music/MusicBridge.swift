import MixaiCore

// MixAI keeps the old call shape (`play(list, at:, store:, video:)`) for CarPlay / Search: the shared player stops
// the video through `willStart` (set in AppModel), so `video` is only kept for readability at call sites.
extension MusicPlayer {
    func play(_ list: [TrackCard], at i: Int, store: MusicStore, video: PlayerCoordinator) {
        play(list, at: i, store: store)
    }
}
