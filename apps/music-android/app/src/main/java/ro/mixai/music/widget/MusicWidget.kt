package ro.mixai.music.widget

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.glance.ColorFilter
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.Image
import androidx.glance.ImageProvider
import androidx.glance.LocalContext
import androidx.glance.LocalSize
import androidx.glance.action.ActionParameters
import androidx.glance.action.actionParametersOf
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.action.ActionCallback
import androidx.glance.appwidget.action.actionRunCallback
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.appwidget.cornerRadius
import androidx.glance.appwidget.provideContent
import androidx.glance.background
import androidx.glance.color.ColorProvider
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.Column
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.padding
import androidx.glance.layout.size
import androidx.glance.layout.width
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import androidx.media3.common.MediaItem
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import coil3.SingletonImageLoader
import coil3.request.ImageRequest
import coil3.request.allowHardware
import coil3.toBitmap
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import ro.mixai.mobile.theme.Tokens
import ro.mixai.mobile.theme.TokensLight
import ro.mixai.music.MainActivity
import ro.mixai.music.R
import ro.mixai.tv.player.MediaIds
import ro.mixai.tv.player.MusicNode
import ro.mixai.tv.player.MusicService
import kotlin.coroutines.resume

/**
 * Home-screen widget (WP17-41f): cover, title / artist, previous / play-pause / next. Idle (nothing
 * played yet) it offers "Start a mix". Tapping the cover or text opens Now Playing.
 */
class MusicWidget : GlanceAppWidget() {
    override val sizeMode: SizeMode = SizeMode.Exact

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val states = WidgetBus.state(context)
        provideContent {
            val snap by states.collectAsState()
            WidgetContent(snap ?: WidgetSnapshot())
        }
    }
}

class MusicWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = MusicWidget()
}

private object WidgetColors {
    val background = ColorProvider(day = TokensLight.card, night = Tokens.card)
    val title = ColorProvider(day = TokensLight.foreground, night = Tokens.foreground)
    val muted = ColorProvider(day = TokensLight.mutedForeground, night = Tokens.mutedForeground)
    val accent = ColorProvider(day = TokensLight.primary, night = Tokens.primary)
    val onAccent = ColorProvider(day = TokensLight.primaryForeground, night = Tokens.primaryForeground)
    val tile = ColorProvider(day = TokensLight.secondary, night = Tokens.secondary)
}

