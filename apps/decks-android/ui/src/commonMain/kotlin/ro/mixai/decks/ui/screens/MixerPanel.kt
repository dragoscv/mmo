package ro.mixai.decks.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import ro.mixai.decks.ui.DecksController
import ro.mixai.decks.ui.components.FaderLook
import ro.mixai.decks.ui.components.FlatFader
import ro.mixai.decks.ui.components.Glyph
import ro.mixai.decks.ui.components.KnobSmall
import ro.mixai.decks.ui.components.LookLine
import ro.mixai.decks.ui.components.LookText
import ro.mixai.decks.ui.components.MIXER_SHEET_W_DP
import ro.mixai.decks.ui.components.MicroLabel
import ro.mixai.decks.ui.components.MorePopup
import ro.mixai.decks.ui.components.OnButton
import ro.mixai.decks.ui.components.Panel
import ro.mixai.decks.ui.components.Recomposed
import ro.mixai.decks.ui.components.SegMeter
import ro.mixai.decks.ui.components.tag
import ro.mixai.decks.ui.engine.Band
import ro.mixai.decks.ui.engine.PanelId
import ro.mixai.decks.ui.engine.PanelTier
import ro.mixai.decks.ui.i18n.Str
import ro.mixai.decks.ui.i18n.str
import ro.mixai.decks.ui.logic.Format
import ro.mixai.decks.ui.theme.DecksColors

/*
 * Mixer and crossfader panels, "MixAI Signature" (Decks 1.5): the Compose mirror of MixerStrip.tsx,
 * Crossfader.tsx and mixer.css. Channel | master column | channel (the right channel is mirrored, so
 * both level meters face the master column). A channel: the deck letter, a column of 24 dp knobs
 * (trim, hi, mid, low, filter) beside the fader and its segmented level meter, and the CUE (headphone
 * cue) button. The master column: master level, the master meter, cue mix and headphone level.
 * WHAT is inline in a given box is decided by `mixerFit` (PanelFit.kt, pure and unit-tested); the
 * rest is behind MORE (a popup): nothing is removed (desktopTest ControlPresenceTest). ON (CUE) is the
 * look's ON colour; the deck colour marks the channel (letter, knob arcs, fader level).
 *
 * State: the levels move every frame; the meters read them while drawing, and the CUE buttons read
 * their one flag through a derived state, so a playing deck does not recompose the mixer
 * (desktopTest RecompositionTest).
 */

private enum class ChannelKnob(val key: String) { Trim("trim"), Hi("hi"), Mid("mid"), Low("low"), Filter("filter") }

private val EQ_ONLY = listOf(ChannelKnob.Hi, ChannelKnob.Mid, ChannelKnob.Low)

private fun pct(v: Float): String = "${(v * 100).toInt()}%"

/** Test names of the mixer's controls ([tag]): not spoken, not shown. */
object MixerTags {
    const val MASTER = "mixer-master"
    const val MIX = "mixer-mix"
    const val PHONES = "mixer-phones"
    const val MORE = "mixer-more"
    const val SHEET = "mixer-sheet"
    const val CLOSE = "mixer-sheet-close"
    const val CROSSFADER = "crossfader"

    private fun side(deck: Int) = if (deck == 0) "a" else "b"
    fun knob(deck: Int, key: String): String = "mixer-${side(deck)}-$key"
    fun volume(deck: Int): String = "mixer-${side(deck)}-volume"
    fun cue(deck: Int): String = "mixer-${side(deck)}-cue"

    /** Every control of the full mixer; every arrangement has all of these in the panel or in its MORE sheet. */
    val CONTROLS: List<String> = (0..1).flatMap { d -> ChannelKnob.entries.map { knob(d, it.key) } + volume(d) + cue(d) } + listOf(MASTER, MIX, PHONES)
}

/** Names the mixer reports to `LocalRecomposeProbe` (desktopTest/RecompositionTest); the meters report `meter:draw`. */
object MixerProbe {
    const val CHANNEL = "mixer:channel"
    const val CUE = "mixer:cue"
}

/**
 * Two-channel mixer in the box the layout solver gave it ([tier] = the solver's tier: full from
 * 240×250, compact from 200×190, icon from 150×110 dp), with a small dead band while the box is being
 * resized ([FitLag]). The crossfader is its own layout panel ([CrossfaderPanel]); pass
 * [withCrossfader] when the layout has no crossfader area. [initialMore] = it opens with its MORE
 * sheet showing (previews and tests).
 */
