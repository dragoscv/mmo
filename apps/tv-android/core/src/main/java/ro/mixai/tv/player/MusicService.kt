package ro.mixai.tv.player

import android.content.Intent
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import ro.mixai.tv.data.ClientIdentity

// Background music (WP16-21): one ExoPlayer owned by a MediaSessionService so playback continues
// while the user browses (and shows in the system now-playing). The app talks to it through a
// MediaController (`data/MusicPlayback.kt`). The session id "music" keeps it distinct from the
// video player's in-activity session (ids must be unique per process).
class MusicService : MediaSessionService() {
    private var session: MediaSession? = null

    @OptIn(UnstableApi::class)
    override fun onCreate() {
        super.onCreate()
        val http = DefaultHttpDataSource.Factory()
            .setUserAgent(ClientIdentity.current.userAgent)
            .setAllowCrossProtocolRedirects(true)
        val player = ExoPlayer.Builder(this)
            .setMediaSourceFactory(DefaultMediaSourceFactory(this).setDataSourceFactory(http))
            .setAudioAttributes(AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build(), true)
            .setHandleAudioBecomingNoisy(true)
            .build()
        session = MediaSession.Builder(this, player)
            .setId(SESSION_ID)
            .setCallback(object : MediaSession.Callback {
                // Controllers cannot send `localConfiguration` (the URI) → it travels in requestMetadata.mediaUri.
                override fun onAddMediaItems(
                    mediaSession: MediaSession,
                    controller: MediaSession.ControllerInfo,
                    mediaItems: MutableList<MediaItem>,
                ): ListenableFuture<MutableList<MediaItem>> = Futures.immediateFuture(
                    mediaItems.map { item ->
                        val uri = item.requestMetadata.mediaUri
                        if (item.localConfiguration == null && uri != null) item.buildUpon().setUri(uri).build() else item
                    }.toMutableList(),
                )
            })
            .build()
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = session

    override fun onTaskRemoved(rootIntent: Intent?) {
        val p = session?.player
        if (p == null || !p.playWhenReady || p.mediaItemCount == 0) stopSelf()
    }

    override fun onDestroy() {
        session?.run { player.release(); release() }
        session = null
        super.onDestroy()
    }

    companion object {
        const val SESSION_ID = "music"
    }
}
