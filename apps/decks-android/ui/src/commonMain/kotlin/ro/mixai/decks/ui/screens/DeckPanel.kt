package ro.mixai.decks.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import ro.mixai.decks.ui.DecksController
import ro.mixai.decks.ui.components.ButtonRow
import ro.mixai.decks.ui.components.Fader
import ro.mixai.decks.ui.components.JogWheel
import ro.mixai.decks.ui.components.Overview
import ro.mixai.decks.ui.components.PadButton
import ro.mixai.decks.ui.components.Panel
import ro.mixai.decks.ui.components.PhaseMeter
import ro.mixai.decks.ui.components.Readout
import ro.mixai.decks.ui.components.Spacer
import ro.mixai.decks.ui.engine.PanelTier
import ro.mixai.decks.ui.i18n.Str
import ro.mixai.decks.ui.i18n.str
import ro.mixai.decks.ui.logic.DeckMath
import ro.mixai.decks.ui.logic.Format
import ro.mixai.decks.ui.model.DeckState
import ro.mixai.decks.ui.model.LoadPhase
import ro.mixai.decks.ui.theme.DecksColors
import ro.mixai.decks.ui.theme.LocalDecksType

/**
 * One deck at a layout tier (WP19-34): [PanelTier.Full] = everything + jog wheel, [PanelTier.Compact]
 * = no jog and no key/mode row, [PanelTier.Icon] = title, BPM and the transport only. Each tier
 * fits the `PANEL_SPECS` minimum of presets.ts (deck: 460×560, 340×330, 220×150 dp).
 */
