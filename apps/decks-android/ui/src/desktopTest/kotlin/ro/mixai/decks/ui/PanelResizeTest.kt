package ro.mixai.decks.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.ImageComposeScene
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import ro.mixai.decks.ui.Scenes.nodes
import ro.mixai.decks.ui.Scenes.testTag
import ro.mixai.decks.ui.engine.PanelId
import ro.mixai.decks.ui.i18n.DesktopStrings
import ro.mixai.decks.ui.i18n.LocalStrings
import ro.mixai.decks.ui.screens.DeckPanel
import ro.mixai.decks.ui.screens.DeckTags
import ro.mixai.decks.ui.screens.tierFor
import ro.mixai.decks.ui.theme.DecksSkin
import ro.mixai.decks.ui.theme.DecksTheme

/**
 * The dead band of the arrangements (`FitLag`, arithmetic in commonTest/FitLagTest) as the RENDERED deck applies
 * it: a deck panel is dragged one dp at a time across the width where it becomes a full deck (480 dp), with the
 * tier the solver gives for each width. The full deck is told apart by its elapsed-time readout, which only the
 * two-row header has.
 */
class PanelResizeTest {
    @Test fun aRenderedDeckBecomesFullLateWhenItGrowsAndStaysFullDownToTheThresholdWhenItShrinks() {
        val ctl = Scenes.controller()
        val height = 260
        var width by mutableStateOf(470)
        val scene = ImageComposeScene(640, 400, Density(1f)) {
            CompositionLocalProvider(LocalStrings provides DesktopStrings.forLanguage("en")) {
                DecksTheme(reducedMotion = true, skin = DecksSkin.default) {
                    Box(Modifier.size(width.dp, height.dp)) {
                        DeckPanel(ctl, 0, Modifier.fillMaxSize(), tierFor(PanelId.DeckA, width.toDouble(), height.toDouble()))
                    }
                }
            }
        }
        try {
            var t = 0L
            fun fullAt(w: Int): Boolean {
                width = w
                Snapshot.sendApplyNotifications()
                repeat(2) {
                    scene.render(t)
                    t += 16_666_667L
                }
                return scene.nodes().any { it.testTag() == DeckTags.ELAPSED }
            }
            assertTrue(!fullAt(470), "470 dp wide: a compact deck")
            val growing = (471..500).associateWith { fullAt(it) }
            val firstFull = growing.entries.first { it.value }.key
            assertEquals(486, firstFull, "growing: the solver says full from 480 dp, the panel takes it 6 dp later: $growing")
            assertTrue(growing.filterKeys { it >= firstFull }.values.all { it }, "and stays full while it keeps growing")
            val shrinking = (499 downTo 470).associateWith { fullAt(it) }
            val lastFull = shrinking.entries.last { it.value }.key
            assertEquals(480, lastFull, "shrinking: full down to the threshold itself: $shrinking")
            // One dp back and forth across the threshold: the arrangement does not flip at every step.
            fullAt(470)
            val wobble = List(20) { fullAt(if (it % 2 == 0) 480 else 479) }
            assertTrue(wobble.none { it }, "480 / 479 after growing from 470: the deck stays compact: $wobble")
        } finally {
            scene.close()
        }
    }
}