@Composable
fun MixerPanel(
    ctl: DecksController,
    modifier: Modifier = Modifier,
    tier: PanelTier = PanelTier.Full,
    withCrossfader: Boolean = false,
    initialMore: Boolean = false,
) {
    val label = str(Str.Mixer)
    val lag = remember { FitLag() }
    BoxWithConstraints(modifier) {
        val w = maxWidth.value.toDouble()
        val h = maxHeight.value.toDouble()
        val box = remember(lag, tier, w, h) { lag.settle(PanelId.Mixer, tier, w, h) }
        val fit = remember(box, withCrossfader) { mixerFit(box.tier, box.w, box.h, withCrossfader) }
        Panel(Modifier.fillMaxSize().semantics { contentDescription = label }, verticalPad = fit.pad.dp, horizontalPad = fit.pad.dp) {
            Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(MixerFit.ROW_GAP.dp)) {
                Row(Modifier.weight(1f).fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(MixerFit.COL_GAP.dp)) {
                    Channel(ctl, 0, fit, Modifier.weight(1f).fillMaxHeight())
                    MasterColumn(ctl, fit, Modifier.width(fit.masterW.dp).fillMaxHeight(), initialMore)
                    Channel(ctl, 1, fit, Modifier.weight(1f).fillMaxHeight())
                }
                if (withCrossfader) CrossfaderRow(ctl, Modifier.fillMaxWidth().height(MixerFit.FOOT.dp))
            }
        }
    }
}

/** One channel knob: 24 dp, the arc in the deck colour, the hardware legend under it. */
@Composable
private fun Knob(ctl: DecksController, i: Int, knob: ChannelKnob, width: Dp = MixerFit.KNOB_COL.dp) {
    val c = ctl.controls[i]
    val name = str(if (i == 0) Str.DeckA else Str.DeckB)
    val color = DecksColors.deck(i)
    val m = Modifier.tag(MixerTags.knob(i, knob.key))
    when (knob) {
        ChannelKnob.Trim -> KnobSmall(str(Str.LegendTrim), "${str(Str.Gain)} $name", Format.db(c.gainDb), c.gainDb, -12f..12f, 0f, m, color = color, width = width) { ctl.setGain(i, it) }
        ChannelKnob.Hi -> KnobSmall(str(Str.LegendHi), "${str(Str.EqHigh)} $name", Format.db(c.eqHigh), c.eqHigh, -26f..6f, 0f, m, color = color, width = width) { ctl.setEq(i, Band.HIGH, it) }
        ChannelKnob.Mid -> KnobSmall(str(Str.LegendMid), "${str(Str.EqMid)} $name", Format.db(c.eqMid), c.eqMid, -26f..6f, 0f, m, color = color, width = width) { ctl.setEq(i, Band.MID, it) }
        ChannelKnob.Low -> KnobSmall(str(Str.LegendLow), "${str(Str.EqLow)} $name", Format.db(c.eqLow), c.eqLow, -26f..6f, 0f, m, color = color, width = width) { ctl.setEq(i, Band.LOW, it) }
        ChannelKnob.Filter -> KnobSmall(str(Str.LegendFilter), "${str(Str.Filter)} $name", Format.signed(c.filter.toDouble(), 2), c.filter, -1f..1f, 0f, m, color = color, width = width) {
            ctl.setFilter(i, it)
        }
    }
}

/** Headphone cue (PFL): lit in the ON colour, with its inner line, while the channel is in the headphones. */
@Composable
private fun CueToggle(ctl: DecksController, i: Int, modifier: Modifier, word: Boolean) {
    Recomposed(MixerProbe.CUE)
    // One flag of the 60 Hz snapshot: read through a derived state, so the button recomposes when the flag changes.
    val on by remember(ctl, i) { derivedStateOf { ctl.deck(i)?.pfl == true } }
    val name = str(if (i == 0) Str.DeckA else Str.DeckB)
    OnButton(
        if (word) str(Str.Cue).uppercase() else null, "${str(Str.HeadphoneCue)} $name", modifier.tag(MixerTags.cue(i)), on = on, glyph = Glyph.Phones,
        state = str(if (on) Str.On else Str.Off), padH = 2.dp,
    ) { ctl.togglePfl(i) }
}