@Composable
private fun WidgetContent(s: WidgetSnapshot) {
    val context = LocalContext.current
    val size = LocalSize.current
    val wide = size.width >= 220.dp
    val art by produceState<Bitmap?>(null, s.artUri) { value = loadArt(context, s.artUri) }
    val open = actionStartActivity(
        Intent(Intent.ACTION_VIEW, Uri.parse("mixai-music://now-playing")).setComponent(ComponentName(context, MainActivity::class.java)),
    )

    Row(
        GlanceModifier.fillMaxSize().background(WidgetColors.background).cornerRadius(20.dp).padding(horizontal = 10.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (wide) {
            Box(GlanceModifier.size(48.dp).cornerRadius(10.dp).background(WidgetColors.tile).clickable(open), contentAlignment = Alignment.Center) {
                val bmp = art
                if (bmp != null) {
                    Image(ImageProvider(bmp), contentDescription = null, modifier = GlanceModifier.size(48.dp).cornerRadius(10.dp))
                } else {
                    Image(ImageProvider(R.drawable.ic_widget_note), contentDescription = null, colorFilter = ColorFilter.tint(WidgetColors.muted), modifier = GlanceModifier.size(24.dp))
                }
            }
            Spacer(GlanceModifier.width(10.dp))
        }
        Column(GlanceModifier.defaultWeight().clickable(open)) {
            Text(
                if (s.idle) context.getString(R.string.widget_idle_title) else s.title,
                style = TextStyle(color = WidgetColors.title, fontSize = 14.sp, fontWeight = FontWeight.Medium), maxLines = 1,
            )
            Text(
                if (s.idle) context.getString(R.string.widget_idle_hint) else s.artist,
                style = TextStyle(color = WidgetColors.muted, fontSize = 12.sp), maxLines = 1,
            )
        }
        if (s.idle) {
            Button(R.drawable.ic_widget_mix, R.string.widget_start_mix, CMD_MIX, primary = true)
        } else {
            if (wide) Button(R.drawable.ic_widget_previous, R.string.widget_previous, CMD_PREVIOUS)
            Button(
                if (s.playing) R.drawable.ic_widget_pause else R.drawable.ic_widget_play,
                if (s.playing) R.string.widget_pause else R.string.widget_play,
                CMD_TOGGLE, primary = true,
            )
            Button(R.drawable.ic_widget_next, R.string.widget_next, CMD_NEXT)
        }
    }
}

@Composable
private fun Button(icon: Int, label: Int, cmd: String, primary: Boolean = false) {
    val context = LocalContext.current
    Box(
        GlanceModifier.size(44.dp).cornerRadius(22.dp)
            .let { if (primary) it.background(WidgetColors.accent) else it }
            .clickable(actionRunCallback<WidgetCommand>(actionParametersOf(CMD to cmd))),
        contentAlignment = Alignment.Center,
    ) {
        Image(
            ImageProvider(icon), contentDescription = context.getString(label),
            colorFilter = ColorFilter.tint(if (primary) WidgetColors.onAccent else WidgetColors.title),
            modifier = GlanceModifier.size(24.dp),
        )
    }
}

private suspend fun loadArt(context: Context, uri: String): Bitmap? {
    if (uri.isBlank()) return null
    return runCatching {
        val req = ImageRequest.Builder(context).data(uri).size(192).allowHardware(false).build()
        SingletonImageLoader.get(context).execute(req).image?.toBitmap()
    }.getOrNull()
}

private val CMD = ActionParameters.Key<String>("cmd")
internal const val CMD_TOGGLE = "toggle"
internal const val CMD_NEXT = "next"
internal const val CMD_PREVIOUS = "previous"
internal const val CMD_MIX = "mix"

/** Sends a widget button to MusicService through a short-lived MediaController. */
class WidgetCommand : ActionCallback {
    override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) {
        val cmd = parameters[CMD] ?: return
        // The callback runs with a ReceiverRestrictedContext, which may not bind services.
        val context = context.applicationContext
        withContext(Dispatchers.Main) {
            val token = SessionToken(context, ComponentName(context, MusicService::class.java))
            val future = MediaController.Builder(context, token).buildAsync()
            val c = suspendCancellableCoroutine<MediaController?> { cont ->
                future.addListener({ cont.resume(runCatching { future.get() }.getOrNull()) }, ContextCompat.getMainExecutor(context))
                cont.invokeOnCancellation { MediaController.releaseFuture(future) }
            } ?: return@withContext
            try {
                when (cmd) {
                    CMD_TOGGLE -> when {
                        c.mediaItemCount == 0 -> startMix(c)
                        c.playWhenReady -> c.pause()
                        else -> { if (c.playbackState == androidx.media3.common.Player.STATE_IDLE) c.prepare(); c.play() }
                    }
                    CMD_NEXT -> c.seekToNext()
                    CMD_PREVIOUS -> c.seekToPrevious()
                    CMD_MIX -> startMix(c)
                }
                // Let the session process the command (a mix resolves on the server) before unbinding.
                delay(if (cmd == CMD_MIX || c.mediaItemCount == 0) 4000 else 500)
            } finally {
                c.release()
            }
        }
    }

    private fun startMix(c: MediaController) {
        c.setMediaItem(MediaItem.Builder().setMediaId(MediaIds.encode(MusicNode.Mix)).build())
        c.prepare()
        c.play()
    }
}
