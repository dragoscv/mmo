package ro.mixai.app.push

import android.Manifest
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await
import ro.mixai.app.MainActivity
import ro.mixai.app.MixaiPhoneApp
import ro.mixai.app.R

/**
 * FCM: token refresh → `POST /api/push/register` (Bearer native session); messages → localised channel +
 * deep link from `data.deepLink` (mixai://title/..., https://mixai.ro/media/..., mixai://downloads).
 * Logcat tag `MixaiPush` (never logs the token).
 */
class PushService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        Log.i(TAG, "new FCM token (len ${token.length})")
        PushRegistrar.onToken(applicationContext, token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val data = message.data
        val title = message.notification?.title ?: data["title"] ?: return
        val body = message.notification?.body ?: data["body"] ?: ""
        val link = data["deepLink"] ?: message.notification?.link?.toString()
        val channel = Channels.forEvent(data["event"])
        Log.i(TAG, "message event=${data["event"]} channel=$channel link=${link != null}")
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) return
        val intent = Intent(this, MainActivity::class.java).apply {
            action = Intent.ACTION_VIEW
            if (link != null) setData(Uri.parse(link))
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        }
        val pi = PendingIntent.getActivity(this, (data["eventId"] ?: title).hashCode(), intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val n = NotificationCompat.Builder(this, channel)
            .setSmallIcon(R.drawable.ic_stat_mixai)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .setContentIntent(pi)
            .build()
        runCatching { NotificationManagerCompat.from(this).notify((data["eventId"] ?: title).hashCode(), n) }
    }

    companion object { const val TAG = "MixaiPush" }
}

/** Registers the FCM token with the web once per (token, user). Skipped (logged) when not signed in. */
object PushRegistrar {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    fun onToken(context: Context, token: String) {
        val app = context.applicationContext as MixaiPhoneApp
        scope.launch {
            app.phone.settings.setPushToken(token)
            register(context, force = true)
        }
    }

    /** Fetches the current token (if needed) and registers it. Call after sign-in/pair and on app start. */
    fun sync(context: Context) {
        scope.launch {
            val app = context.applicationContext as MixaiPhoneApp
            val token = runCatching { FirebaseMessaging.getInstance().token.await() }
                .onFailure { Log.w(PushService.TAG, "FCM token unavailable: ${it.javaClass.simpleName} ${it.message}") }
                .getOrNull() ?: return@launch
            app.phone.settings.setPushToken(token)
            register(context, force = false)
        }
    }

    suspend fun register(context: Context, force: Boolean): Int? {
        val app = context.applicationContext as MixaiPhoneApp
        val token = app.phone.settings.pushToken.first()
        if (token.isBlank()) return null
        val session = app.settings.session.first()
        val bearer = app.phone.vault.read()
        if (!session.isSignedIn || bearer.isBlank()) {
            Log.i(PushService.TAG, "push register skipped: not signed in to a MixAI account")
            return null
        }
        val stamp = "${token.hashCode()}:${session.userId}"
        if (!force && app.phone.settings.pushRegisteredFor() == stamp) {
            Log.i(PushService.TAG, "push already registered for this token/user")
            return 200
        }
        val profile = app.settings.activeProfile.first().id.ifBlank { null }
        val name = app.settings.deviceName.first().ifBlank { Build.MODEL ?: "Android" }
        val code = runCatching { app.phone.web.registerPush(bearer, token, name, profile) }
            .onFailure { Log.w(PushService.TAG, "push register error: ${it.javaClass.simpleName}") }
            .getOrNull()
        Log.i(PushService.TAG, "push register -> HTTP $code (${app.phone.web.origin})")
        if (code == 200) app.phone.settings.setPushRegisteredFor(stamp)
        return code
    }

    suspend fun unregister(context: Context) {
        val app = context.applicationContext as MixaiPhoneApp
        val token = app.phone.settings.pushToken.first()
        val bearer = app.phone.vault.read()
        if (token.isBlank() || bearer.isBlank()) return
        val code = runCatching { app.phone.web.unregisterPush(bearer, token) }.getOrNull()
        Log.i(PushService.TAG, "push unregister -> HTTP $code")
        app.phone.settings.setPushRegisteredFor("")
    }
}
