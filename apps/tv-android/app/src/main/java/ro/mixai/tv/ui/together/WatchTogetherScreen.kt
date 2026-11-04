package ro.mixai.tv.ui.together

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.tv.material3.ClickableSurfaceDefaults
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Surface
import androidx.tv.material3.Text
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.common.BitMatrix
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel
import kotlinx.coroutines.delay
import ro.mixai.tv.BuildConfig
import ro.mixai.tv.R
import ro.mixai.tv.data.HubStatus
import ro.mixai.tv.data.RoomState
import ro.mixai.tv.ui.components.ErrorState
import ro.mixai.tv.ui.components.MixaiIcons
import ro.mixai.tv.ui.components.PrimaryButton
import ro.mixai.tv.ui.components.ScreenTitle
import ro.mixai.tv.ui.components.SecondaryButton
import ro.mixai.tv.ui.components.TvKeyboard
import ro.mixai.tv.ui.nav.Navigator
import ro.mixai.tv.ui.nav.Route
import ro.mixai.tv.ui.nav.ScreenDeps
import ro.mixai.tv.ui.theme.MixaiFocus
import ro.mixai.tv.ui.theme.Tokens

/** Reactions offered on TV. They are content (sent to other members), not UI icons. */
private val REACTIONS = listOf("\uD83D\uDC4D", "\uD83D\uDE02", "\uD83D\uDE2E", "\uD83D\uDE22", "\u2764\uFE0F")

private const val MIN_HUB_VERSION = "3.5.0"

private enum class Mode { Home, Create, Join }

private data class ChatLine(val id: Long, val text: String)

/**
 * Watch Together (WP16-27): create / join a hub room, invite link + QR, members with ready state,
 * chat + reactions, "Choose what to watch" (the player loads the title into the room).
 * [roomId] pre-joins a room (deep link / player button while already in one).
 */
@Composable
fun WatchTogetherScreen(deps: ScreenDeps, nav: Navigator, roomId: String?) {
    val hub = deps.hub
    val status by hub.status.collectAsState()
    val room by hub.room.collectAsState()
    var mode by rememberSaveable { mutableStateOf(Mode.Home) }
    var nameText by rememberSaveable { mutableStateOf("") }
    var codeText by rememberSaveable { mutableStateOf("") }
    var errorCode by remember { mutableStateOf<String?>(null) }
    var serverVersion by remember { mutableStateOf<String?>(null) }
    val chat = remember { mutableStateListOf<ChatLine>() }

    LaunchedEffect(Unit) {
        serverVersion = runCatching { deps.api.health().version }.getOrNull()
    }
    LaunchedEffect(roomId) {
        if (roomId != null && hub.room.value?.roomId != roomId) {
            // Wait for the socket, then join.
            while (hub.status.value != HubStatus.Connected) delay(250)
            hub.joinRoom(roomId)
        }
    }
    LaunchedEffect(hub) { hub.errors.collect { errorCode = it } }
    LaunchedEffect(hub) {
        hub.chat.collect { c ->
            chat.add(ChatLine(System.nanoTime(), "${c.fromName}: ${c.text}"))
            while (chat.size > 50) chat.removeAt(0)
        }
    }
    LaunchedEffect(hub) {
        hub.reactions.collect { r ->
            chat.add(ChatLine(System.nanoTime(), "${r.fromName}: ${r.emoji}"))
            while (chat.size > 50) chat.removeAt(0)
        }
    }
    LaunchedEffect(room?.roomId) { if (room != null) { mode = Mode.Home; errorCode = null } }

    val tooOld = serverVersion?.let { versionLess(it, MIN_HUB_VERSION) } == true

    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Bottom) {
            ScreenTitle(stringResource(R.string.together_title), Modifier.weight(1f), subtitle = stringResource(R.string.together_subtitle))
            HubStatusChip(status, Modifier.padding(end = MixaiFocus.overscan, bottom = 8.dp))
        }
        Box(
            Modifier.fillMaxSize().padding(horizontal = MixaiFocus.overscan, vertical = 24.dp),
        ) {
            when {
                tooOld -> ErrorState(
                    title = stringResource(R.string.together_update_title),
                    message = stringResource(R.string.together_update_server, serverVersion ?: "?"),
                    onRetry = null,
                    modifier = Modifier.align(Alignment.Center),
                )
                room != null -> RoomView(deps, nav, room!!, chat)
                mode == Mode.Create -> NameEntry(
                    title = stringResource(R.string.together_create_name),
                    text = nameText, onText = { nameText = it },
                    confirm = stringResource(R.string.together_create),
                    enabled = status == HubStatus.Connected,
                    onConfirm = { hub.createRoom(nameText.trim().ifBlank { null }) },
                    onCancel = { mode = Mode.Home },
                    focusConfirm = true,
                )
                mode == Mode.Join -> NameEntry(
                    title = stringResource(R.string.together_join_code),
                    text = codeText, onText = { codeText = it.filter { c -> c.isLetterOrDigit() || c == '-' || c == '_' || c == '.' } },
                    confirm = stringResource(R.string.together_join),
                    enabled = status == HubStatus.Connected && codeText.isNotBlank(),
                    onConfirm = { errorCode = null; hub.joinRoom(codeText.trim().substringBefore('.')) },
                    onCancel = { mode = Mode.Home },
                    error = errorCode?.let { errorText(it) },
                    caseSensitiveHint = stringResource(R.string.together_code_hint),
                )
                else -> StartView(
                    status = status,
                    onCreate = { mode = Mode.Create },
                    onJoin = { mode = Mode.Join },
                    error = errorCode?.let { errorText(it) },
                )
            }
        }
    }
}

