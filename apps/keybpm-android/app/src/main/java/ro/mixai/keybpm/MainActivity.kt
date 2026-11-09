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
import androidx.compose.material.icons.filled.MusicNote
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
import ro.mixai.keybpm.ui.drawTimeline
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.withTransform
import ro.mixai.keybpm.data.SetLog
import ro.mixai.mobile.theme.MixaiTheme

class MainActivity : ComponentActivity() {
    private val model: ListenModel by viewModels()
    /** Set by the Identify widget; consumed once the permission check in [App] can start listening. */
    private val identifyRequest = androidx.compose.runtime.mutableIntStateOf(0)
    /** Set by the Quick Settings tile. */
    private val listenRequest = androidx.compose.runtime.mutableIntStateOf(0)
    /** Set by the "What key is this?" shortcut / Assistant App Action. */
    private val whatKeyRequest = androidx.compose.runtime.mutableIntStateOf(0)

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
        if (intent?.action == ListenTileService.ACTION_LISTEN) {
            listenRequest.intValue++
            return
        }
        if (intent?.action == ACTION_WHAT_KEY) {
            whatKeyRequest.intValue++
            return
        }
        // Assistant OPEN_APP_FEATURE fulfilled through the capability intent (VIEW + "feature" extra, no data).
        if (intent?.action == Intent.ACTION_VIEW && intent.data == null) {
            when (intent.getStringExtra("feature")?.lowercase()) {
                "listen" -> listenRequest.intValue++
                "identify song", "identify" -> identifyRequest.intValue++
                "what key" -> whatKeyRequest.intValue++
            }
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
        val listenReq by listenRequest
        androidx.compose.runtime.LaunchedEffect(listenReq) {
            if (listenReq == 0) return@LaunchedEffect
            tab = 0
            if (!ui.listening) start()
        }
        val whatKeyReq by whatKeyRequest
        androidx.compose.runtime.LaunchedEffect(whatKeyReq) {
            if (whatKeyReq == 0) return@LaunchedEffect
            tab = 0
            stage = false
            model.requestWhatKey()
            if (!ui.listening) start()
        }
        // Keep the screen on while listening (stage use).
        DisposableEffect(ui.listening) {
            if (ui.listening) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            onDispose { }
        }
        if (stage) {
            StageScreen(
                ui, model::cycleTempo, model::dismissKeyChange, onExit = { stage = false },
                onNight = model::setStageNight, onDnd = model::setStageDnd,
            )
            return
        }
        Scaffold(
            bottomBar = {
                NavigationBar {
                    NavigationBarItem(tab == 0, { tab = 0 }, { Icon(Icons.Filled.GraphicEq, null) }, label = { Text(stringResource(R.string.tab_live)) })
                    NavigationBarItem(tab == 1, { tab = 1 }, { Icon(Icons.Filled.Tune, null) }, label = { Text(stringResource(R.string.tab_tuner)) })
                    NavigationBarItem(tab == 4, { tab = 4 }, { Icon(Icons.Filled.Speed, null) }, label = { Text(stringResource(R.string.tab_tempo)) })
                    NavigationBarItem(tab == 2, { tab = 2 }, { Icon(Icons.Filled.History, null) }, label = { Text(stringResource(R.string.tab_history)) })
                    NavigationBarItem(tab == 5, { tab = 5 }, { Icon(Icons.Filled.MusicNote, null) }, label = { Text(stringResource(R.string.tab_practice)) })
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
                    4 -> TempoScreen(
                        (application as KeyBpmApp).midi, ui.bpm,
                        drift = ro.mixai.keybpm.ui.DriftState(ui.driftAlarm, ui.driftReference, ui.drift),
                        onDriftAlarm = model::setDriftAlarm, onDriftReference = model::setDriftReference,
                    )
                    5 -> ro.mixai.keybpm.ui.PracticeScreen(ui, entries, start, model::stop, model::setAnnounceKey, onShareTimeline = ::shareTimeline)
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

    /** Set timeline as a 1080x1350 PNG (key colour band + BPM line + header), shared through the share sheet. */
    private fun shareTimeline() {
        val points = model.log.entries.value.sortedBy { it.atMillis }.takeLast(60)
        if (points.size < 2) return
        val w = 1080
        val h = 1350
        val bmp = android.graphics.Bitmap.createBitmap(w, h, android.graphics.Bitmap.Config.ARGB_8888)
        val canvas = androidx.compose.ui.graphics.Canvas(bmp.asImageBitmap())
        val draw = androidx.compose.ui.graphics.drawscope.CanvasDrawScope()
        val density = androidx.compose.ui.unit.Density(resources.displayMetrics.density)
        draw.draw(density, androidx.compose.ui.unit.LayoutDirection.Ltr, canvas, androidx.compose.ui.geometry.Size(w.toFloat(), h.toFloat())) {
            drawRect(ro.mixai.mobile.theme.Tokens.background)
            withTransform({ translate(60f, 320f) }) {
                drawTimeline(points, ro.mixai.mobile.theme.Tokens.foreground, androidx.compose.ui.geometry.Size(w - 120f, h - 480f))
            }
        }
        val paint = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply { color = android.graphics.Color.WHITE; textSize = 64f; isFakeBoldText = true }
        val c = android.graphics.Canvas(bmp)
        c.drawText(getString(R.string.timeline_title), 60f, 140f, paint)
        paint.textSize = 40f; paint.isFakeBoldText = false; paint.alpha = 190
        val first = points.first()
        val last = points.last()
        c.drawText("${first.camelot} → ${last.camelot} · ${"%.0f".format(first.bpm)} → ${"%.0f".format(last.bpm)} BPM · ${points.size}", 60f, 220f, paint)
        c.drawText("MixAI Key & BPM", 60f, h - 70f, paint)
        val dir = java.io.File(cacheDir, "exports").apply { mkdirs() }
        val f = java.io.File(dir, "mixai-timeline-${java.time.LocalDate.now()}.png")
        f.outputStream().use { bmp.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
        bmp.recycle()
        val uri = androidx.core.content.FileProvider.getUriForFile(this, "$packageName.files", f)
        val send = Intent(Intent.ACTION_SEND).setType("image/png").putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        startActivity(Intent.createChooser(send, getString(R.string.timeline_share)))
    }

    companion object {
        /** "What key is this?" static shortcut + Assistant OPEN_APP_FEATURE "what key". */
        const val ACTION_WHAT_KEY = "ro.mixai.keybpm.WHAT_KEY"
    }
}
