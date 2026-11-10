package ro.mixai.live

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat

/**
 * Keeps the process (and the microphone) alive while the phone engine runs, so processing continues with the
 * screen off on stage. The engine itself lives in [LocalEngineHost]; this service only holds the foreground state
 * and its notification. Type `microphone` (Android 14+).
 */
class LocalEngineService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Always enter the foreground first: the service is started before the engine opens the mic, and a stop
        // that races the start must still satisfy startForegroundService (else RemoteServiceException).
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL, getString(R.string.local_notif_channel), NotificationManager.IMPORTANCE_LOW),
        )
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val n = NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_live)
            .setContentTitle(getString(R.string.local_notif_title))
            .setContentText(getString(R.string.local_notif_text))
            .setContentIntent(open)
            .setOngoing(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build()
        val type = if (Build.VERSION.SDK_INT >= 30) ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE else 0
        try {
            ServiceCompat.startForeground(this, ID, n, type)
        } catch (e: SecurityException) {
            // Microphone permission revoked between the tap and here: the engine start fails on its own.
            stopSelf()
        } catch (e: IllegalStateException) {
            stopSelf()
        }
        return START_NOT_STICKY
    }

    // Swiped away from recents: the user ended the session, release the mic.
    override fun onTaskRemoved(rootIntent: Intent?) {
        (application as LiveApp).local.stop()
        stopSelf()
    }

    private companion object {
        const val CHANNEL = "live-engine"
        const val ID = 21
    }
}
