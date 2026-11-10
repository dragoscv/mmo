package ro.mixai.live.wear

import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.flow.distinctUntilChangedBy
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import ro.mixai.live.core.Phase

class MainActivity : ComponentActivity() {
    private val app get() = application as LiveWearApp

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { WearTheme { WearRoot(app) } }
        lifecycleScope.launch {
            if (app.client.state.value.phase == Phase.IDLE) app.store.engines.first().firstOrNull()?.let { app.client.connect(it) }
        }
        // Keep the watch screen on while connected (performers glance at it between songs).
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                app.client.state.distinctUntilChangedBy { it.phase }.collect { s ->
                    if (s.phase == Phase.CONNECTED) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                    else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                }
            }
        }
    }

    override fun onStart() {
        super.onStart()
        app.client.setMeters(true)
    }

    override fun onStop() {
        app.client.setMeters(false)
        super.onStop()
    }
}
