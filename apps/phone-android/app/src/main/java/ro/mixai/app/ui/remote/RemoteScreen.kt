package ro.mixai.app.ui.remote

import android.util.Log
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.outlined.Tv
import androidx.compose.material3.AssistChip
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import ro.mixai.app.AppDeps
import ro.mixai.app.R
import ro.mixai.app.nav.Navigator
import ro.mixai.app.ui.components.EmptyState
import ro.mixai.app.ui.playon.remoteTargets
import ro.mixai.tv.data.HubStatus
import ro.mixai.tv.data.generated.HubDevice
import ro.mixai.tv.data.generated.HubNowPlaying

private const val TAG = "MixaiRemote"
private const val ACK_TIMEOUT_MS = 4_000L

/** Result of the last command, shown under the controls. */
private sealed interface CmdStatus {
	data object Sending : CmdStatus
	data object Sent : CmdStatus
	data class Failed(val error: String) : CmdStatus
	data object NoAnswer : CmdStatus
}

/**
 * Phone as a TV remote (WP16-46). Only actions the TV handles in its hub command switch are sent:
 * play / pause / resume / seek / stop / next / previous / text / navigate.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RemoteScreen(deps: AppDeps, nav: Navigator, deviceId: String?) {
	val devices by deps.hub.devices.collectAsState()
	val hubStatus by deps.hub.status.collectAsState()
	var myId by remember { mutableStateOf<String?>(null) }
	LaunchedEffect(Unit) { myId = deps.settings.deviceId() }
	val tvs = remoteTargets(devices, myId)
	var selectedId by remember { mutableStateOf(deviceId) }
	val target = tvs.firstOrNull { it.deviceId == selectedId } ?: tvs.firstOrNull()

	val scope = rememberCoroutineScope()
	val haptics = LocalHapticFeedback.current
	var status by remember { mutableStateOf<CmdStatus?>(null) }

	fun send(action: String, args: JsonObject = JsonObject(emptyMap())) {
		val to = target?.deviceId ?: return
		haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
		status = CmdStatus.Sending
		scope.launch {
			val seq = deps.hub.command(to, action, args)
			val ack = withTimeoutOrNull(ACK_TIMEOUT_MS) { deps.hub.acks.filter { it.seq == seq }.first() }
			Log.i(TAG, "cmd $action -> $to seq=$seq ack=${ack?.ok}")
			status = when {
				ack == null -> CmdStatus.NoAnswer
				ack.ok -> CmdStatus.Sent
				else -> CmdStatus.Failed(ack.error ?: "error")
			}
		}
	}

	Scaffold(
		topBar = {
			TopAppBar(
				title = { Text(stringResource(R.string.remote_title)) },
				navigationIcon = {
					IconButton(onClick = { nav.pop() }) {
						Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.remote_back))
					}
				},
			)
		},
	) { padding ->
		if (target == null) {
			EmptyState(
				icon = Icons.Outlined.Tv,
				title = stringResource(R.string.remote_empty_title),
				hint = stringResource(R.string.remote_empty_hint),
				modifier = Modifier.padding(padding),
			) {
				Text(
					stringResource(R.string.remote_hub_status, hubStatusLabel(hubStatus)),
					style = MaterialTheme.typography.bodySmall,
					color = MaterialTheme.colorScheme.onSurfaceVariant,
				)
			}
			return@Scaffold
		}
		Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.TopCenter) {
			RemoteControls(
				tvs = tvs,
				target = target,
				status = status,
				onSelect = { selectedId = it },
				send = ::send,
				modifier = Modifier.widthIn(max = 560.dp),
			)
		}
	}
}

@Composable
private fun RemoteControls(
	tvs: List<HubDevice>,
	target: HubDevice,
	status: CmdStatus?,
	onSelect: (String) -> Unit,
	send: (String, JsonObject) -> Unit,
	modifier: Modifier = Modifier,
) {
	val np = target.nowPlaying
	val playing = np?.playing == true
	val togglePlay = { send(if (playing) "pause" else "resume", JsonObject(emptyMap())) }

	Column(
		modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp),
		verticalArrangement = Arrangement.spacedBy(12.dp),
	) {
		if (tvs.size > 1) {
			Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
				tvs.forEach { tv ->
					FilterChip(
						selected = tv.deviceId == target.deviceId,
						onClick = { onSelect(tv.deviceId) },
						label = { Text(tv.name.ifBlank { tv.deviceId }) },
						leadingIcon = { Icon(Icons.Outlined.Tv, contentDescription = null) },
					)
				}
			}
		} else {
			Text(target.name.ifBlank { target.deviceId }, style = MaterialTheme.typography.titleMedium)
		}

		NowPlayingLine(np)

		Touchpad(np = np, onToggle = togglePlay, send = send)

		Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
			FilledTonalButton(onClick = { send("stop", JsonObject(emptyMap())) }, modifier = Modifier.weight(1f)) {
				Icon(Icons.Filled.Stop, contentDescription = null)
				Text(stringResource(R.string.remote_stop), Modifier.padding(start = 6.dp))
			}
			FilledTonalButton(onClick = { send("navigate", buildJsonObject { put("to", "home") }) }, modifier = Modifier.weight(1f)) {
				Icon(Icons.Filled.Home, contentDescription = null)
				Text(stringResource(R.string.remote_home), Modifier.padding(start = 6.dp))
			}
			FilledTonalButton(onClick = togglePlay, modifier = Modifier.weight(1f)) {
				Icon(if (playing) Icons.Filled.Pause else Icons.Filled.PlayArrow, contentDescription = null)
				Text(stringResource(if (playing) R.string.remote_pause else R.string.remote_play), Modifier.padding(start = 6.dp))
			}
		}

		val shortcuts = listOf(
			"movies" to R.string.remote_go_movies,
			"shows" to R.string.remote_go_shows,
			"music" to R.string.remote_go_music,
			"livetv" to R.string.remote_go_livetv,
			"search" to R.string.remote_go_search,
		)
		Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
			shortcuts.forEach { (to, label) ->
				AssistChip(onClick = { send("navigate", buildJsonObject { put("to", to) }) }, label = { Text(stringResource(label)) })
			}
		}

		// Volume: the TV hub command switch has no `volume` action today, so no volume control is shown.

		var text by remember { mutableStateOf("") }
		val sendText = {
			val v = text.trim()
			if (v.isNotEmpty()) { send("text", buildJsonObject { put("value", v) }); text = "" }
		}
		OutlinedTextField(
			value = text,
			onValueChange = { text = it },
			label = { Text(stringResource(R.string.remote_text_label)) },
			singleLine = true,
			keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
			keyboardActions = KeyboardActions(onSend = { sendText() }),
			trailingIcon = {
				IconButton(onClick = sendText, enabled = text.isNotBlank()) {
					Icon(Icons.AutoMirrored.Filled.Send, contentDescription = stringResource(R.string.remote_text_send))
				}
			},
			modifier = Modifier.fillMaxWidth(),
		)

		StatusLine(status)
	}
}

@Composable
private fun NowPlayingLine(np: HubNowPlaying?) {
	val line = if (np == null) {
		stringResource(R.string.remote_idle)
	} else {
		val title = np.media?.title?.takeIf { it.isNotBlank() } ?: stringResource(R.string.remote_untitled)
		val dur = np.durationSec ?: np.media?.durationSec
		if (dur != null && dur > 0) {
			stringResource(R.string.remote_now_playing, title, RemoteMath.formatClock(np.positionSec), RemoteMath.formatClock(dur))
		} else {
			stringResource(R.string.remote_now_playing_noduration, title, RemoteMath.formatClock(np.positionSec))
		}
	}
	Text(
		line,
		style = MaterialTheme.typography.bodyMedium,
		color = MaterialTheme.colorScheme.onSurfaceVariant,
		maxLines = 2,
		overflow = TextOverflow.Ellipsis,
	)
}

/**
 * Gesture pad. The TV has no D-pad passthrough: a `key {code}` action (DPAD_LEFT, DPAD_CENTER, BACK, HOME, ...)
 * would need a new case in the TV hub command switch, which is out of scope here. So swipes map to
 * transport actions only: left/right = seek -/+ 10 s, up = next, down = previous, tap = play/pause.
 */