@Composable
private fun errorText(code: String): String = when (code) {
    "room_not_found" -> stringResource(R.string.together_err_not_found)
    "room_full" -> stringResource(R.string.together_err_full)
    "not_in_room" -> stringResource(R.string.together_err_not_in_room)
    else -> stringResource(R.string.together_err_generic, code)
}

@Composable
private fun HubStatusChip(status: HubStatus, modifier: Modifier = Modifier) {
    val (label, color) = when (status) {
        HubStatus.Connected -> stringResource(R.string.together_hub_connected) to Tokens.success
        HubStatus.Connecting -> stringResource(R.string.together_hub_connecting) to Tokens.warning
        HubStatus.Disconnected -> stringResource(R.string.together_hub_disconnected) to Tokens.destructive
    }
    Row(
        modifier.background(Tokens.foreground.copy(alpha = 0.08f), RoundedCornerShape(20.dp)).padding(horizontal = 14.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Box(Modifier.size(10.dp).background(color, CircleShape))
        Text(label, style = MaterialTheme.typography.labelLarge, color = Tokens.foreground)
    }
}

@Composable
private fun StartView(status: HubStatus, onCreate: () -> Unit, onJoin: () -> Unit, error: String?) {
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { delay(80); runCatching { focus.requestFocus() } }
    Column(Modifier.fillMaxWidth(0.6f), verticalArrangement = Arrangement.spacedBy(20.dp)) {
        Text(stringResource(R.string.together_intro), style = MaterialTheme.typography.bodyLarge, color = Tokens.mutedForeground)
        Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            PrimaryButton(stringResource(R.string.together_create), onCreate, Modifier.focusRequester(focus), icon = MixaiIcons.Group, enabled = status == HubStatus.Connected)
            SecondaryButton(stringResource(R.string.together_join), onJoin, enabled = status == HubStatus.Connected)
        }
        if (status != HubStatus.Connected) {
            Text(stringResource(R.string.together_waiting_hub), style = MaterialTheme.typography.bodyMedium, color = Tokens.warning)
        }
        if (error != null) Text(error, style = MaterialTheme.typography.bodyMedium, color = Tokens.destructive)
    }
}

