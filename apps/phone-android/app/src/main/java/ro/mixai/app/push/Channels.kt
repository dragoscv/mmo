package ro.mixai.app.push

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import ro.mixai.app.R

/** Notification channels (names localised; re-created on locale change keeps ids stable). */
object Channels {
    const val RECORDINGS = "recordings"
    const val DOWNLOADS = "downloads"
    const val EPISODES = "new_episodes"

    fun ensure(context: Context) {
        val nm = context.getSystemService(NotificationManager::class.java) ?: return
        nm.createNotificationChannels(
            listOf(
                NotificationChannel(RECORDINGS, context.getString(R.string.channel_recordings), NotificationManager.IMPORTANCE_DEFAULT)
                    .apply { description = context.getString(R.string.channel_recordings_desc) },
                NotificationChannel(DOWNLOADS, context.getString(R.string.channel_downloads), NotificationManager.IMPORTANCE_LOW)
                    .apply { description = context.getString(R.string.channel_downloads_desc) },
                NotificationChannel(EPISODES, context.getString(R.string.channel_episodes), NotificationManager.IMPORTANCE_DEFAULT)
                    .apply { description = context.getString(R.string.channel_episodes_desc) },
            ),
        )
    }

    /** Server event → channel (`recording.*`, `download.*`, everything else = new episodes/titles). */
    fun forEvent(event: String?): String = when {
        event == null -> EPISODES
        event.startsWith("recording") || event.startsWith("livetv") -> RECORDINGS
        event.startsWith("download") -> DOWNLOADS
        else -> EPISODES
    }
}
