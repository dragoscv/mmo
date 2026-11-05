package ro.mixai.app.downloads

import android.annotation.SuppressLint
import android.app.Notification
import android.app.PendingIntent
import android.content.Intent
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.offline.Download
import androidx.media3.exoplayer.offline.DownloadManager
import androidx.media3.exoplayer.offline.DownloadNotificationHelper
import androidx.media3.exoplayer.offline.DownloadService
import androidx.media3.exoplayer.scheduler.Scheduler
import androidx.media3.exoplayer.workmanager.WorkManagerScheduler
import ro.mixai.app.MainActivity
import ro.mixai.app.R
import ro.mixai.app.push.Channels

/**
 * Media3 download service (foreground type dataSync, user-initiated downloads). Resumption after a requirement
 * change (Wi-Fi back, reboot) is scheduled through [WorkManagerScheduler], not a long-lived foreground service.
 */
@SuppressLint("UnsafeOptInUsageError")
@UnstableApi
class MixaiDownloadService : DownloadService(
    FOREGROUND_ID, DEFAULT_FOREGROUND_NOTIFICATION_UPDATE_INTERVAL, Channels.DOWNLOADS,
    R.string.channel_downloads, R.string.channel_downloads_desc,
) {
    private val helper by lazy { DownloadNotificationHelper(this, Channels.DOWNLOADS) }

    override fun getDownloadManager(): DownloadManager = DownloadCenter.manager(this)

    override fun getScheduler(): Scheduler = WorkManagerScheduler(this, "mixai-downloads")

    override fun getForegroundNotification(downloads: MutableList<Download>, notMetRequirements: Int): Notification {
        val open = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).setAction(Intent.ACTION_VIEW).setData(android.net.Uri.parse("mixai://downloads")),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return helper.buildProgressNotification(this, R.drawable.ic_stat_mixai, open, getString(R.string.downloads_notification), downloads, notMetRequirements)
    }

    private companion object { const val FOREGROUND_ID = 4201 }
}
