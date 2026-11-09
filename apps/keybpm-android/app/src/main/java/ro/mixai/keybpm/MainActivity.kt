package ro.mixai.keybpm

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.GraphicEq
import androidx.compose.material.icons.filled.Tune
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.core.content.ContextCompat
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import ro.mixai.keybpm.ui.LiveScreen
import ro.mixai.keybpm.ui.TunerScreen
import ro.mixai.mobile.theme.MixaiTheme

class MainActivity : ComponentActivity() {
    private val model: ListenModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        installSplashScreen()
        super.onCreate(savedInstanceState)
        enableEdgeToEdge(statusBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT))
        setContent { MixaiTheme("system") { App(model) } }
    }

    override fun onStop() {
        super.onStop()
        // No background listening yet (WP18-18 adds the microphone foreground service): stop with the UI.
        if (!isChangingConfigurations) model.stop()
    }

    @Composable
    private fun App(model: ListenModel) {
        val ui by model.ui.collectAsState()
        var tab by rememberSaveable { mutableIntStateOf(0) }
        var showRationale by remember { mutableStateOf(false) }
        var denied by remember { mutableStateOf(false) }
        val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            denied = !granted
            if (granted) model.start()
        }
        val start = {
            when {
                ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED -> model.start()
                shouldShowRequestPermissionRationale(Manifest.permission.RECORD_AUDIO) -> showRationale = true
                else -> launcher.launch(Manifest.permission.RECORD_AUDIO)
            }
        }
        // Keep the screen on while listening (stage use).
        DisposableEffect(ui.listening) {
            if (ui.listening) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            onDispose { }
        }
        Scaffold(
            bottomBar = {
                NavigationBar {
                    NavigationBarItem(tab == 0, { tab = 0 }, { Icon(Icons.Filled.GraphicEq, null) }, label = { Text(stringResource(R.string.tab_live)) })
                    NavigationBarItem(tab == 1, { tab = 1 }, { Icon(Icons.Filled.Tune, null) }, label = { Text(stringResource(R.string.tab_tuner)) })
                }
            },
        ) { pad ->
            Column(Modifier.fillMaxSize().padding(pad)) {
                if (denied || ui.micFailed) {
                    AlertDialog(
                        onDismissRequest = { denied = false; model.dismissKeyChange() },
                        text = { Text(stringResource(R.string.mic_denied)) },
                        confirmButton = {
                            TextButton(onClick = {
                                denied = false
                                startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", packageName, null)))
                            }) { Text(stringResource(R.string.open_settings)) }
                        },
                    )
                }
                if (showRationale) {
                    AlertDialog(
                        onDismissRequest = { showRationale = false },
                        title = { Text(stringResource(R.string.mic_rationale_title)) },
                        text = { Text(stringResource(R.string.mic_rationale)) },
                        confirmButton = {
                            TextButton(onClick = { showRationale = false; launcher.launch(Manifest.permission.RECORD_AUDIO) }) {
                                Text(stringResource(R.string.mic_allow))
                            }
                        },
                    )
                }
                when (tab) {
                    0 -> LiveScreen(ui, start, model::stop, model::again, model::cycleTempo, model::setNotation)
                    else -> TunerScreen(ui, start, model::stop, model::setA4)
                }
            }
        }
    }
}
