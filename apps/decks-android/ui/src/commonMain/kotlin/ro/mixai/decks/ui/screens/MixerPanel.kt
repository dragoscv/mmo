package ro.mixai.decks.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import ro.mixai.decks.ui.DecksController
import ro.mixai.decks.ui.components.Fader
import ro.mixai.decks.ui.components.Knob
import ro.mixai.decks.ui.components.PadButton
import ro.mixai.decks.ui.components.Panel
import ro.mixai.decks.ui.components.VuMeter
import ro.mixai.decks.ui.engine.Band
import ro.mixai.decks.ui.engine.PanelTier
import ro.mixai.decks.ui.i18n.Str
import ro.mixai.decks.ui.i18n.str
import ro.mixai.decks.ui.logic.Format
import ro.mixai.decks.ui.theme.DecksColors
import ro.mixai.decks.ui.theme.LocalDecksType

/**
 * Two-channel mixer at a layout tier (WP19-34). Full: trim, 3-band EQ, filter, PFL, channel fader,
 * master, headphones. Compact: EQ beside the PFL + channel fader (no trim, no filter, no headphone
 * knobs), a short strip. Icon: the two channel faders and PFL only. The crossfader is its own
 * layout panel ([CrossfaderPanel]); pass [withCrossfader] when the layout has no crossfader area.
 */
@Composable
fun MixerPanel(ctl: DecksController, modifier: Modifier = Modifier, tier: PanelTier = PanelTier.Full, withCrossfader: Boolean = false) {
    val type = LocalDecksType.current
    Panel(modifier) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
            BasicText(str(Str.Mixer), style = type.label, modifier = Modifier.semantics { heading() })
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.Top) {
                Channel(ctl, 0, tier)
                if (tier == PanelTier.Full) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Knob(str(Str.Master), str(Str.MasterVolume), "${(ctl.masterVolume * 100).toInt()}%",
                            ctl.masterVolume, 0f..1f, 0.9f) { ctl.changeMaster(it) }
                        Knob(str(Str.HeadphoneMix), str(Str.HeadphoneMix), "${(ctl.cueMix * 100).toInt()}%",
                            ctl.cueMix, 0f..1f, 0.5f, color = DecksColors.warning) { ctl.changeCueMix(it) }
                        Knob(str(Str.HeadphoneLevel), str(Str.HeadphoneLevel), "${(ctl.headphoneLevel * 100).toInt()}%",
                            ctl.headphoneLevel, 0f..1f, 0.8f, color = DecksColors.warning) { ctl.changeHeadphoneLevel(it) }
                        VuMeter(ctl.engine.masterVu, Modifier.height(80.dp))
                    }
                } else {
                    VuMeter(ctl.engine.masterVu, Modifier.height(if (tier == PanelTier.Icon) 64.dp else 100.dp))
                }
                Channel(ctl, 1, tier)
            }
            if (withCrossfader) CrossfaderFader(ctl)
        }
    }
}

/**
 * The crossfader as its own layout panel: label + fader ([CROSSFADER_LABELLED_DP] high); the icon
 * tier is the fader alone with 2 dp above and below, so it fits a [CROSSFADER_FADER_ONLY_DP] slot
 * (the layouts give this row 2 of ~40 parts of the height).
 */
@Composable
fun CrossfaderPanel(ctl: DecksController, modifier: Modifier = Modifier, tier: PanelTier = PanelTier.Full) {
    if (tier == PanelTier.Icon) {
        Panel(modifier, verticalPad = 2.dp) { CrossfaderFader(ctl) }
        return
    }
    Panel(modifier) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp)) {
            BasicText(str(Str.Crossfader), style = LocalDecksType.current.label)
            CrossfaderFader(ctl)
        }
    }
}

@Composable
private fun CrossfaderFader(ctl: DecksController) {
    Fader(
        str(Str.Crossfader), Format.fixed(ctl.crossfader.toDouble(), 2), ctl.crossfader, -1f..1f, 0f,
        Modifier.fillMaxWidth().height(28.dp), vertical = false,
    ) { ctl.changeCrossfader(it) }
}

@Composable
private fun Channel(ctl: DecksController, i: Int, tier: PanelTier) {
    val c = ctl.controls[i]
    val d = ctl.deck(i)
    val name = str(if (i == 0) Str.DeckA else Str.DeckB)
    val color = DecksColors.deck(i)
    val faderH = when (tier) { PanelTier.Full -> 120.dp; PanelTier.Compact -> 90.dp; PanelTier.Icon -> 64.dp }
    val eq: @Composable (androidx.compose.ui.unit.Dp) -> Unit = { k ->
        Knob(str(Str.EqHigh), "${str(Str.EqHigh)} $name", Format.db(c.eqHigh), c.eqHigh, -26f..6f, 0f, color = color, size = k) { ctl.setEq(i, Band.HIGH, it) }
        Knob(str(Str.EqMid), "${str(Str.EqMid)} $name", Format.db(c.eqMid), c.eqMid, -26f..6f, 0f, color = color, size = k) { ctl.setEq(i, Band.MID, it) }
        Knob(str(Str.EqLow), "${str(Str.EqLow)} $name", Format.db(c.eqLow), c.eqLow, -26f..6f, 0f, color = color, size = k) { ctl.setEq(i, Band.LOW, it) }
    }
    val strip: @Composable () -> Unit = {
        PadButton("🎧", "${str(Str.HeadphoneCue)} $name", active = d?.pfl == true, accent = DecksColors.warning,
            state = str(if (d?.pfl == true) Str.On else Str.Off)) { ctl.togglePfl(i) }
        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            VuMeter(d?.vu ?: 0f, Modifier.height(faderH))
            Fader(
                "${str(Str.Volume)} $name", "${(c.volume * 100).toInt()}%", c.volume, 0f..1f, 1f,
                Modifier.width(32.dp).height(faderH), color = color,
            ) { ctl.setVolume(i, it) }
        }
    }
    if (tier == PanelTier.Compact) {
        // Short strip: the EQ sits beside the fader instead of above it, so the compact mixer needs about
        // 190 dp of height (it needed about 320 stacked, more than the mixer row of the layouts gives at 768).
        Row(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.Bottom) {
            Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp)) { eq(32.dp) }
            Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp)) { strip() }
        }
        return
    }
    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp)) {
        if (tier == PanelTier.Full) {
            Knob(str(Str.Gain), "${str(Str.Gain)} $name", Format.db(c.gainDb), c.gainDb, -12f..12f, 0f, color = color) { ctl.setGain(i, it) }
        }
        if (tier != PanelTier.Icon) {
            eq(44.dp)
            Knob(str(Str.Filter), "${str(Str.Filter)} $name", Format.fixed(c.filter.toDouble(), 2), c.filter, -1f..1f, 0f, color = color) {
                ctl.setFilter(i, it)
            }
        }
        strip()
    }
}
