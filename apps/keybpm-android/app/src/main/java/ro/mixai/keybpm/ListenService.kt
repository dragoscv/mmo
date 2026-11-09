package ro.mixai.keybpm

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.sample
import kotlinx.coroutines.launch
import uniffi.mixai_listen_ffi.compatibleKeys
import uniffi.mixai_listen_ffi.keyLabel

/**
 * Foreground service type `microphone` (WP18-18/20): keeps live listening alive with the screen off or another app
 * in front, and shows the current key + BPM in an ongoing notification with Stop / Save actions. Started by
 * [ListenSession.start] while the activity is visible (Android 14 while-in-use rule), stopped by [ListenSession.stop].
 */
class ListenService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val session = (application as KeyBpmApp).session
        when (intent?.action) {
            ACTION_STOP -> { session.stop(); return START_NOT_STICKY }
            ACTION_SAVE -> session.save()
        }
        val started = runCatching {
            ServiceCompat.startForeground(this, NOTIFICATION_ID, build(null), ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
        }
        if (started.isFailure) {
            // Not allowed from the background (or the mic permission was revoked): stop rather than crash.
            stopSelf()
            return START_NOT_STICKY
        }
        if (intent?.action == null) {
            scope.launch {
                session.ui
                    .sample(1_000)
                    .map { u -> if (u.listening) content(u) else null }
                    .distinctUntilChanged()
                    .collect { t ->
                        if (t == null) stopSelf()
                        else getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, build(t))
                    }
            }
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    /** Ongoing notification text: reading, the "Next:" mix line and the short Camelot chip for the Live Update. */
    private data class Content(val text: String, val next: String?, val camelot: String?)

    private fun content(u: ListenUi): Content {
        val k = u.snapshot?.key ?: return Content(getString(R.string.notif_waiting), null, null)
        val label = keyLabel(k.key.index, u.notation)
        val text = u.bpm?.let { getString(R.string.notif_reading, label, "%.1f".format(it)) } ?: label
        val next = runCatching {
            val keys = MixNext.nextKeysForNotification(compatibleKeys(k.key.index).map { it.relation to it.key.index.toInt() })
            MixNext.joinLabels(keys.map { keyLabel(it.toUByte(), u.notation) })
        }.getOrNull()
        return Content(text, next?.let { getString(R.string.notif_next, it) }, k.key.camelot)
    }

    private fun build(content: Content?): Notification {
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val text = content?.text ?: getString(R.string.notif_waiting)
        val b = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_listen)
            .setContentTitle(getString(R.string.notif_listening))
            .setContentText(text)
            .setContentIntent(open)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .addAction(0, getString(R.string.notif_save), action(ACTION_SAVE, 1))
            .addAction(0, getString(R.string.notif_stop), action(ACTION_STOP, 2))
        content?.next?.let { b.setStyle(NotificationCompat.BigTextStyle().bigText("$text\n$it")) }
        // Android 16 Live Update: promoted ongoing chip with the Camelot key in the status bar.
        if (Build.VERSION.SDK_INT >= 36) {
            b.setRequestPromotedOngoing(true)
            content?.camelot?.let { b.setShortCriticalText(it) }
        }
        return b.build()
    }

    private fun action(name: String, code: Int): PendingIntent =
        PendingIntent.getService(this, code, Intent(this, ListenService::class.java).setAction(name), PendingIntent.FLAG_IMMUTABLE)

    companion object {
        private const val CHANNEL_ID = "listen"
        private const val NOTIFICATION_ID = 18
        private const val ACTION_STOP = "ro.mixai.keybpm.STOP"
        private const val ACTION_SAVE = "ro.mixai.keybpm.SAVE"

        fun intent(ctx: Context) = Intent(ctx, ListenService::class.java)

        fun createChannel(ctx: Context) {
            val ch = NotificationChannel(CHANNEL_ID, ctx.getString(R.string.notif_channel), NotificationManager.IMPORTANCE_LOW)
            ch.setShowBadge(false)
            ctx.getSystemService(NotificationManager::class.java).createNotificationChannel(ch)
        }
    }
}
