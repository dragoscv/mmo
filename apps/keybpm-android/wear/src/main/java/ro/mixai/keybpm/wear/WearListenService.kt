package ro.mixai.keybpm.wear

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.wear.ongoing.OngoingActivity
import androidx.wear.ongoing.Status
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import ro.mixai.listen.Harmony

/**
 * Microphone foreground service while the watch listens (screen off / wrist down keeps analysing), shown as a Wear
 * ongoing activity (watch face indicator + recents) with the live key and BPM. Started only from the visible
 * activity (while-in-use microphone rule).
 */
class WearListenService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var ongoing: OngoingActivity? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            (application as KeyBpmWearApp).listen.stopWatch()
            return START_NOT_STICKY
        }
        val builder = builder(getString(R.string.listening))
        ongoing = OngoingActivity.Builder(applicationContext, NOTIF_ID, builder)
            .setStaticIcon(R.drawable.ic_stat_listen)
            .setTouchIntent(openApp())
            .setStatus(status(getString(R.string.listening)))
            .build()
            .also { it.apply(applicationContext) }
        startForeground(NOTIF_ID, builder.build(), ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
        val listen = (application as KeyBpmWearApp).listen
        scope.launch {
            listen.ui.map { text(it) }.distinctUntilChanged().collect { t ->
                ongoing?.update(applicationContext, status(t))
                getSystemService(NotificationManager::class.java).notify(NOTIF_ID, builder(t).build())
            }
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    private fun text(u: WearUi): String {
        val k = u.keyIndex?.let { Harmony.camelot(it) } ?: "—"
        val b = u.shownBpm?.let { "%.1f".format(it) } ?: "—"
        return "$k · $b BPM"
    }

    private fun status(t: String) = Status.Builder().addTemplate("#t#").addPart("t", Status.TextPart(t)).build()

    private fun openApp(): PendingIntent = PendingIntent.getActivity(
        this, 0, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    private fun builder(content: String): NotificationCompat.Builder =
        NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_listen)
            .setContentTitle(getString(R.string.app_name))
            .setContentText(content)
            .setOngoing(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_STOPWATCH)
            .setContentIntent(openApp())
            .addAction(
                0, getString(R.string.stop),
                PendingIntent.getService(this, 1, intent(this).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE),
            )

    companion object {
        private const val CHANNEL = "listen"
        private const val NOTIF_ID = 7
        private const val ACTION_STOP = "ro.mixai.keybpm.wear.STOP"
        fun intent(ctx: Context) = Intent(ctx, WearListenService::class.java)
        fun createChannel(ctx: Context) {
            val nm = ctx.getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(NotificationChannel(CHANNEL, ctx.getString(R.string.channel_listen), NotificationManager.IMPORTANCE_LOW))
        }
    }
}
