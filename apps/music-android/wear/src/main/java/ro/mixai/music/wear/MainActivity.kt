package ro.mixai.music.wear

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WearDownloadService.ensureChannel(this)
        val app = application as WearMusicApp
        setContent { WearTheme { WearRoot(app) } }
    }
}
