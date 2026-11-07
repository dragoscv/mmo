package ro.mixai.music.ui.output

import android.annotation.SuppressLint
import android.content.Context
import android.util.Log
import androidx.media3.cast.Cast
import androidx.media3.cast.CastParams
import androidx.media3.cast.CastPlayer
import androidx.media3.cast.DefaultMediaItemConverter
import androidx.media3.cast.MediaItemConverter
import androidx.media3.cast.RemoteCastPlayer
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.mediarouter.media.MediaRouteSelector
import androidx.mediarouter.media.MediaRouter
import com.google.android.gms.cast.CastMediaControlIntent
import com.google.android.gms.cast.MediaQueueItem
import com.google.android.gms.cast.framework.CastSession
import com.google.android.gms.cast.framework.SessionManagerListener
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import ro.mixai.tv.cast.MusicOutputs
import ro.mixai.tv.cast.OutputTarget
import ro.mixai.tv.cast.RemoteFormat
import ro.mixai.tv.player.TrackItems

/**
 * Google Cast for music (WP17-41h). Media3 [CastPlayer] wraps the music service's local ExoPlayer, so when a
 * Cast session starts it moves the queue and position to the receiver and back when it ends. Routes for the
 * output sheet come from MediaRouter with the receiver's category. Receiver id: MixAI custom receiver when
 * the build sets one (`mixaiCastAppId`), else the Default Media Receiver.
 */
@SuppressLint("UnsafeOptInUsageError")
@UnstableApi
object CastOutputs {
    private const val TAG = "MixaiCastOut"
    @Volatile var available = false
        private set
    private var router: MediaRouter? = null
    /** The current Cast session was started from the music output picker (cleared shortly after it ends). */
    @Volatile private var musicOwned = false
    /** Local play state when the user picked a Cast device; applied to the receiver after the transfer. */
    @Volatile private var wantPlay = false
    @Volatile private var resumeOnReady = false
    private var localRef: Player? = null
    private var remoteRef: Player? = null
    private val main = android.os.Handler(android.os.Looper.getMainLooper())
    private var selector: MediaRouteSelector? = null
    private val _routes = MutableStateFlow<List<OutputTarget.Cast>>(emptyList())
    /** Cast devices currently discovered (only while [scan] is active). */
    val routes: StateFlow<List<OutputTarget.Cast>> = _routes.asStateFlow()

    private val routerCallback = object : MediaRouter.Callback() {
        override fun onRouteAdded(router: MediaRouter, route: MediaRouter.RouteInfo) = publish()
        override fun onRouteRemoved(router: MediaRouter, route: MediaRouter.RouteInfo) = publish()
        override fun onRouteChanged(router: MediaRouter, route: MediaRouter.RouteInfo) = publish()
    }

    /** Once per process (Application.onCreate). [receiverAppId] blank = Default Media Receiver. */
    fun init(context: Context, receiverAppId: String) {
        val app = context.applicationContext
        runCatching {
            val cast = Cast.getSingletonInstance(app)
            if (cast.needsInitialization()) {
                val params = CastParams.Builder().setRemoteToLocalEnabled(true)
                if (receiverAppId.isNotBlank()) params.setReceiverApplicationId(receiverAppId)
                cast.initialize(params.build())
            }
            available = cast.castContextLoadFailure == null
            if (available) {
                cast.addSessionManagerListener(sessionListener)
                val appId = receiverAppId.ifBlank { CastMediaControlIntent.DEFAULT_MEDIA_RECEIVER_APPLICATION_ID }
                selector = MediaRouteSelector.Builder().addControlCategory(CastMediaControlIntent.categoryForCast(appId)).build()
                router = MediaRouter.getInstance(app)
                MusicOutputs.castControl = Control(app)
            }
        }.onFailure { Log.w(TAG, "cast init failed: ${it.message}") }
        Log.i(TAG, "cast available=$available receiver=${receiverAppId.ifBlank { "default" }}")
    }

