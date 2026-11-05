import MediaPlayer

/// Lock screen / Control Center / headphones → whichever session is active (video first, then music).
@MainActor
enum RemoteCommands {
    private static var installed = false

    static func install(_ app: AppModel) {
        guard !installed else { return }
        installed = true
        let c = MPRemoteCommandCenter.shared()
        c.playCommand.addTarget { _ in
            MainActor.assumeIsolated { app.player.request != nil ? app.player.play() : app.music.play() }
            return .success
        }
        c.pauseCommand.addTarget { _ in
            MainActor.assumeIsolated { app.player.request != nil ? app.player.pause() : app.music.pause() }
            return .success
        }
        c.togglePlayPauseCommand.addTarget { _ in
            MainActor.assumeIsolated { app.player.request != nil ? app.player.togglePlay() : app.music.toggle() }
            return .success
        }
        c.nextTrackCommand.addTarget { _ in
            MainActor.assumeIsolated { app.music.next() }
            return .success
        }
        c.previousTrackCommand.addTarget { _ in
            MainActor.assumeIsolated { app.music.previous() }
            return .success
        }
        c.skipForwardCommand.preferredIntervals = [30]
        c.skipForwardCommand.addTarget { _ in
            MainActor.assumeIsolated { app.player.skip(30) }
            return .success
        }
        c.skipBackwardCommand.preferredIntervals = [10]
        c.skipBackwardCommand.addTarget { _ in
            MainActor.assumeIsolated { app.player.skip(-10) }
            return .success
        }
        c.changePlaybackPositionCommand.addTarget { e in
            guard let e = e as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            MainActor.assumeIsolated { app.player.request != nil ? app.player.seek(to: e.positionTime) : app.music.seek(e.positionTime) }
            return .success
        }
    }
}
