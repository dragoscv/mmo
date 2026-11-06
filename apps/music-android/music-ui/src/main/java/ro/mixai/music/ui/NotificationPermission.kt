package ro.mixai.music.ui

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat

/** Asked at most once per process; a refusal never blocks playback (the notification is optional). */
private object NotificationAsk { @Volatile var asked = false }

/**
 * Returns a callback that asks POST_NOTIFICATIONS (Android 13+) in context, the first time music
 * starts. Call it right before `musicPlayback.play(...)`; it never waits for the answer.
 */
@Composable
fun rememberNotificationPermissionRequester(): () -> Unit {
    val context = LocalContext.current
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { }
    return remember(context, launcher) {
        {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && !NotificationAsk.asked) {
                NotificationAsk.asked = true
                val granted = ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
                if (!granted) runCatching { launcher.launch(Manifest.permission.POST_NOTIFICATIONS) }
            }
        }
    }
}