@Composable
fun DeckPanel(ctl: DecksController, index: Int, modifier: Modifier = Modifier, tier: PanelTier = PanelTier.Full) {
    val compact = tier != PanelTier.Full
    val d: DeckState = ctl.deck(index) ?: DeckState(index)
    val c = ctl.controls[index]
    val color = DecksColors.deck(index)
    val type = LocalDecksType.current
    val deckName = str(if (index == 0) Str.DeckA else Str.DeckB)
    val on = str(Str.On)
    val off = str(Str.Off)
    fun st(b: Boolean) = if (b) on else off

    if (tier == PanelTier.Icon) {
        DeckIcon(ctl, index, d, deckName, modifier)
        return
    }
    Panel(modifier) {
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            // Header: deck name, title, BPM, key, tempo
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                BasicText(deckName, style = type.title.copy(color = color), modifier = Modifier.semantics { heading() })
                val title = when {
                    c.loadPhase == LoadPhase.FAILED -> str(Str.LoadFailed, c.loadError ?: "?")
                    c.loadPhase == LoadPhase.QUEUED -> str(Str.LoadQueued)
                    c.loadPhase == LoadPhase.DECODING -> str(Str.LoadDecoding)
                    c.loadPhase == LoadPhase.ANALYSING -> str(Str.LoadAnalysing)
                    c.loadPhase != null || d.loading -> str(Str.Loading)
                    d.title != null -> d.title
                    else -> str(Str.NoTrack)
                }
                BasicText(title, style = type.body, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            }
            Row(horizontalArrangement = Arrangement.spacedBy(16.dp), verticalAlignment = Alignment.Bottom) {
                Readout(str(Str.Bpm), Format.bpm(d.effectiveBpm ?: d.bpm), color = color)
                Readout(str(Str.Tempo), Format.tempoPercent(d.tempo))
                Readout(str(Str.Key), (d.effectiveKey ?: d.key ?: "—") + if (d.keyShift != 0.0) " (${Format.semitones(d.keyShift)})" else "",
                    color = DecksColors.key(d.effectiveKey ?: d.key))
                Readout(str(Str.Elapsed), Format.time(d.playheadSec))
                Readout(str(Str.Remaining), Format.remaining(d.playheadSec, d.durationSec))
            }
            val wave = ctl.waveFrame(8f, false).decks.getOrNull(index)
            if (wave != null) {
                Overview(
                    wave, c.peaks, "${str(Str.Overview)} $deckName",
                    "${Format.time(d.playheadSec)} / ${Format.time(d.durationSec)}",
                    Modifier.fillMaxWidth().height(28.dp),
                ) { ctl.seekFraction(index, it) }
            }
            val master = ctl.engine.clock
            val phase = if (d.loaded && d.bpm != null && master.bpm > 0 && master.sourceDeck != index) {
                DeckMath.phaseOffset(d.beat, master.beat)
            } else null
            PhaseMeter(phase, index, "${str(Str.PhaseMeter)} $deckName", Modifier.fillMaxWidth().height(8.dp))

            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    // Transport
                    ButtonRow {
                        PadButton(
                            if (d.playing) "❚❚" else "▶",
                            "${str(if (d.playing) Str.Pause else Str.Play)} $deckName",
                            Modifier.weight(1f), active = d.playing, accent = color, enabled = d.loaded,
                        ) { ctl.togglePlay(index) }
                        PadButton(
                            str(Str.Cue).uppercase(), "${str(Str.Cue)} $deckName", Modifier.weight(1f),
                            accent = DecksColors.warning, enabled = d.loaded,
                            onPress = { ctl.cue(index, true) }, onRelease = { ctl.cue(index, false) },
                        )
                        PadButton(
                            str(Str.Sync).uppercase(), "${str(Str.Sync)} $deckName", Modifier.weight(1f),
                            active = d.syncLock, accent = color, enabled = d.loaded, state = st(d.syncLock),
                        ) { ctl.syncTap(index) }
                        PadButton(
                            "🔒", "${str(Str.SyncLock)} $deckName", active = d.syncLock, accent = color, enabled = d.loaded,
                            state = st(d.syncLock),
                        ) { ctl.syncLock(index) }
                    }
                    // Hot cues 1-4 (+ delete toggle)
                    ButtonRow {
                        for (slot in 0 until 4) {
                            val set = d.hotCues.getOrNull(slot) != null
                            PadButton(
                                "${slot + 1}",
                                str(if (set) Str.HotCue else Str.HotCueEmpty, slot + 1) + " $deckName",
                                Modifier.weight(1f), active = set, accent = DecksColors.deck(slot), enabled = d.loaded,
                            ) { ctl.hotCue(index, slot) }
                        }
                        PadButton("✕", "${str(Str.HotCueDelete)} $deckName", active = c.hotCueDeleteMode,
                            accent = DecksColors.danger, state = st(c.hotCueDeleteMode)) { ctl.toggleHotCueDelete(index) }
                    }
                    // Loops + beat jump
                    ButtonRow {
                        PadButton("½", "${str(Str.LoopHalve)} $deckName", enabled = d.loaded) { ctl.loopHalve(index) }
                        PadButton(
                            DeckMath.loopLabel(c.loopBeats),
                            (if (d.loopActive) str(Str.LoopExit) else str(Str.Loop, DeckMath.loopLabel(c.loopBeats))) + " $deckName",
                            Modifier.weight(1f), active = d.loopActive, accent = DecksColors.success, enabled = d.loaded,
                            state = st(d.loopActive),
                        ) { ctl.loopAuto(index) }
                        PadButton("2×", "${str(Str.LoopDouble)} $deckName", enabled = d.loaded) { ctl.loopDouble(index) }
                        val jb = DeckMath.loopLabel(c.jumpBeats)
                        PadButton("◀$jb", str(Str.BeatJumpBack, jb) + " $deckName", enabled = d.loaded) { ctl.beatJump(index, false) }
                        PadButton("$jb▶", str(Str.BeatJumpForward, jb) + " $deckName", enabled = d.loaded) { ctl.beatJump(index, true) }
                    }
                    // Key + modes (full tier only: the compact minimum has no room for a fourth row)
                    if (!compact) ButtonRow {
                        PadButton("♭", "${str(Str.KeyShiftDown)} $deckName", enabled = d.loaded) { ctl.shiftKey(index, -1.0) }
                        PadButton("♯", "${str(Str.KeyShiftUp)} $deckName", enabled = d.loaded) { ctl.shiftKey(index, 1.0) }
                        PadButton(str(Str.KeyMatch), "${str(Str.KeyMatch)} $deckName", Modifier.weight(1f), enabled = d.loaded) {
                            ctl.keyMatch(index)
                        }
                        PadButton("KL", "${str(Str.KeyLock)} $deckName", active = d.keyLock, accent = color, state = st(d.keyLock)) {
                            ctl.toggleKeyLock(index)
                        }
                        PadButton("Q", "${str(Str.Quantize)} $deckName", active = d.quantize, accent = color, state = st(d.quantize)) {
                            ctl.toggleQuantize(index)
                        }
                        PadButton(str(Str.Slip).uppercase(), "${str(Str.Slip)} $deckName", active = d.slip, accent = color,
                            state = st(d.slip)) { ctl.toggleSlip(index) }
                    }
                }
                if (!compact) {
                    Box(Modifier.width(120.dp).aspectRatio(1f)) {
                        JogWheel(
                            d.playheadSec, d.playing, index, "${str(Str.JogWheel)} $deckName",
                            DeckMath.beatInBar(d.beat, 4), Modifier.fillMaxWidth().fillMaxHeight(),
                        ) { ctl.nudge(index, it) }
                    }
                }
                // Tempo fader (+ range / reset)
                Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    val rangePct = (c.tempoRange * 100).toInt()
                    PadButton("±$rangePct", str(Str.TempoRange, rangePct) + " $deckName") { ctl.cycleTempoRange(index) }
                    Fader(
                        "${str(Str.Tempo)} $deckName", Format.tempoPercent(d.tempo), c.tempoFader, -1f..1f, 0f,
                        Modifier.width(36.dp).height(if (compact) 110.dp else 140.dp), vertical = true, invert = true, color = color,
                    ) { ctl.setTempoFader(index, it) }
                    PadButton("0", "${str(Str.TempoReset)} $deckName") { ctl.resetTempo(index) }
                }
            }
            Spacer(0.dp)
        }
    }
}

