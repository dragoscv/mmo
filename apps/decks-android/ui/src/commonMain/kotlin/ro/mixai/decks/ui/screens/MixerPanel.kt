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
import ro.mixai.decks.ui.i18n.Str
import ro.mixai.decks.ui.i18n.str
import ro.mixai.decks.ui.logic.Format
import ro.mixai.decks.ui.theme.DecksColors
import ro.mixai.decks.ui.theme.LocalDecksType

/** Two-channel mixer: trim, 3-band EQ, filter, PFL, channel fader, crossfader, master, headphones. */
@Composable
fun MixerPanel(ctl: DecksController, modifier: Modifier = Modifier) {
    val type = LocalDecksType.current
    Panel(modifier) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
            BasicText(str(Str.Mixer), style = type.label, modifier = Modifier.semantics { heading() })
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.Top) {
                Channel(ctl, 0)
                Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Knob(str(Str.Master), str(Str.MasterVolume), "${(ctl.masterVolume * 100).toInt()}%",
                        ctl.masterVolume, 0f..1f, 0.9f) { ctl.changeMaster(it) }
                    Knob(str(Str.HeadphoneMix), str(Str.HeadphoneMix), "${(ctl.cueMix * 100).toInt()}%",
                        ctl.cueMix, 0f..1f, 0.5f, color = DecksColors.warning) { ctl.changeCueMix(it) }
                    Knob(str(Str.HeadphoneLevel), str(Str.HeadphoneLevel), "${(ctl.headphoneLevel * 100).toInt()}%",
                        ctl.headphoneLevel, 0f..1f, 0.8f, color = DecksColors.warning) { ctl.changeHeadphoneLevel(it) }
                    VuMeter(ctl.engine.masterVu, Modifier.height(80.dp))
                }
                Channel(ctl, 1)
            }
            Fader(
                str(Str.Crossfader), Format.fixed(ctl.crossfader.toDouble(), 2), ctl.crossfader, -1f..1f, 0f,
                Modifier.fillMaxWidth().height(36.dp), vertical = false,
            ) { ctl.changeCrossfader(it) }
        }
    }
}

@Composable
private fun Channel(ctl: DecksController, i: Int) {
    val c = ctl.controls[i]
    val d = ctl.deck(i)
    val name = str(if (i == 0) Str.DeckA else Str.DeckB)
    val color = DecksColors.deck(i)
    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Knob(str(Str.Gain), "${str(Str.Gain)} $name", Format.db(c.gainDb), c.gainDb, -12f..12f, 0f, color = color) { ctl.setGain(i, it) }
        Knob(str(Str.EqHigh), "${str(Str.EqHigh)} $name", Format.db(c.eqHigh), c.eqHigh, -26f..6f, 0f, color = color) { ctl.setEq(i, Band.HIGH, it) }
        Knob(str(Str.EqMid), "${str(Str.EqMid)} $name", Format.db(c.eqMid), c.eqMid, -26f..6f, 0f, color = color) { ctl.setEq(i, Band.MID, it) }
        Knob(str(Str.EqLow), "${str(Str.EqLow)} $name", Format.db(c.eqLow), c.eqLow, -26f..6f, 0f, color = color) { ctl.setEq(i, Band.LOW, it) }
        Knob(str(Str.Filter), "${str(Str.Filter)} $name", Format.fixed(c.filter.toDouble(), 2), c.filter, -1f..1f, 0f, color = color) {
            ctl.setFilter(i, it)
        }
        PadButton("🎧", "${str(Str.HeadphoneCue)} $name", active = d?.pfl == true, accent = DecksColors.warning,
            state = str(if (d?.pfl == true) Str.On else Str.Off)) { ctl.togglePfl(i) }
        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            VuMeter(d?.vu ?: 0f, Modifier.height(120.dp))
            Fader(
                "${str(Str.Volume)} $name", "${(c.volume * 100).toInt()}%", c.volume, 0f..1f, 1f,
                Modifier.width(32.dp).height(120.dp), color = color,
            ) { ctl.setVolume(i, it) }
        }
    }
}