@Composable
private fun Channel(ctl: DecksController, i: Int, fit: MixerFit, modifier: Modifier) {
    Recomposed(MixerProbe.CHANNEL)
    val c = ctl.controls[i]
    val name = str(if (i == 0) Str.DeckA else Str.DeckB)
    val color = DecksColors.deck(i)
    val left = i == 0
    val knobs = when (fit.knobs) { 5 -> ChannelKnob.entries; 3 -> EQ_ONLY; else -> emptyList() }
    val knobColumn: @Composable () -> Unit = {
        Column(Modifier.width(MixerFit.KNOB_COL.dp).fillMaxHeight(), verticalArrangement = Arrangement.SpaceBetween, horizontalAlignment = Alignment.CenterHorizontally) {
            for (k in knobs) Knob(ctl, i, k)
        }
    }
    val fader: @Composable () -> Unit = {
        FlatFader(
            "${str(Str.Volume)} $name", pct(c.volume), c.volume, 0f..1f, 1f, Modifier.width(fit.faderW.dp).fillMaxHeight().tag(MixerTags.volume(i)),
            look = FaderLook.Channel, color = color,
        ) { ctl.setVolume(i, it) }
    }
    val meter: @Composable () -> Unit = {
        // The level is read while the meter draws: it moves every frame and recomposes nothing.
        if (fit.vuW > 0) SegMeter({ ctl.deck(i)?.vu ?: 0f }, Modifier.width(fit.vuW.dp).fillMaxHeight())
    }
    Column(modifier, verticalArrangement = Arrangement.spacedBy(MixerFit.ROW_GAP.dp)) {
        if (fit.strip) {
            // Channel id: the deck letter between two hairlines in the deck colour.
            Row(Modifier.height(MixerFit.HEAD.dp).fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
                val rule = Modifier.weight(1f).height(1.dp).drawBehind { drawRect(color.copy(alpha = 0.6f)) }
                Box(rule)
                LookLine(if (left) "A" else "B", LookText.style(11f, color, FontWeight.ExtraBold, line = 12f))
                Box(rule)
            }
        }
        // Mirrored: knobs on the outside, the level meter next to the master column.
        Row(Modifier.weight(1f).fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(MixerFit.ROW_GAP.dp)) {
            if (left && knobs.isNotEmpty()) knobColumn()
            Row(Modifier.weight(1f).fillMaxHeight(), horizontalArrangement = Arrangement.spacedBy(fit.vuGap.dp, Alignment.CenterHorizontally)) {
                if (left) { fader(); meter() } else { meter(); fader() }
            }
            if (!left && knobs.isNotEmpty()) knobColumn()
        }
        if (fit.strip) CueToggle(ctl, i, Modifier.fillMaxWidth().height(MixerFit.FOOT.dp), word = fit.channelW >= 56)
    }
}

