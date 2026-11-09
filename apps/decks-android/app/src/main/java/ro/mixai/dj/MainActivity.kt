package ro.mixai.dj

import android.Manifest
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.DocumentsContract
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.Box
import androidx.compose.ui.Modifier
import ro.mixai.decks.ui.DecksController
import ro.mixai.decks.ui.i18n.Str
import ro.mixai.decks.ui.i18n.StringTable
import ro.mixai.decks.ui.platform.AndroidDecks
import ro.mixai.decks.ui.platform.AndroidMidi
import ro.mixai.decks.ui.platform.DecksAndroidRoot

/**
 * MixAI Decks (ro.mixai.dj). One activity, landscape or portrait; wide layout on tablets / ChromeOS.
 * The controller (and the native engine) lives as long as the activity instance; configChanges
 * keeps it across rotation / resize so audio never restarts.
 */
class MainActivity : ComponentActivity() {
    private lateinit var ctl: DecksController
    private var midi: AndroidMidi? = null

    private val pickFolder = registerForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri ->
        uri?.let { treeToPath(it) }?.let { ctl.scanFolder(it) }
    }
    private val askAudio = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) pickFolder.launch(null)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        ctl = DecksController(AndroidDecks.createBackend(this))
        midi = AndroidMidi(this, ctl).also { it.start() }
        val strings = strings()
        val reduced = AndroidDecks.reducedMotion(this)
        setContent {
            Box(Modifier.fillMaxSize().safeDrawingPadding()) {
                DecksAndroidRoot(ctl, strings, reduced, ::scanFolder)
            }
        }
    }

    private fun scanFolder() {
        val perm = if (Build.VERSION.SDK_INT >= 33) Manifest.permission.READ_MEDIA_AUDIO else Manifest.permission.READ_EXTERNAL_STORAGE
        if (checkSelfPermission(perm) == PackageManager.PERMISSION_GRANTED) pickFolder.launch(null) else askAudio.launch(perm)
    }

    /**
     * The Rust scanner reads plain file paths: map a SAF tree on primary storage
     * (`primary:Music/Sets`) to `/storage/emulated/0/Music/Sets`; other volumes to /storage/<id>/….
     */
    private fun treeToPath(uri: Uri): String? {
        val id = runCatching { DocumentsContract.getTreeDocumentId(uri) }.getOrNull() ?: return null
        val vol = id.substringBefore(':')
        val rel = id.substringAfter(':', "")
        val base = if (vol.equals("primary", true)) Environment.getExternalStorageDirectory().absolutePath else "/storage/$vol"
        return if (rel.isEmpty()) base else "$base/$rel"
    }

    /** Str keys → string resources `decks_<key>` (values / values-ro follow the system locale). */
    private fun strings(): StringTable = Str.entries.associate { s ->
        val id = resources.getIdentifier("decks_${s.key}", "string", packageName)
        s.key to if (id != 0) getString(id) else s.key
    }

    override fun onDestroy() {
        midi?.close()
        if (isFinishing) ctl.backend.close()
        super.onDestroy()
    }
}