@Composable
private fun NameEntry(
    title: String,
    text: String,
    onText: (String) -> Unit,
    confirm: String,
    enabled: Boolean,
    onConfirm: () -> Unit,
    onCancel: () -> Unit,
    error: String? = null,
    caseSensitiveHint: String? = null,
    /** Focus the confirm button first (optional input) instead of the keyboard. */
    focusConfirm: Boolean = false,
) {
    androidx.activity.compose.BackHandler(onBack = onCancel)
    val confirmFocus = remember { FocusRequester() }
    LaunchedEffect(focusConfirm) { if (focusConfirm) { delay(120); runCatching { confirmFocus.requestFocus() } } }
    Row(horizontalArrangement = Arrangement.spacedBy(40.dp)) {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(title, style = MaterialTheme.typography.titleLarge, color = Tokens.foreground)
            Box(
                Modifier.width(520.dp).border(1.dp, Tokens.border, RoundedCornerShape(10.dp))
                    .background(Tokens.card, RoundedCornerShape(10.dp)).padding(horizontal = 16.dp, vertical = 12.dp),
            ) {
                Text(text.ifEmpty { " " }, style = MaterialTheme.typography.titleMedium, color = Tokens.foreground, maxLines = 1)
            }
            if (caseSensitiveHint != null) Text(caseSensitiveHint, style = MaterialTheme.typography.bodySmall, color = Tokens.mutedForeground)
            if (error != null) Text(error, style = MaterialTheme.typography.bodyMedium, color = Tokens.destructive)
            Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                PrimaryButton(confirm, onConfirm, Modifier.focusRequester(confirmFocus), enabled = enabled)
                SecondaryButton(stringResource(R.string.wp16_cancel), onCancel)
            }
        }
        TvKeyboard(text = text, onTextChange = onText, maxLength = 60, requestInitialFocus = !focusConfirm)
    }
}

@Composable
private fun RoomView(deps: ScreenDeps, nav: Navigator, room: RoomState, chat: List<ChatLine>) {
    val hub = deps.hub
    val chooseFocus = remember { FocusRequester() }
    LaunchedEffect(room.roomId) { delay(80); runCatching { chooseFocus.requestFocus() } }
    val link = room.invite?.let { inviteLink(deps.api.baseUrl, it) }

    Row(Modifier.fillMaxSize(), horizontalArrangement = Arrangement.spacedBy(40.dp)) {
        // Left: room, actions, members
        Column(Modifier.weight(1f).fillMaxHeight(), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Text(room.name.ifBlank { stringResource(R.string.together_title) }, style = MaterialTheme.typography.headlineSmall, color = Tokens.foreground)
            Text(stringResource(R.string.together_code, room.roomId), style = MaterialTheme.typography.titleMedium, color = Tokens.primary)
            val nowTitle = room.media?.title
            Text(
                if (nowTitle != null) stringResource(R.string.together_now, nowTitle) else stringResource(R.string.together_nothing),
                style = MaterialTheme.typography.bodyLarge, color = Tokens.mutedForeground, maxLines = 2, overflow = TextOverflow.Ellipsis,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                PrimaryButton(stringResource(R.string.together_choose), {
                    // Back to the title the user came from, else Home.
                    if (!nav.popTo { it is Route.Title || it is Route.Season || it is Route.Play }) nav.resetTo(Route.Home)
                }, Modifier.focusRequester(chooseFocus))
                SecondaryButton(stringResource(R.string.together_leave), { hub.leave() })
            }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                REACTIONS.forEach { e ->
                    Surface(
                        onClick = { hub.react(e, hub.roomExpectedPosition()) },
                        shape = ClickableSurfaceDefaults.shape(CircleShape),
                        colors = ClickableSurfaceDefaults.colors(
                            containerColor = Tokens.foreground.copy(alpha = 0.08f),
                            focusedContainerColor = Tokens.foreground.copy(alpha = 0.9f),
                        ),
                        scale = ClickableSurfaceDefaults.scale(focusedScale = 1.12f),
                    ) {
                        Text(e, style = MaterialTheme.typography.headlineSmall, modifier = Modifier.padding(12.dp))
                    }
                }
            }
            Text(stringResource(R.string.together_members, room.members.size), style = MaterialTheme.typography.titleMedium, color = Tokens.foreground)
            LazyColumn(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                items(room.members, key = { it.connId }) { m ->
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Box(Modifier.size(10.dp).background(if (m.ready) Tokens.success else Tokens.warning, CircleShape))
                        val tags = listOfNotNull(
                            if (m.connId == room.hostConnId) stringResource(R.string.together_host) else null,
                            if (m.connId == hub.myConnId) stringResource(R.string.together_you) else null,
                            if (m.guest) stringResource(R.string.together_guest) else null,
                        )
                        Text(
                            m.name.ifBlank { "?" } + if (tags.isNotEmpty()) " (" + tags.joinToString(", ") + ")" else "",
                            style = MaterialTheme.typography.bodyLarge, color = Tokens.foreground,
                        )
                        Text(
                            stringResource(if (m.ready) R.string.together_ready else R.string.together_not_ready),
                            style = MaterialTheme.typography.bodySmall, color = Tokens.mutedForeground,
                        )
                    }
                }
            }
        }
        // Middle: invite
        Column(Modifier.width(320.dp), verticalArrangement = Arrangement.spacedBy(12.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Text(stringResource(R.string.together_invite), style = MaterialTheme.typography.titleMedium, color = Tokens.foreground)
            if (link != null) {
                QrCode(link, Modifier.size(260.dp))
                Text(link, style = MaterialTheme.typography.bodySmall, color = Tokens.mutedForeground, maxLines = 3, overflow = TextOverflow.Ellipsis)
            } else {
                Text(stringResource(R.string.together_invite_code_only, room.roomId), style = MaterialTheme.typography.bodyMedium, color = Tokens.mutedForeground)
            }
        }
        // Right: chat
        Column(Modifier.width(380.dp).fillMaxHeight(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(stringResource(R.string.together_chat), style = MaterialTheme.typography.titleMedium, color = Tokens.foreground)
            val state = rememberLazyListState()
            LaunchedEffect(chat.size) { if (chat.isNotEmpty()) state.scrollToItem(chat.size - 1) }
            if (chat.isEmpty()) {
                Text(stringResource(R.string.together_chat_empty), style = MaterialTheme.typography.bodyMedium, color = Tokens.mutedForeground)
            }
            LazyColumn(
                Modifier.fillMaxWidth().weight(1f).background(Tokens.card, RoundedCornerShape(12.dp)).padding(12.dp),
                state = state, verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                items(chat, key = { it.id }) { l ->
                    Text(l.text, style = MaterialTheme.typography.bodyMedium, color = Tokens.foreground)
                }
            }
            Spacer(Modifier.height(4.dp))
        }
    }
}

