package ro.mixai.music.widget

import android.content.Context
import androidx.glance.appwidget.updateAll
import androidx.media3.common.Player
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/** Mirrors the core MusicService player into [WidgetBus] and refreshes the widgets on visible changes. */
object MusicWidgetBridge {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    fun attach(context: Context, player: Player) {
        val app = context.applicationContext
        val listener = object : Player.Listener {
            override fun onEvents(player: Player, events: Player.Events) {
                if (events.containsAny(
                        Player.EVENT_MEDIA_ITEM_TRANSITION, Player.EVENT_MEDIA_METADATA_CHANGED, Player.EVENT_PLAY_WHEN_READY_CHANGED,
                        Player.EVENT_IS_PLAYING_CHANGED, Player.EVENT_TIMELINE_CHANGED, Player.EVENT_PLAYBACK_STATE_CHANGED,
                    )
                ) publish(app, player)
            }
        }
        player.addListener(listener)
        publish(app, player)
    }

    private fun publish(context: Context, player: Player) {
        val item = player.currentMediaItem
        val m = player.mediaMetadata
        val snap = if (item == null) {
            WidgetBus.state(context).value?.copy(playing = false) ?: WidgetSnapshot()
        } else {
            WidgetSnapshot(
                title = m.title?.toString().orEmpty(),
                artist = m.artist?.toString().orEmpty(),
                artUri = m.artworkUri?.toString().orEmpty(),
                playing = player.playWhenReady && player.playbackState != Player.STATE_ENDED && player.playbackState != Player.STATE_IDLE,
                hasNext = player.hasNextMediaItem(),
                hasPrevious = player.hasPreviousMediaItem() || player.currentPosition > 3000,
            )
        }
        if (WidgetBus.publish(context, snap)) scope.launch { runCatching { MusicWidget().updateAll(context) } }
    }
}
