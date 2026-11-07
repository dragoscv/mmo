package ro.mixai.music.wear

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

/** Media3 download service on the watch; holds a Wi-Fi request while downloads run ([WearNetwork]). */
@SuppressLint("UnsafeOptInUsageError")
@UnstableApi
class WearDownloadService : DownloadService(
    FOREGROUND_ID, DEFAULT_FOREGROUND_NOTIFICATION_UPDATE_INTERVAL, CHANNEL,
    R.string.downloads_channel, R.string.downloads_channel_desc,
) {
    private val helper by lazy { DownloadNotificationHelper(this, CHANNEL) }
    private val wifi by lazy { WearNetwork(this) }

    override fun getDownloadManager(): DownloadManager = WearMusicApp.downloads.manager(this)

    override fun getScheduler(): Scheduler = WorkManagerScheduler(this, "mixai-wear-downloads")

    override fun getForegroundNotification(downloads: MutableList<Download>, notMetRequirements: Int): Notification {
        if (downloads.any { it.state == Download.STATE_DOWNLOADING || it.state == Download.STATE_QUEUED }) wifi.request() else wifi.release()
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        return helper.buildProgressNotification(this, R.drawable.ic_note, open, getString(R.string.downloads_notification), downloads, notMetRequirements)
    }

    override fun onDestroy() {
        wifi.release()
        super.onDestroy()
    }

    companion object {
        private const val FOREGROUND_ID = 5301
        const val CHANNEL = "wear_downloads"

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