    /**
     * Session player for the music service: CastPlayer around [local], or [local] without Cast. State moves
     * only for sessions music started (or is leaving): a Cast session the phone's video player opened must not
     * get the music queue, nor have it cleared.
     */
    fun wrap(context: Context, local: ExoPlayer): Player {
        if (!available) return local
        val guard = CastPlayer.TransferCallback { from, to ->
            if (musicOwned && from.mediaItemCount > 0) {
                // DEFAULT moves queue + position, but the local player is already paused when this runs, so the
                // receiver stayed READY + paused on device. Use the play state captured when the user picked.
                CastPlayer.TransferCallback.DEFAULT.transferState(from, to)
                if (to !== local) { resumeOnReady = wantPlay; to.playWhenReady = wantPlay }
            }
        }
        return runCatching {
            val remote = RemoteCastPlayer.Builder(context).setMediaItemConverter(MusicItemConverter()).build()
            remote.addListener(object : Player.Listener {
                override fun onPlayerError(error: androidx.media3.common.PlaybackException) { Log.w(TAG, "receiver error: ${error.errorCodeName} ${error.message}") }
                override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
                    Log.i(TAG, "receiver playWhenReady=$playWhenReady reason=$reason")
                }
                override fun onPlaybackStateChanged(state: Int) {
                    Log.i(TAG, "receiver state=$state")
                    if (state == Player.STATE_READY && resumeOnReady) { resumeOnReady = false; remoteRef?.play() }
                }
            })
            localRef = local
            remoteRef = remote
            CastPlayer.Builder(context).setLocalPlayer(local).setRemotePlayer(remote).setTransferCallback(guard).build()
        }.getOrElse { Log.w(TAG, "CastPlayer: ${it.message}"); local }
    }

    /**
     * Queue items for the receiver: the stream URL asks MMO Server for a format Cast decodes (server >= 3.12
     * converts APE / WMA / DSD / AIFF), and the item carries its content type — `stream.view` URLs have no
     * extension, so without one the receiver cannot pick a decoder and stays paused.
     */
    private class MusicItemConverter : MediaItemConverter {
        private val base = DefaultMediaItemConverter()
        override fun toMediaQueueItem(mediaItem: MediaItem): MediaQueueItem {
            val card = TrackItems.fromItem(mediaItem)
            val uri = mediaItem.localConfiguration?.uri ?: mediaItem.requestMetadata.mediaUri
            if (card == null || uri == null) return base.toMediaQueueItem(mediaItem)
            val format = RemoteFormat.choose(card.format, RemoteFormat.CAST_MIMES)
            val item = mediaItem.buildUpon()
                .setUri(RemoteFormat.withFormat(uri.toString(), format))
                .setMimeType(RemoteFormat.mimeAfter(card.format, format))
                .build()
            return base.toMediaQueueItem(item)
        }
        override fun toMediaItem(mediaQueueItem: MediaQueueItem): MediaItem = base.toMediaItem(mediaQueueItem)
    }

    /** Starts / stops active discovery (while the output sheet is open). */
    fun scan(on: Boolean) {
        val r = router ?: return
        val s = selector ?: return
        r.removeCallback(routerCallback)
        if (on) r.addCallback(s, routerCallback, MediaRouter.CALLBACK_FLAG_PERFORM_ACTIVE_SCAN)
        publish()
    }

    private fun publish() {
        val r = router ?: return
        val s = selector ?: return
        _routes.value = r.routes.filter { !it.isDefault && it.isEnabled && it.matchesSelector(s) }
            .map { OutputTarget.Cast(it.id, it.name) }
            .distinctBy { it.routeId }
    }

    private class Control(private val app: Context) : MusicOutputs.CastControl {
        override fun select(routeId: String) {
            val r = router ?: return
            val route = r.routes.firstOrNull { it.id == routeId } ?: run {
                MusicOutputs.fail(OutputTarget.Cast(routeId, ""), "not found"); return
            }
            main.removeCallbacksAndMessages(null)
            musicOwned = true
            wantPlay = localRef?.playWhenReady == true
            r.selectRoute(route)
        }

        override fun stop() {
            runCatching { Cast.getSingletonInstance(app).endCurrentSession(true) }
            router?.unselect(MediaRouter.UNSELECT_REASON_STOPPED)
        }
    }

    private val sessionListener = object : SessionManagerListener<CastSession> {
        private fun active(session: CastSession) {
            if (!musicOwned) return
            val name = session.castDevice?.friendlyName.orEmpty()
            val route = router?.selectedRoute?.takeIf { !it.isDefault }
            MusicOutputs.setActive(OutputTarget.Cast(route?.id ?: (session.castDevice?.deviceId ?: "cast"), route?.name ?: name))
        }
        override fun onSessionStarted(session: CastSession, sessionId: String) = active(session)
        override fun onSessionResumed(session: CastSession, wasSuspended: Boolean) = active(session)
        override fun onSessionStarting(session: CastSession) {}
        override fun onSessionStartFailed(session: CastSession, error: Int) {
            if (!musicOwned) return
            musicOwned = false
            MusicOutputs.switching.value?.let { MusicOutputs.fail(it, "error $error") }
        }
        override fun onSessionEnding(session: CastSession) {}
        override fun onSessionEnded(session: CastSession, error: Int) {
            if (MusicOutputs.active.value is OutputTarget.Cast) MusicOutputs.setActive(OutputTarget.Local)
            // CastPlayer transfers remote -> local on the same event; keep ownership until it ran.
            main.postDelayed({ musicOwned = false }, 1_500)
        }
        override fun onSessionResuming(session: CastSession, sessionId: String) {}
        override fun onSessionResumeFailed(session: CastSession, error: Int) {}
        override fun onSessionSuspended(session: CastSession, reason: Int) {}
    }
}
