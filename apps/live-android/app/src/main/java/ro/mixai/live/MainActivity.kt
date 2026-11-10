package ro.mixai.live

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.distinctUntilChangedBy
import kotlinx.coroutines.launch
import ro.mixai.live.core.Pairing
import ro.mixai.live.core.Phase
import ro.mixai.live.ui.LiveRoot
import ro.mixai.mobile.theme.MixaiTheme

class MainActivity : ComponentActivity() {
    private val app get() = application as LiveApp

    /** Pairing link from a deep link (mixai-live://pair?...) waiting to be applied by the UI. */
    val pendingLink = MutableStateFlow<String?>(null)

    private val localNet = registerForActivityResult(ActivityResultContracts.RequestPermission()) {}

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        setContent {
            MixaiTheme(mode = "dark") {
                LiveRoot(app = app, pendingLink = pendingLink)
            }
        }
        if (savedInstanceState == null) handle(intent)
        requestLocalNetwork()
        // Keep the screen on while connected (on stage the phone must not lock mid-song).
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                app.client.state.distinctUntilChangedBy { it.phase }.collect { s ->
                    if (s.phase == Phase.CONNECTED || s.phase == Phase.RECONNECTING) {
                        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                    } else {
                        window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                    }
                }
            }
        }
    }

    override fun onStart() {
        super.onStart()
        app.client.setMeters(true)
    }

    override fun onStop() {
        // Meters are 30 Hz traffic: pause them in the background, keep the control connection.
        app.client.setMeters(false)
        super.onStop()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handle(intent)
    }

    private fun handle(intent: Intent?) {
        val data = intent?.dataString ?: return
        if (Pairing.parse(data) != null) pendingLink.value = data
    }

    /** Android 17: ACCESS_LOCAL_NETWORK is a runtime permission once targetSdk >= 37 (declared now, asked when granted-able). */
    private fun requestLocalNetwork() {
        if (Build.VERSION.SDK_INT < 37) return
        val perm = "android.permission.ACCESS_LOCAL_NETWORK"
        if (ContextCompat.checkSelfPermission(this, perm) != PackageManager.PERMISSION_GRANTED) {
            runCatching { localNet.launch(perm) }
        }
    }

    companion object {
        const val CAMERA = Manifest.permission.CAMERA
    }
}
