package ro.mixai.app.ui.together

import android.content.Intent
import android.util.Log
import android.widget.Toast
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.automirrored.outlined.Logout
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.outlined.Groups
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material.icons.outlined.PersonAdd
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import ro.mixai.app.AppDeps
import ro.mixai.app.BuildConfig
import ro.mixai.app.R
import ro.mixai.app.nav.Dest
import ro.mixai.app.nav.Navigator
import ro.mixai.app.ui.theme.Mixai
import ro.mixai.tv.data.HubClient
import ro.mixai.tv.data.HubStatus
import ro.mixai.tv.data.MediaRef
import ro.mixai.tv.data.RoomChat
import ro.mixai.tv.data.RoomMember
import ro.mixai.tv.data.RoomState
import java.net.URLEncoder

private const val TAG = "MixaiTogether"

/** Reactions sent to other members (content, same payloads as the TV), not UI icons. */
private val REACTIONS = listOf("\uD83D\uDC4D", "\uD83D\uDE02", "\uD83D\uDE2E", "\uD83D\uDE22", "\u2764\uFE0F")

/** `reportMessage` reasons understood by the hub, paired with their label. */
private val REPORT_REASONS = listOf(
	"spam" to R.string.together_report_reason_spam,
	"harassment" to R.string.together_report_reason_harassment,
	"hate" to R.string.together_report_reason_hate,
	"sexual" to R.string.together_report_reason_sexual,
	"violence" to R.string.together_report_reason_violence,
	"other" to R.string.together_report_reason_other,
)

private const val MAX_CHAT = 200

/** Chat line with a local sequence number so LazyColumn keys stay distinct even for duplicate ids. */
private data class ChatItem(val seq: Long, val msg: RoomChat)

private data class FloatingReaction(val seq: Long, val text: String)