/** Master column: master level, the two-column master meter, cue mix and headphone level, MORE. */
@Composable
private fun MasterColumn(ctl: DecksController, fit: MixerFit, modifier: Modifier, initialMore: Boolean) {
    val open = remember { mutableStateOf(initialMore) }
    val moreLabel = "${str(Str.MoreControls)}: ${str(Str.Mixer)}"
    Column(modifier, verticalArrangement = Arrangement.spacedBy(MixerFit.ROW_GAP.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        if (fit.masterKnob) {
            Box(Modifier.height(MixerFit.HEAD.dp), contentAlignment = Alignment.Center) { MicroLabel(str(Str.Master)) }
            MasterKnob(ctl, null, fit.masterW.dp)
        }
        SegMeter({ ctl.engine.masterVu }, Modifier.weight(1f).heightIn(min = MixerFit.METER_MIN.dp).width(12.dp), columns = 2)
        if (fit.sends) Sends(ctl, fit.masterW.dp)
        if (fit.more) {
            // Button and popup share one box: the popup anchors to it and adds no gap to the column.
            Box(Modifier.size(MixerFit.FOOT.dp)) {
                OnButton(
                    null, moreLabel, Modifier.fillMaxSize().tag(MixerTags.MORE), on = open.value, glyph = Glyph.More,
                    state = str(if (open.value) Str.On else Str.Off),
                ) { open.value = !open.value }
                if (open.value) {
                    MorePopup(onDismiss = { open.value = false }, preferredWidthDp = MIXER_SHEET_W_DP) { MixerMore(ctl, moreLabel) { open.value = false } }
                }
            }
        }
    }
}

@Composable
private fun MasterKnob(ctl: DecksController, legend: String?, width: Dp) {
    KnobSmall(
        legend, str(Str.MasterVolume), pct(ctl.masterVolume), ctl.masterVolume, 0f..1f, 0.9f, Modifier.tag(MixerTags.MASTER),
        color = DecksColors.foreground, width = width,
    ) { ctl.changeMaster(it) }
}

/** Cue / master mix and headphone level. */
@Composable
private fun Sends(ctl: DecksController, width: Dp) {
    KnobSmall(
        str(Str.LegendMix), str(Str.HeadphoneMix), pct(ctl.cueMix), ctl.cueMix, 0f..1f, 0.5f, Modifier.tag(MixerTags.MIX),
        color = DecksColors.cueButton, width = width,
    ) { ctl.changeCueMix(it) }
    KnobSmall(
        str(Str.LegendPhones), str(Str.HeadphoneLevel), pct(ctl.headphoneLevel), ctl.headphoneLevel, 0f..1f, 0.8f, Modifier.tag(MixerTags.PHONES),
        color = DecksColors.cueButton, width = width,
    ) { ctl.changeHeadphoneLevel(it) }
}

/**
 * MORE of the mixer: every channel control (five knobs, CUE) and the master column's knobs. As wide as
 * [MorePopup] makes it (304 dp of controls, less on a window narrower than 336 dp): each line is a flow
 * of groups that wrap as units, so nothing is squeezed.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun MixerMore(ctl: DecksController, label: String, onClose: () -> Unit) {
    Column(Modifier.fillMaxWidth().tag(MixerTags.SHEET).semantics { contentDescription = label }, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        for (i in 0..1) {
            val color = DecksColors.deck(i)
            FlowRow(
                Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(4.dp), verticalArrangement = Arrangement.spacedBy(6.dp),
                itemVerticalAlignment = Alignment.CenterVertically,
            ) {
                LookLine(if (i == 0) "A" else "B", LookText.style(11f, color, FontWeight.ExtraBold, line = 12f), Modifier.width(12.dp))
                for (k in ChannelKnob.entries) Knob(ctl, i, k, width = 36.dp)
                CueToggle(ctl, i, Modifier.size(width = 56.dp, height = 24.dp), word = true)
            }
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.width(12.dp))
            MasterKnob(ctl, str(Str.Master), 48.dp)
            Sends(ctl, 48.dp)
            Box(Modifier.weight(1f))
            OnButton(null, str(Str.ImportClose), Modifier.size(24.dp).tag(MixerTags.CLOSE), glyph = Glyph.Close, onClick = onClose)
        }
    }
}

/* ── crossfader ───────────────────────────────────────────────────────── */

private fun crossfaderText(v: Float): String =
    if (kotlin.math.abs(v) < 0.005f) "0" else "${if (v < 0) "A" else "B"} ${pct(kotlin.math.abs(v))}"

/** The flat crossfader: no fill, a centre mark, a snap to the centre (double tap or Delete returns to it). */
@Composable
private fun CrossFader(ctl: DecksController, modifier: Modifier) {
    FlatFader(
        str(Str.Crossfader), crossfaderText(ctl.crossfader), ctl.crossfader, -1f..1f, 0f, modifier.tag(MixerTags.CROSSFADER),
        look = FaderLook.Cross, detent = 0f, step = 0.04f,
    ) { ctl.changeCrossfader(it) }
}

@Composable
private fun SideLetter(i: Int) {
    LookLine(if (i == 0) "A" else "B", LookText.style(11f, DecksColors.deck(i), FontWeight.ExtraBold, line = 12f))
}

/** A · fader · B in one row (compact and icon tiers, and the row inside a mixer without a crossfader panel). */
@Composable
private fun CrossfaderRow(ctl: DecksController, modifier: Modifier) {
    Row(modifier, horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
        SideLetter(0)
        CrossFader(ctl, Modifier.weight(1f).fillMaxHeight())
        SideLetter(1)
    }
}

/**
 * The crossfader as its own layout panel (full from 220×84, compact from 180×40, icon from 140×28 dp):
 * a flat fader between A and B (deck colours) with a centre detent. Full: A · CROSSFADER · B over the
 * fader; compact and icon: A, fader, B in one row. (The curve cells of the desktop app need an engine
 * call this app's backend does not have yet.)
 */
@Composable
fun CrossfaderPanel(ctl: DecksController, modifier: Modifier = Modifier, tier: PanelTier = PanelTier.Full) {
    val label = str(Str.Crossfader)
    val padV = when (tier) { PanelTier.Full -> 6.dp; PanelTier.Compact -> 4.dp; PanelTier.Icon -> 2.dp }
    val padH = if (tier == PanelTier.Icon) 6.dp else 8.dp
    Panel(modifier.semantics { contentDescription = label }, verticalPad = padV, horizontalPad = padH) {
        if (tier == PanelTier.Full) {
            Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(4.dp, Alignment.CenterVertically)) {
                Row(Modifier.height(12.dp).fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                    SideLetter(0)
                    MicroLabel(label)
                    SideLetter(1)
                }
                CrossFader(ctl, Modifier.fillMaxWidth().weight(1f, fill = false).heightIn(min = 24.dp, max = 32.dp).fillMaxHeight())
            }
        } else {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                CrossfaderRow(ctl, Modifier.fillMaxWidth().heightIn(min = 24.dp, max = 32.dp).fillMaxHeight())
            }
        }
    }
}
