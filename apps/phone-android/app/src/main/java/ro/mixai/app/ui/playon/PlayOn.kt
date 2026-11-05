package ro.mixai.app.ui.playon

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.Spacer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Cast
import androidx.compose.material.icons.outlined.Tv
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import android.util.Log
import android.widget.Toast
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import ro.mixai.app.AppDeps
import ro.mixai.app.R
import ro.mixai.tv.data.HubClient
import ro.mixai.tv.data.MediaRef
import ro.mixai.tv.data.generated.HubDevice

private const val TAG = "MixaiPlayOn"

/** What to start on another device. */
data class PlayOnRequest(val fileId: String, val startSec: Double, val ref: MediaRef?, val title: String)

/** TVs / players on the hub that accept `play` (server `playbackTarget`, else form factor / caps). */
fun playbackTargets(devices: List<HubDevice>, myDeviceId: String?): List<HubDevice> =
    devices.filter { d ->
        d.deviceId != myDeviceId && !d.guest &&
            (d.playbackTarget ?: (d.formFactor == "tv" || d.platform == "android-tv" || d.platform == "tizen" || "play" in d.caps && d.formFactor != "phone"))
    }.distinctBy { it.deviceId }

/** TV devices that can be remote-controlled (`navigate` cap or TV form factor). */
fun remoteTargets(devices: List<HubDevice>, myDeviceId: String?): List<HubDevice> =
    devices.filter { d -> d.deviceId != myDeviceId && !d.guest && (d.formFactor == "tv" || "navigate" in d.caps && d.formFactor != "phone") }
        .distinctBy { it.deviceId }

/** A TV already playing `fileId` (handoff "pull back" source). */
fun deviceSessionFor(devices: List<HubDevice>, fileId: String, myDeviceId: String?): HubDevice? =
    devices.firstOrNull { it.deviceId != myDeviceId && it.nowPlaying?.media?.fileId == fileId }

/**
 * Sends hub `play {fileId,startSec,kind,tmdbId,season,episode,title}` and waits ≤ 5 s for the ack.
 * When the target is already in its player ([targetBusy]) it first sends `stop`: TV app 2.1.0 crashes with
 * "Session ID must be unique" when a `play` replaces a running player (tv PlayerScreen.kt:254).
 */
suspend fun sendPlay(hub: HubClient, target: String, req: PlayOnRequest, targetBusy: Boolean = false): Boolean? {
    if (targetBusy) {
        val stopSeq = hub.command(target, "stop")
        val stopAck = withTimeoutOrNull(4_000) { hub.acks.filter { it.seq == stopSeq }.first() }
        // The TV releases its MediaSession only after the player screen is fully gone: wait for its idle state
        // on the hub, then a margin, else the next `play` still hits the duplicate-session crash.
        val idle = withTimeoutOrNull(6_000) { hub.devices.filter { l -> l.none { it.deviceId == target && it.nowPlaying?.media != null } }.first() }
        Log.i(TAG, "stop -> $target before play ack=${stopAck?.ok} idle=${idle != null}")
        kotlinx.coroutines.delay(2_500)
    }
    val args = buildJsonObject {
        put("fileId", req.fileId)
        put("startSec", req.startSec)
        put("title", req.title)
        req.ref?.let { r ->
            put("kind", r.kind); put("tmdbId", r.tmdbId)
            r.season?.let { put("season", it) }; r.episode?.let { put("episode", it) }
        }
    }
    val seq = hub.command(target, "play", args)
    val ack = withTimeoutOrNull(5_000) { hub.acks.filter { it.seq == seq }.first() }
    Log.i(TAG, "play -> $target seq=$seq ack=${ack?.ok} err=${ack?.error}")
    return ack?.ok
}

/**
 * "Play on" sheet: devices on the same MMO Server hub that can play (TVs). Picking one sends `play` with the
 * current position; [onSent] lets the player pause itself (handoff "Continue on TV").
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PlayOnSheet(deps: AppDeps, request: PlayOnRequest, onDismiss: () -> Unit, onSent: (deviceId: String) -> Unit = {}) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val devices by deps.hub.devices.collectAsState()
    val myId = remember { mutableStateOf<String?>(null) }
    androidx.compose.runtime.LaunchedEffect(Unit) { myId.value = deps.settings.deviceId() }
    val targets = playbackTargets(devices, myId.value)
    var sending by remember { mutableStateOf<String?>(null) }
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(bottom = 16.dp)) {
            Text(stringResource(R.string.playon_title), style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(horizontal = 24.dp, vertical = 8.dp))
            if (targets.isEmpty()) {
                Text(
                    stringResource(R.string.playon_empty),
                    style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = 24.dp, vertical = 12.dp),
                )
            }
            targets.forEach { d ->
                ListItem(
                    headlineContent = { Text(d.name.ifBlank { d.platform }) },
                    supportingContent = {
                        val np = d.nowPlaying?.media?.title
                        Text(if (np != null) stringResource(R.string.playon_now_playing, np) else stringResource(R.string.playon_ready))
                    },
                    leadingContent = { Icon(if (d.formFactor == "tv") Icons.Outlined.Tv else Icons.Outlined.Cast, contentDescription = null) },
                    trailingContent = { if (sending == d.deviceId) CircularProgressIndicator() },
                    modifier = Modifier.clickable(enabled = sending == null) {
                        sending = d.deviceId
                        scope.launch {
                            val ok = sendPlay(deps.hub, d.deviceId, request, targetBusy = d.nowPlaying?.media != null)
                            sending = null
                            val msg = when (ok) {
                                true -> context.getString(R.string.playon_sent, d.name)
                                false -> context.getString(R.string.playon_refused, d.name)
                                null -> context.getString(R.string.playon_no_answer, d.name)
                            }
                            Toast.makeText(context, msg, Toast.LENGTH_SHORT).show()
                            if (ok == true) { onSent(d.deviceId); onDismiss() }
                        }
                    },
                )
            }
            Spacer(Modifier.height(8.dp))
        }
    }
}