@Composable
private fun Touchpad(np: HubNowPlaying?, onToggle: () -> Unit, send: (String, JsonObject) -> Unit) {
	val thresholdPx = with(LocalDensity.current) { 48.dp.toPx() }
	val latestNp by rememberUpdatedState(np)
	val latestToggle by rememberUpdatedState(onToggle)
	val latestSend by rememberUpdatedState(send)
	val padLabel = stringResource(R.string.remote_touchpad)
	Box(
		Modifier
			.fillMaxWidth()
			.heightIn(min = 240.dp)
			.clip(RoundedCornerShape(24.dp))
			.background(MaterialTheme.colorScheme.surfaceContainerHigh)
			.semantics { contentDescription = padLabel }
			.pointerInput(Unit) { detectTapGestures(onTap = { latestToggle() }) }
			.pointerInput(thresholdPx) {
				var acc = Offset.Zero
				detectDragGestures(
					onDragStart = { acc = Offset.Zero },
					onDragCancel = { acc = Offset.Zero },
					onDragEnd = {
						val swipe = RemoteMath.classifySwipe(acc.x, acc.y, thresholdPx)
						acc = Offset.Zero
						val cur = latestNp
						when (swipe) {
							Swipe.Left, Swipe.Right -> {
								val pos = cur?.positionSec ?: 0.0
								val delta = if (swipe == Swipe.Left) -RemoteMath.SEEK_STEP_SEC else RemoteMath.SEEK_STEP_SEC
								val dur = cur?.durationSec ?: cur?.media?.durationSec
								val to = RemoteMath.seekTarget(pos, delta, dur)
								latestSend("seek", buildJsonObject { put("positionSec", to) })
							}
							Swipe.Up -> latestSend("next", JsonObject(emptyMap()))
							Swipe.Down -> latestSend("previous", JsonObject(emptyMap()))
							Swipe.None -> Unit
						}
					},
				) { change, drag ->
					change.consume()
					acc += drag
				}
			},
		contentAlignment = Alignment.Center,
	) {
		Text(
			stringResource(R.string.remote_touchpad_hint),
			style = MaterialTheme.typography.bodyMedium,
			color = MaterialTheme.colorScheme.onSurfaceVariant,
			textAlign = TextAlign.Center,
			modifier = Modifier.padding(24.dp),
		)
	}
}

@Composable
private fun StatusLine(status: CmdStatus?) {
	val text = when (status) {
		null -> return
		CmdStatus.Sending -> stringResource(R.string.remote_status_sending)
		CmdStatus.Sent -> stringResource(R.string.remote_status_sent)
		is CmdStatus.Failed -> stringResource(R.string.remote_status_error, status.error)
		CmdStatus.NoAnswer -> stringResource(R.string.remote_status_noanswer)
	}
	val color = when (status) {
		is CmdStatus.Failed, CmdStatus.NoAnswer -> MaterialTheme.colorScheme.error
		else -> MaterialTheme.colorScheme.onSurfaceVariant
	}
	Text(text, style = MaterialTheme.typography.bodySmall, color = color)
}

@Composable
private fun hubStatusLabel(s: HubStatus): String = when (s) {
	HubStatus.Connected -> stringResource(R.string.remote_hub_connected)
	HubStatus.Connecting -> stringResource(R.string.remote_hub_connecting)
	HubStatus.Disconnected -> stringResource(R.string.remote_hub_disconnected)
}