/** Icon tier: deck name + title, BPM / key, play / cue / sync. */
@Composable
private fun DeckIcon(ctl: DecksController, index: Int, d: DeckState, deckName: String, modifier: Modifier) {
    val type = LocalDecksType.current
    val color = DecksColors.deck(index)
    Panel(modifier) {
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                BasicText(deckName, style = type.title.copy(color = color), modifier = Modifier.semantics { heading() })
                BasicText(
                    d.title ?: str(Str.NoTrack), style = type.small, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
            }
            BasicText(
                "${Format.bpm(d.effectiveBpm ?: d.bpm)} · ${d.effectiveKey ?: d.key ?: "—"} · ${Format.remaining(d.playheadSec, d.durationSec)}",
                style = type.small.copy(color = color), maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
            ButtonRow {
                PadButton(
                    if (d.playing) "❚❚" else "▶", "${str(if (d.playing) Str.Pause else Str.Play)} $deckName",
                    Modifier.weight(1f), active = d.playing, accent = color, enabled = d.loaded,
                ) { ctl.togglePlay(index) }
                PadButton(
                    str(Str.Cue).uppercase(), "${str(Str.Cue)} $deckName", Modifier.weight(1f),
                    accent = DecksColors.warning, enabled = d.loaded,
                    onPress = { ctl.cue(index, true) }, onRelease = { ctl.cue(index, false) },
                )
                PadButton(
                    str(Str.Sync).uppercase(), "${str(Str.Sync)} $deckName", Modifier.weight(1f),
                    active = d.syncLock, accent = color, enabled = d.loaded,
                    state = str(if (d.syncLock) Str.On else Str.Off),
                ) { ctl.syncTap(index) }
            }
        }
    }
}
