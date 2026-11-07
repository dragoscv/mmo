package ro.mixai.music.downloads

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.offline.Download
import androidx.media3.exoplayer.offline.DownloadManager
import androidx.media3.exoplayer.offline.DownloadNotificationHelper
import androidx.media3.exoplayer.offline.DownloadService
import androidx.media3.exoplayer.scheduler.Scheduler
import androidx.media3.exoplayer.workmanager.WorkManagerScheduler
import ro.mixai.music.MainActivity
import ro.mixai.music.R

/**
 * Media3 download service (foreground type dataSync, user-initiated downloads). Resumption after a
 * requirement change (Wi-Fi back, reboot) goes through [WorkManagerScheduler].
 */
@SuppressLint("UnsafeOptInUsageError")
@UnstableApi
class MusicDownloadService : DownloadService(
    FOREGROUND_ID, DEFAULT_FOREGROUND_NOTIFICATION_UPDATE_INTERVAL, CHANNEL,
    R.string.downloads_channel, R.string.downloads_channel_desc,
) {
    private val helper by lazy { DownloadNotificationHelper(this, CHANNEL) }

    override fun getDownloadManager(): DownloadManager = MusicDownloads.manager(this)

    override fun getScheduler(): Scheduler = WorkManagerScheduler(this, "mixai-music-downloads")

    override fun getForegroundNotification(downloads: MutableList<Download>, notMetRequirements: Int): Notification {
        val open = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).setAction(Intent.ACTION_VIEW).setData(android.net.Uri.parse("mixai-music://downloads")),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return helper.buildProgressNotification(this, R.drawable.ic_launcher_foreground, open, getString(R.string.downloads_notification), downloads, notMetRequirements)
    }

    companion object {
        private const val FOREGROUND_ID = 5201
        const val CHANNEL = "music_downloads"

        /** DownloadService creates its channel lazily; pre-create it so the first progress notification is labelled. */
        fun ensureChannel(context: Context) {
            val nm = context.getSystemService(NotificationManager::class.java) ?: return
            if (nm.getNotificationChannel(CHANNEL) != null) return
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL, context.getString(R.string.downloads_channel), NotificationManager.IMPORTANCE_LOW)
                    .apply { description = context.getString(R.string.downloads_channel_desc) },
            )
        }
    }
}
