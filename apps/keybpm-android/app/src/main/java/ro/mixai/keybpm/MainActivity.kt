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
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.LibraryMusic
import androidx.compose.material.icons.filled.Speed
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
import ro.mixai.keybpm.ui.HistoryScreen
import ro.mixai.keybpm.ui.LibraryScreen
import ro.mixai.keybpm.ui.StageScreen
import ro.mixai.keybpm.ui.TempoScreen
import ro.mixai.keybpm.ui.TunerScreen
import ro.mixai.keybpm.data.SetLog
import ro.mixai.mobile.theme.MixaiTheme

class MainActivity : ComponentActivity() {
    private val model: ListenModel by viewModels()
    /** Set by the Identify widget; consumed once the permission check in [App] can start listening. */
    private val identifyRequest = androidx.compose.runtime.mutableIntStateOf(0)

    override fun onCreate(savedInstanceState: Bundle?) {
        installSplashScreen()
        super.onCreate(savedInstanceState)
        enableEdgeToEdge(statusBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT))
        if (savedInstanceState == null) handleAudioIntent(intent)
        setContent {
            MixaiTheme("system") {
                androidx.compose.runtime.CompositionLocalProvider(ro.mixai.mobile.LocalMobileConfig provides (application as KeyBpmApp).config) { App(model) }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleAudioIntent(intent)
    }

    private fun handleAudioIntent(intent: Intent?) {
        if (intent?.action == IdentifyWidget.ACTION_IDENTIFY) {
            identifyRequest.intValue++
            return
        }
        val uri: Uri? = when (intent?.action) {
            Intent.ACTION_VIEW -> intent.data
            Intent.ACTION_SEND -> androidx.core.content.IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)
            else -> null
        }
        if (uri != null) model.analyzeUri(uri)
    }

    @Composable
    private fun App(model: ListenModel) {
        val ui by model.ui.collectAsState()
        val entries by model.log.entries.collectAsState()
        var tab by rememberSaveable { mutableIntStateOf(0) }
        var stage by rememberSaveable { mutableStateOf(false) }
        var showRationale by remember { mutableStateOf(false) }
        var denied by remember { mutableStateOf(false) }
        val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
            val granted = result[Manifest.permission.RECORD_AUDIO] == true
            denied = !granted
            if (granted) model.start()
        }
        val perms = buildList {
            add(Manifest.permission.RECORD_AUDIO)
            // Android 13+: the ongoing listening notification needs POST_NOTIFICATIONS (listening works without it).
            if (android.os.Build.VERSION.SDK_INT >= 33) add(Manifest.permission.POST_NOTIFICATIONS)
        }.toTypedArray()
        val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
            if (uri != null) model.analyzeUri(uri)
        }
        val start = {
            when {
                ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED -> model.start()
                shouldShowRequestPermissionRationale(Manifest.permission.RECORD_AUDIO) -> showRationale = true
                else -> launcher.launch(perms)
            }
        }
        val identifyReq by identifyRequest
        androidx.compose.runtime.LaunchedEffect(identifyReq) {
            if (identifyReq == 0) return@LaunchedEffect
            tab = 0
            stage = false
            if (!ui.listening) start()
            model.identify()
        }
        // Keep the screen on while listening (stage use).
        DisposableEffect(ui.listening) {
            if (ui.listening) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            onDispose { }
        }
        if (stage) {
            StageScreen(ui, model::cycleTempo, model::dismissKeyChange, onExit = { stage = false })
            return
        }
        Scaffold(
            bottomBar = {
                NavigationBar {
                    NavigationBarItem(tab == 0, { tab = 0 }, { Icon(Icons.Filled.GraphicEq, null) }, label = { Text(stringResource(R.string.tab_live)) })
                    NavigationBarItem(tab == 1, { tab = 1 }, { Icon(Icons.Filled.Tune, null) }, label = { Text(stringResource(R.string.tab_tuner)) })
                    NavigationBarItem(tab == 4, { tab = 4 }, { Icon(Icons.Filled.Speed, null) }, label = { Text(stringResource(R.string.tab_tempo)) })
                    NavigationBarItem(tab == 2, { tab = 2 }, { Icon(Icons.Filled.History, null) }, label = { Text(stringResource(R.string.tab_history)) })
                    NavigationBarItem(tab == 3, { tab = 3 }, { Icon(Icons.Filled.LibraryMusic, null) }, label = { Text(stringResource(R.string.tab_library)) })
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
                            TextButton(onClick = { showRationale = false; launcher.launch(perms) }) {
                                Text(stringResource(R.string.mic_allow))
                            }
                        },
                    )
                }
                when (tab) {
                    0 -> LiveScreen(
                        ui, start, model::stop, model::again, model::cycleTempo, model::setNotation, { picker.launch(arrayOf("audio/*")) }, { model.save() },
                        onStage = { stage = true }, onIdentify = model::identify, onTracklist = model::setTracklistMode, onAddToQueue = model::addToQueue,
                    )
                    1 -> TunerScreen(ui, start, model::stop, model::setA4)
                    2 -> HistoryScreen(entries, ui.notation, { format -> shareExport(entries, format) }, model::deleteEntry, model::clearLog)
                    4 -> TempoScreen((application as KeyBpmApp).midi, ui.bpm)
                    else -> LibraryScreen(
                        settings = (application as KeyBpmApp).settings,
                        camelot = ui.snapshot?.key?.key?.camelot ?: entries.firstOrNull()?.camelot,
                        bpm = ui.snapshot?.tempo?.let { it.bpm * ui.tempoFactor } ?: entries.firstOrNull()?.bpm,
                        notation = ui.notation,
                    )
                }
            }
        }
    }

    /** Set log / tracklist export through the share sheet (CSV, text, M3U8, rekordbox XML). */
    private fun shareExport(entries: List<ro.mixai.keybpm.data.LogEntry>, format: ro.mixai.keybpm.ui.ExportFormat) {
        val day = java.time.LocalDate.now()
        val dir = java.io.File(cacheDir, "exports").apply { mkdirs() }
        val title = getString(R.string.export_title) + " $day"
        val (name, mime, body) = when (format) {
            ro.mixai.keybpm.ui.ExportFormat.CSV -> Triple("mixai-setlog-$day.csv", "text/csv", SetLog.toCsv(entries))
            ro.mixai.keybpm.ui.ExportFormat.TEXT -> Triple("mixai-tracklist-$day.txt", "text/plain", ro.mixai.keybpm.data.TracklistExport.text(entries))
            ro.mixai.keybpm.ui.ExportFormat.M3U8 -> Triple("mixai-tracklist-$day.m3u8", "audio/x-mpegurl", ro.mixai.keybpm.data.TracklistExport.m3u8(entries))
            ro.mixai.keybpm.ui.ExportFormat.REKORDBOX -> Triple("mixai-tracklist-$day.xml", "text/xml", ro.mixai.keybpm.data.TracklistExport.rekordboxXml(entries, title))
        }
        val f = java.io.File(dir, name)
        f.writeText(body)
        val uri = androidx.core.content.FileProvider.getUriForFile(this, "$packageName.files", f)
        val send = Intent(Intent.ACTION_SEND).setType(mime).putExtra(Intent.EXTRA_STREAM, uri)
            .putExtra(Intent.EXTRA_SUBJECT, title).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        // Plain text also goes in EXTRA_TEXT so it pastes straight into a description field.
        if (format == ro.mixai.keybpm.ui.ExportFormat.TEXT) send.putExtra(Intent.EXTRA_TEXT, body)
        startActivity(Intent.createChooser(send, getString(R.string.history_export)))
    }
}
