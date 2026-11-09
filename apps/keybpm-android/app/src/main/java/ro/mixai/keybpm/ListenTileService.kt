package ro.mixai.keybpm

import android.app.PendingIntent
import android.content.Intent
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

/**
 * Quick Settings tile (WP18 round 2): shows the live key + BPM while listening; tap = stop when listening, else
 * open the app and start (the microphone FGS can only start from a visible activity, so the tile launches it).
 */
class ListenTileService : TileService() {
    private var job: Job? = null
    private val session get() = (application as KeyBpmApp).session

    override fun onStartListening() {
        super.onStartListening()
        job = CoroutineScope(Dispatchers.Main).launch {
            session.ui.map { Triple(it.listening, it.snapshot?.key?.key?.camelot, it.bpm?.let { b -> "%.1f".format(b) }) }
                .distinctUntilChanged()
                .collect { (on, key, bpm) -> render(on, key, bpm) }
        }
    }

    override fun onStopListening() {
        job?.cancel()
        job = null
        super.onStopListening()
    }

    override fun onClick() {
        super.onClick()
        if (session.ui.value.listening) {
            session.stop()
            return
        }
        val open = Intent(this, MainActivity::class.java).setAction(ACTION_LISTEN).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val pi = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        startActivityAndCollapse(pi)
    }

    private fun render(listening: Boolean, key: String?, bpm: String?) {
        val t = qsTile ?: return
        t.state = if (listening) Tile.STATE_ACTIVE else Tile.STATE_INACTIVE
        t.label = getString(R.string.qs_listen)
        t.subtitle = if (listening) getString(R.string.qs_listening, key ?: "—", bpm ?: "—") else null
        t.updateTile()
    }

    companion object {
        const val ACTION_LISTEN = "ro.mixai.keybpm.LISTEN"
    }
}
