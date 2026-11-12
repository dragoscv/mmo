package ro.mixai.decks.ui

import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.pointer.PointerEventType
import kotlin.test.Test
import kotlin.test.assertEquals
import ro.mixai.decks.ui.Scenes.settle
import ro.mixai.decks.ui.components.BtnKind
import ro.mixai.decks.ui.components.OnButton
import ro.mixai.decks.ui.components.PadButton

/**
 * A momentary button (CUE) that leaves the screen while a finger holds it. The reviewed bug: the CUE of an icon
 * deck's MORE sheet was held with one finger, a second finger tapped outside, the sheet closed, and the release
 * never reached the engine: the deck kept playing from a CUE nobody held.
 */
class HeldButtonTest {
    private val frame = 16_666_667L

    private fun run(pad: Boolean): List<String> {
        val log = ArrayList<String>()
        val shown = mutableStateOf(true)
        val scene = Scenes.scene(200, 120, 120, 60, x = 20, y = 20) { m ->
            if (shown.value) {
                if (pad) PadButton("CUE", "Cue", m, onPress = { log += "press" }, onRelease = { log += "release" })
                else OnButton("CUE", "Cue", m, kind = BtnKind.Cue, onPress = { log += "press" }, onRelease = { log += "release" })
            }
        }
        try {
            scene.settle()
            scene.sendPointerEvent(PointerEventType.Press, Offset(80f, 50f))
            scene.render(2 * frame)
            scene.render(3 * frame)
            assertEquals(listOf("press"), log, "the finger is down on the button")
            // The button goes away under the finger (its sheet was dismissed).
            shown.value = false
            Snapshot.sendApplyNotifications()
            scene.render(4 * frame)
            scene.render(5 * frame)
            // The finger lifts later, over nothing.
            scene.sendPointerEvent(PointerEventType.Release, Offset(80f, 50f))
            scene.render(6 * frame)
        } finally {
            scene.close()
        }
        return log
    }

    @Test fun aHeldLookButtonLetsGoWhenItLeavesTheScreen() {
        assertEquals(listOf("press", "release"), run(pad = false), "one release, when the button was removed")
    }

    @Test fun aHeldPadButtonLetsGoWhenItLeavesTheScreen() {
        assertEquals(listOf("press", "release"), run(pad = true), "one release, when the button was removed")
    }

    @Test fun aNormalPressAndReleaseStillReleasesOnce() {
        val log = ArrayList<String>()
        val scene = Scenes.scene(200, 120, 120, 60, x = 20, y = 20) { m ->
            OnButton("CUE", "Cue", m, kind = BtnKind.Cue, onPress = { log += "press" }, onRelease = { log += "release" })
        }
        try {
            scene.settle()
            scene.sendPointerEvent(PointerEventType.Press, Offset(80f, 50f))
            scene.render(2 * frame)
            scene.sendPointerEvent(PointerEventType.Release, Offset(80f, 50f))
            scene.render(3 * frame)
            scene.render(4 * frame)
            assertEquals(listOf("press", "release"), log)
        } finally {
            scene.close()
        }
        assertEquals(listOf("press", "release"), log, "closing the scene with nothing held releases nothing more")
    }
}