/**
 * Guest join link: the MixAI web app opens `/together` with the server and invite secret
 * (the web join page talks to `GET /hub/invite/{invite}` + `WS /hub?inv=`).
 */
private fun inviteLink(serverBaseUrl: String, invite: String): String =
    "${BuildConfig.MIXAI_ORIGIN}/together?server=${java.net.URLEncoder.encode(serverBaseUrl, "UTF-8")}&inv=${java.net.URLEncoder.encode(invite, "UTF-8")}"

/** `a < b` for dotted numeric versions (`3.4.1` < `3.5.0`). */
private fun versionLess(a: String, b: String): Boolean {
    val x = a.split('.', '-').map { it.toIntOrNull() ?: 0 }
    val y = b.split('.', '-').map { it.toIntOrNull() ?: 0 }
    for (i in 0 until maxOf(x.size, y.size)) {
        val p = x.getOrElse(i) { 0 }; val q = y.getOrElse(i) { 0 }
        if (p != q) return p < q
    }
    return false
}

/** QR via ZXing BitMatrix + Canvas (copy of ui/PairScreen.kt QrCode; QR modules must stay black on white). */
@Composable
private fun QrCode(content: String, modifier: Modifier = Modifier) {
    val matrix: BitMatrix? = remember(content) {
        if (content.isBlank()) null else try {
            QRCodeWriter().encode(
                content, BarcodeFormat.QR_CODE, 0, 0,
                mapOf(EncodeHintType.MARGIN to 1, EncodeHintType.ERROR_CORRECTION to ErrorCorrectionLevel.M),
            )
        } catch (_: Exception) { null }
    }
    Box(modifier.background(Color.White).padding(12.dp)) {
        if (matrix != null) Canvas(Modifier.fillMaxSize()) {
            val cell = size.minDimension / matrix.width
            val ox = (size.width - cell * matrix.width) / 2
            val oy = (size.height - cell * matrix.height) / 2
            for (y in 0 until matrix.height) for (x in 0 until matrix.width) {
                if (matrix.get(x, y)) drawRect(Color.Black, Offset(ox + x * cell, oy + y * cell), Size(cell, cell))
            }
        }
    }
}