/**
 * Watch Together on the phone (WP16-46 slice 2): create or join a hub room, share the invite link,
 * see members (block / unblock, host kick), chat with report + block, send reactions and open the
 * room's media in the player (which keeps itself in sync through [RoomPlaybackSync]).
 * [roomId] (deep link `mixai://together/<roomId>`) auto-joins once.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TogetherScreen(deps: AppDeps, nav: Navigator, roomId: String?) {
	val hub = deps.hub
	val context = LocalContext.current
	val status by hub.status.collectAsState()
	val room by hub.room.collectAsState()
	var errorCode by remember { mutableStateOf<String?>(null) }
	var autoJoined by rememberSaveable { mutableStateOf(false) }
	var joining by remember { mutableStateOf(false) }
	val chat = remember { mutableStateListOf<ChatItem>() }
	val reactions = remember { mutableStateListOf<FloatingReaction>() }
	val blocked = remember { mutableStateListOf<String>() }
	var seq by remember { mutableStateOf(0L) }

	val reportOk = stringResource(R.string.together_report_ok)
	val blockOk = stringResource(R.string.together_block_ok)
	val unblockOk = stringResource(R.string.together_unblock_ok)

	LaunchedEffect(roomId) {
		if (roomId != null && !autoJoined && hub.room.value?.roomId != roomId) {
			autoJoined = true
			joining = true
			while (hub.status.value != HubStatus.Connected) delay(250)
			hub.joinRoom(roomId)
		}
	}
	LaunchedEffect(hub) { hub.errors.collect { errorCode = it; joining = false } }
	LaunchedEffect(hub) {
		hub.moderation.collect { m ->
			when (m) {
				"report:ok" -> Toast.makeText(context, reportOk, Toast.LENGTH_SHORT).show()
				"block:ok" -> Toast.makeText(context, blockOk, Toast.LENGTH_SHORT).show()
				"unblock:ok" -> Toast.makeText(context, unblockOk, Toast.LENGTH_SHORT).show()
				"kicked" -> { errorCode = "kicked"; chat.clear() }
			}
		}
	}
	LaunchedEffect(hub) {
		hub.chat.collect { c ->
			chat.add(ChatItem(seq++, c))
			while (chat.size > MAX_CHAT) chat.removeAt(0)
		}
	}
	LaunchedEffect(hub) {
		hub.reactions.collect { r ->
			val item = FloatingReaction(seq++, "${r.fromName}: ${r.emoji}")
			reactions.add(item)
			while (reactions.size > 4) reactions.removeAt(0)
			launch { delay(4_000); reactions.remove(item) }
		}
	}
	LaunchedEffect(room?.roomId) {
		val r = hub.room.value ?: return@LaunchedEffect
		joining = false
		errorCode = null
		Log.i(TAG, "room ${r.roomId} created/joined members=${r.members.size}")
	}

	Scaffold(
		modifier = Modifier.fillMaxSize(),
		topBar = {
			TopAppBar(
				title = {
					Column {
						Text(room?.name?.takeIf { it.isNotBlank() } ?: stringResource(R.string.together_title), maxLines = 1, overflow = TextOverflow.Ellipsis)
						room?.let { Text(phaseLabel(it.phase), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
					}
				},
				navigationIcon = {
					IconButton(onClick = { nav.pop() }) {
						Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.action_back))
					}
				},
				actions = {
					val r = room
					if (r != null) {
						IconButton(
							onClick = { shareInvite(context, deps.api.baseUrl, r.invite ?: return@IconButton) },
							enabled = r.invite != null,
						) { Icon(Icons.Outlined.PersonAdd, contentDescription = stringResource(R.string.together_invite)) }
						IconButton(onClick = { hub.leave(); chat.clear(); blocked.clear() }) {
							Icon(Icons.AutoMirrored.Outlined.Logout, contentDescription = stringResource(R.string.together_leave))
						}
					}
				},
			)
		},
	) { padding ->
		val r = room
		Box(Modifier.fillMaxSize().padding(padding).imePadding()) {
			if (r == null) {
				Lobby(
					connected = status == HubStatus.Connected,
					joining = joining,
					errorCode = errorCode,
					initialRoomId = roomId.orEmpty(),
					onCreate = { name -> errorCode = null; hub.createRoom(name.trim().ifBlank { null }) },
					onJoin = { id -> errorCode = null; joining = true; hub.joinRoom(id) },
				)
			} else {
				InRoom(
					hub = hub,
					room = r,
					chat = chat.filter { it.msg.fromConnId !in blocked },
					blocked = blocked,
					onWatch = { media ->
						val fileId = media.fileId ?: return@InRoom
						val kind = media.kind
						val tmdb = media.tmdbId
						val ref = if (kind != null && tmdb != null) MediaRef(kind, tmdb, media.season, media.episode) else null
						val resumeMs = ((hub.roomExpectedPosition() ?: 0.0) * 1000).toLong().coerceAtLeast(0L)
						nav.push(Dest.Player(fileId, ref, resumeMs))
					},
					onBlock = { connId -> if (connId !in blocked) blocked.add(connId); hub.block(connId) },
					onUnblock = { connId -> blocked.remove(connId); hub.unblock(connId) },
				)
			}
			if (reactions.isNotEmpty()) {
				Column(
					Modifier.align(Alignment.TopEnd).padding(12.dp),
					horizontalAlignment = Alignment.End,
					verticalArrangement = Arrangement.spacedBy(6.dp),
				) {
					reactions.forEach { fr ->
						Surface(
							shape = MaterialTheme.shapes.large,
							color = MaterialTheme.colorScheme.secondaryContainer,
							contentColor = MaterialTheme.colorScheme.onSecondaryContainer,
							shadowElevation = 2.dp,
						) {
							Text(fr.text, Modifier.padding(horizontal = 12.dp, vertical = 6.dp), style = MaterialTheme.typography.bodyMedium)
						}
					}
				}
			}
		}
	}
}

@Composable
private fun Lobby(
	connected: Boolean,
	joining: Boolean,
	errorCode: String?,
	initialRoomId: String,
	onCreate: (String) -> Unit,
	onJoin: (String) -> Unit,
) {
	var name by rememberSaveable { mutableStateOf("") }
	var code by rememberSaveable { mutableStateOf(initialRoomId) }
	LazyColumn(
		Modifier.fillMaxSize(),
		contentPadding = PaddingValues(16.dp),
		verticalArrangement = Arrangement.spacedBy(16.dp),
		horizontalAlignment = Alignment.CenterHorizontally,
	) {
		item(key = "intro") {
			Column(Modifier.widthIn(max = 560.dp).fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
				Icon(Icons.Outlined.Groups, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(56.dp))
				Spacer(Modifier.height(8.dp))
				Text(stringResource(R.string.together_intro), style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
			}
		}
		if (!connected || joining) {
			item(key = "status") {
				Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
					CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
					Text(stringResource(if (!connected) R.string.together_connecting else R.string.together_joining))
				}
			}
		}
		if (errorCode != null) {
			item(key = "error") {
				Card(
					Modifier.widthIn(max = 560.dp).fillMaxWidth(),
					colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer, contentColor = MaterialTheme.colorScheme.onErrorContainer),
				) { Text(errorLabel(errorCode), Modifier.padding(16.dp)) }
			}
		}
		item(key = "create") {
			LobbyCard(stringResource(R.string.together_create_title)) {
				OutlinedTextField(
					value = name,
					onValueChange = { name = it.take(60) },
					label = { Text(stringResource(R.string.together_room_name)) },
					singleLine = true,
					modifier = Modifier.fillMaxWidth(),
				)
				Button(onClick = { onCreate(name) }, enabled = connected, modifier = Modifier.fillMaxWidth()) {
					Text(stringResource(R.string.together_create))
				}
			}
		}
		item(key = "join") {
			LobbyCard(stringResource(R.string.together_join_title)) {
				val id = normaliseRoomId(code)
				OutlinedTextField(
					value = code,
					onValueChange = { code = it.take(200) },
					label = { Text(stringResource(R.string.together_room_id)) },
					singleLine = true,
					keyboardOptions = KeyboardOptions(imeAction = ImeAction.Go),
					keyboardActions = KeyboardActions(onGo = { if (connected && id.isNotEmpty()) onJoin(id) }),
					modifier = Modifier.fillMaxWidth(),
				)
				FilledTonalButton(onClick = { onJoin(id) }, enabled = connected && id.isNotEmpty(), modifier = Modifier.fillMaxWidth()) {
					Text(stringResource(R.string.together_join))
				}
			}
		}
	}
}

@Composable
private fun LobbyCard(title: String, content: @Composable () -> Unit) {
	Card(
		Modifier.widthIn(max = 560.dp).fillMaxWidth(),
		colors = CardDefaults.cardColors(containerColor = Mixai.colors.card),
	) {
		Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
			Text(title, style = MaterialTheme.typography.titleMedium)
			content()
		}
	}
}

@Composable
private fun InRoom(
	hub: HubClient,
	room: RoomState,
	chat: List<ChatItem>,
	blocked: List<String>,
	onWatch: (ro.mixai.tv.data.generated.HubMedia) -> Unit,
	onBlock: (String) -> Unit,
	onUnblock: (String) -> Unit,
) {
	val me = hub.myConnId
	val iAmHost = me != null && room.hostConnId == me
	var draft by rememberSaveable { mutableStateOf("") }
	var reportTarget by remember { mutableStateOf<RoomChat?>(null) }
	val listState = rememberLazyListState()
	LaunchedEffect(chat.size) { if (chat.isNotEmpty()) listState.animateScrollToItem(listState.layoutInfo.totalItemsCount.coerceAtLeast(1) - 1) }

	Column(Modifier.fillMaxSize()) {
		LazyColumn(Modifier.weight(1f).fillMaxWidth(), state = listState, contentPadding = PaddingValues(bottom = 8.dp)) {
			item(key = "header") {
				Text(
					stringResource(R.string.together_room_id_label, room.roomId),
					Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
					style = MaterialTheme.typography.labelMedium,
					color = MaterialTheme.colorScheme.onSurfaceVariant,
				)
			}
			item(key = "media") { MediaCard(room, onWatch) }
			item(key = "members-title") { SectionTitle(stringResource(R.string.together_members, room.members.size)) }
			items(room.members, key = { "member:" + it.connId }) { m ->
				MemberRow(
					member = m,
					isHost = m.connId == room.hostConnId,
					isMe = m.connId == me,
					isBlocked = m.connId in blocked,
					canKick = iAmHost && m.connId != me,
					onBlock = { onBlock(m.connId) },
					onUnblock = { onUnblock(m.connId) },
					onKick = { hub.kick(m.connId) },
				)
			}
			item(key = "reactions") {
				SectionTitle(stringResource(R.string.together_reactions))
				Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp), horizontalArrangement = Arrangement.SpaceEvenly) {
					REACTIONS.forEach { e ->
						val cd = stringResource(R.string.together_react, e)
						IconButton(onClick = { hub.react(e, hub.roomExpectedPosition()) }, modifier = Modifier.size(52.dp)) {
							Text(e, style = MaterialTheme.typography.headlineSmall, modifier = Modifier.semanticsLabel(cd))
						}
					}
				}
			}
			item(key = "chat-title") { SectionTitle(stringResource(R.string.together_chat)) }
			if (chat.isEmpty()) {
				item(key = "chat-empty") {
					Text(
						stringResource(R.string.together_chat_empty),
						Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
						color = MaterialTheme.colorScheme.onSurfaceVariant,
					)
				}
			}
			items(chat, key = { "chat:" + it.seq }) { item ->
				ChatRow(
					msg = item.msg,
					mine = item.msg.fromConnId == me,
					onReport = { reportTarget = item.msg },
					onBlockSender = { onBlock(item.msg.fromConnId) },
				)
			}
		}
		HorizontalDivider()
		Row(
			Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 12.dp, vertical = 8.dp),
			verticalAlignment = Alignment.CenterVertically,
		) {
			val send = {
				val t = draft.trim()
				if (t.isNotEmpty()) { hub.chat(t); draft = "" }
			}
			OutlinedTextField(
				value = draft,
				onValueChange = { draft = it.take(500) },
				placeholder = { Text(stringResource(R.string.together_chat_hint)) },
				singleLine = true,
				keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
				keyboardActions = KeyboardActions(onSend = { send() }),
				modifier = Modifier.weight(1f),
			)
			IconButton(onClick = send, enabled = draft.isNotBlank()) {
				Icon(Icons.AutoMirrored.Filled.Send, contentDescription = stringResource(R.string.together_send))
			}
		}
	}

	reportTarget?.let { target ->
		ReportDialog(
			onDismiss = { reportTarget = null },
			onSend = { reason ->
				if (target.id.isNotEmpty()) hub.reportMessage(target.id, reason)
				reportTarget = null
			},
		)
	}
}

@Composable
private fun MediaCard(room: RoomState, onWatch: (ro.mixai.tv.data.generated.HubMedia) -> Unit) {
	val media = room.media
	Card(
		Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
		colors = CardDefaults.cardColors(containerColor = Mixai.colors.card),
	) {
		Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
			if (media?.fileId != null) {
				Text(stringResource(R.string.together_now_playing), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
				Text(media.title?.takeIf { it.isNotBlank() } ?: stringResource(R.string.together_untitled), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
				Text(phaseLabel(room.phase), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
				Button(onClick = { onWatch(media) }) {
					Icon(Icons.Filled.PlayArrow, contentDescription = null)
					Spacer(Modifier.size(8.dp))
					Text(stringResource(R.string.together_watch))
				}
			} else {
				Text(stringResource(R.string.together_no_media), color = MaterialTheme.colorScheme.onSurfaceVariant)
			}
		}
	}
}

@Composable
private fun MemberRow(
	member: RoomMember,
	isHost: Boolean,
	isMe: Boolean,
	isBlocked: Boolean,
	canKick: Boolean,
	onBlock: () -> Unit,
	onUnblock: () -> Unit,
	onKick: () -> Unit,
) {
	var menu by remember { mutableStateOf(false) }
	val name = if (isMe) "${member.name} (${stringResource(R.string.together_you)})" else member.name
	val tags = buildList {
		if (isHost) add(stringResource(R.string.together_host))
		if (member.guest) add(stringResource(R.string.together_guest))
		if (isBlocked) add(stringResource(R.string.together_blocked_badge))
	}
	ListItem(
		headlineContent = { Text(name, maxLines = 1, overflow = TextOverflow.Ellipsis) },
		supportingContent = {
			Text(
				(tags + stringResource(if (member.ready) R.string.together_ready else R.string.together_buffering)).joinToString(" · "),
				color = if (member.ready) Mixai.colors.success else Mixai.colors.warning,
			)
		},
		trailingContent = if (isMe) null else {
			{
				Box {
					IconButton(onClick = { menu = true }) {
						Icon(Icons.Outlined.MoreVert, contentDescription = stringResource(R.string.together_member_menu, member.name))
					}
					DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
						if (isBlocked) {
							DropdownMenuItem(text = { Text(stringResource(R.string.together_unblock)) }, onClick = { menu = false; onUnblock() })
						} else {
							DropdownMenuItem(text = { Text(stringResource(R.string.together_block)) }, onClick = { menu = false; onBlock() })
						}
						if (canKick) {
							DropdownMenuItem(text = { Text(stringResource(R.string.together_kick)) }, onClick = { menu = false; onKick() })
						}
					}
				}
			}
		},
		colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surface),
	)
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ChatRow(msg: RoomChat, mine: Boolean, onReport: () -> Unit, onBlockSender: () -> Unit) {
	var menu by remember { mutableStateOf(false) }
	Box(Modifier.fillMaxWidth()) {
		Column(
			Modifier
				.fillMaxWidth()
				.combinedClickable(onClick = {}, onLongClick = { if (!mine) menu = true })
				.padding(horizontal = 16.dp, vertical = 6.dp),
		) {
			Text(
				msg.fromName,
				style = MaterialTheme.typography.labelMedium,
				color = if (mine) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
			)
			Text(msg.text, style = MaterialTheme.typography.bodyMedium)
		}
		DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
			if (msg.id.isNotEmpty()) {
				DropdownMenuItem(text = { Text(stringResource(R.string.together_report)) }, onClick = { menu = false; onReport() })
			}
			if (msg.fromConnId.isNotEmpty()) {
				DropdownMenuItem(text = { Text(stringResource(R.string.together_block_sender)) }, onClick = { menu = false; onBlockSender() })
			}
		}
	}
}

@Composable
private fun ReportDialog(onDismiss: () -> Unit, onSend: (String) -> Unit) {
	var reason by rememberSaveable { mutableStateOf(REPORT_REASONS.first().first) }
	AlertDialog(
		onDismissRequest = onDismiss,
		title = { Text(stringResource(R.string.together_report_title)) },
		text = {
			Column {
				REPORT_REASONS.forEach { (value, label) ->
					Row(
						Modifier
							.fillMaxWidth()
							.selectable(selected = reason == value, onClick = { reason = value }, role = Role.RadioButton)
							.padding(vertical = 4.dp),
						verticalAlignment = Alignment.CenterVertically,
					) {
						RadioButton(selected = reason == value, onClick = null)
						Spacer(Modifier.size(12.dp))
						Text(stringResource(label))
					}
				}
			}
		},
		confirmButton = { TextButton(onClick = { onSend(reason) }) { Text(stringResource(R.string.together_report_send)) } },
		dismissButton = { OutlinedButton(onClick = onDismiss) { Text(stringResource(R.string.together_cancel)) } },
	)
}

@Composable
private fun SectionTitle(text: String) {
	Text(
		text,
		Modifier.padding(start = 16.dp, end = 16.dp, top = 16.dp, bottom = 4.dp),
		style = MaterialTheme.typography.titleSmall,
		color = MaterialTheme.colorScheme.primary,
	)
}

private fun Modifier.semanticsLabel(label: String): Modifier = clearAndSetSemantics { contentDescription = label }

@Composable
private fun phaseLabel(phase: String): String = stringResource(
	when (phase) {
		"waiting" -> R.string.together_phase_waiting
		"playing" -> R.string.together_phase_playing
		"paused" -> R.string.together_phase_paused
		else -> R.string.together_phase_idle
	},
)

@Composable
private fun errorLabel(code: String): String = when (code) {
	"room_not_found" -> stringResource(R.string.together_err_room_not_found)
	"room_full" -> stringResource(R.string.together_err_room_full)
	"kicked" -> stringResource(R.string.together_err_kicked)
	"not_in_room" -> stringResource(R.string.together_err_not_in_room)
	else -> stringResource(R.string.together_err_generic, code)
}

/** Accepts a bare room id or a pasted `mixai://together/<id>` link. */
private fun normaliseRoomId(input: String): String {
	val t = input.trim()
	val marker = "together/"
	val i = t.lastIndexOf(marker)
	return (if (i >= 0) t.substring(i + marker.length) else t).substringBefore('?').trim('/', ' ')
}

private fun shareInvite(context: android.content.Context, baseUrl: String, invite: String) {
	val link = "${BuildConfig.MIXAI_WEB_ORIGIN}/together?server=${URLEncoder.encode(baseUrl, "UTF-8")}&inv=$invite"
	val send = Intent(Intent.ACTION_SEND).apply {
		type = "text/plain"
		putExtra(Intent.EXTRA_TEXT, context.getString(R.string.together_invite_text, link))
	}
	context.startActivity(Intent.createChooser(send, context.getString(R.string.together_invite_share_title)))
}
