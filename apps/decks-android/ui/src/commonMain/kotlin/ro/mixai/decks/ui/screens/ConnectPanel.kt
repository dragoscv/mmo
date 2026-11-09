package ro.mixai.decks.ui.screens

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import ro.mixai.decks.ui.DecksController
import ro.mixai.decks.ui.components.PadButton
import ro.mixai.decks.ui.components.Panel
import ro.mixai.decks.ui.engine.RemotePairingUi
import ro.mixai.decks.ui.engine.RemoteRoleUi
import ro.mixai.decks.ui.engine.RequestStateUi
import ro.mixai.decks.ui.i18n.Str
import ro.mixai.decks.ui.i18n.str
import ro.mixai.decks.ui.theme.DecksColors
import ro.mixai.decks.ui.theme.LocalDecksType

/**
 * Connected mode (WP19-21): pairing QR codes for phone remote / second screen / Party DJ guests,
 * the request queue with DJ moderation, and the on/off switch. QR modules are drawn with the
 * skin's foreground on its surface (contrast checked by the skin gate), quiet zone 4 modules.
 */
@Composable
fun ConnectPanel(ctl: DecksController, modifier: Modifier = Modifier) {
    val type = LocalDecksType.current
    Panel(modifier) {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                BasicText(str(Str.Connect), style = type.label, modifier = Modifier.semantics { heading() })
                PadButton(
                    if (ctl.remoteOn) str(Str.On) else str(Str.Off),
                    str(Str.ConnectToggle),
                    active = ctl.remoteOn,
                    state = if (ctl.remoteOn) str(Str.On) else str(Str.Off),
                ) { ctl.setRemoteEnabled(!ctl.remoteOn) }
                if (ctl.remoteOn) {
                    BasicText(str(Str.ConnectClients, ctl.remoteClients), style = type.small.copy(color = DecksColors.muted))
                }
                if (ctl.remoteError) {
                    BasicText(str(Str.ConnectUnavailable), style = type.small.copy(color = DecksColors.danger))
                }
            }
            if (!ctl.remoteOn) {
                BasicText(str(Str.ConnectHint), style = type.small.copy(color = DecksColors.muted))
                return@Column
            }
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                for (role in RemoteRoleUi.entries) {
                    ctl.pairings[role]?.let { PairingCard(ctl, it) }
                }
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                BasicText(str(Str.Requests), style = type.label, modifier = Modifier.semantics { heading() })
                PadButton(
                    if (ctl.partyOpen) str(Str.RequestsOpen) else str(Str.RequestsClosed),
                    str(Str.RequestsToggle),
                    active = ctl.partyOpen,
                ) { ctl.changePartyOpen(!ctl.partyOpen) }
                PadButton(str(Str.RequestsClear), str(Str.RequestsClear)) { ctl.clearDoneRequests() }
            }
            if (ctl.requests.isEmpty()) {
                BasicText(str(Str.RequestsNone), style = type.small.copy(color = DecksColors.muted))
            }
            for (r in ctl.requests.take(12)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    val label = (if (r.artist.isNotEmpty()) "${r.artist} — " else "") + r.title
                    BasicText(
                        "$label · ${str(Str.RequestVotes, r.votes)} · ${stateName(r.state)}",
                        style = type.body.copy(color = if (r.state == RequestStateUi.REJECTED) DecksColors.muted else DecksColors.foreground),
                        maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
                    )
                    if (r.state == RequestStateUi.PENDING || r.state == RequestStateUi.ACCEPTED) {
                        PadButton(str(Str.RequestAccept), "${str(Str.RequestAccept)}: $label", active = r.state == RequestStateUi.ACCEPTED) {
                            ctl.moderate(r.id, RequestStateUi.ACCEPTED)
                        }
                        PadButton(str(Str.RequestPlayed), "${str(Str.RequestPlayed)}: $label") { ctl.moderate(r.id, RequestStateUi.PLAYED) }
                        PadButton(str(Str.RequestReject), "${str(Str.RequestReject)}: $label") { ctl.moderate(r.id, RequestStateUi.REJECTED) }
                    }
                }
            }
        }
    }
}

@Composable
private fun stateName(s: RequestStateUi) = when (s) {
    RequestStateUi.PENDING -> str(Str.RequestPending)
    RequestStateUi.ACCEPTED -> str(Str.RequestAccepted)
    RequestStateUi.REJECTED -> str(Str.RequestRejected)
    RequestStateUi.PLAYED -> str(Str.RequestPlayedState)
}

@Composable
private fun PairingCard(ctl: DecksController, p: RemotePairingUi) {
    val type = LocalDecksType.current
    val title = when (p.role) {
        RemoteRoleUi.CONTROLLER -> str(Str.ConnectRemote)
        RemoteRoleUi.VIEWER -> str(Str.ConnectScreen)
        RemoteRoleUi.GUEST -> str(Str.ConnectParty)
    }
    Column(Modifier.width(176.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp)) {
        BasicText(title, style = type.small)
        QrCode(p, Modifier.size(160.dp).semantics { contentDescription = "$title: ${p.url}" })
        BasicText(p.url, style = type.small.copy(color = DecksColors.muted), maxLines = 2, overflow = TextOverflow.Ellipsis)
        PadButton(str(Str.ConnectNewCode), "${str(Str.ConnectNewCode)} · $title") { ctl.rotatePairing(p.role) }
    }
}

@Composable
fun QrCode(p: RemotePairingUi, modifier: Modifier = Modifier) {
    val dark = DecksColors.foreground
    Canvas(modifier.background(DecksColors.surface).padding(4.dp)) {
        val n = p.width + 8
        val cell = minOf(size.width, size.height) / n
        for (y in 0 until p.width) for (x in 0 until p.width) {
            if (p.modules[y * p.width + x]) {
                drawRect(dark, Offset((x + 4) * cell, (y + 4) * cell), Size(cell + 0.5f, cell + 0.5f))
            }
        }
    }
}

/** Compact status-bar chip: tap to open the panel; shows the device count. */
@Composable
fun ConnectChip(ctl: DecksController, onClick: () -> Unit) {
    PadButton(
        if (ctl.remoteOn) str(Str.ConnectClients, ctl.remoteClients) else str(Str.Connect),
        str(Str.Connect),
        active = ctl.remoteOn,
        onClick = onClick,
    )
}
