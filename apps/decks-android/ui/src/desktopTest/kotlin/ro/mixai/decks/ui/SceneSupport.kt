package ro.mixai.decks.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.ImageComposeScene
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import ro.mixai.decks.ui.components.LocalFitProbe
import ro.mixai.decks.ui.components.LocalRecomposeProbe
import ro.mixai.decks.ui.engine.DemoBackend
import ro.mixai.decks.ui.i18n.DesktopStrings
import ro.mixai.decks.ui.i18n.LocalStrings
import ro.mixai.decks.ui.theme.DecksSkin
import ro.mixai.decks.ui.theme.DecksTheme

/**
 * Shared by the headless panel tests (ControlPresenceTest, MoreSheetWindowTest, LibraryAccessTest,
 * RecompositionTest): a demo controller and an off-screen scene whose semantics tree, popups included, can be
 * read. Rendered at density 1 (1 px = 1 dp) with the desktop default font, like ContentMinimumsTest.
 */
internal object Scenes {
    /** Two decks loaded, idle; [clock] drives the demo engine's time. */
    fun controller(clock: () -> Double = { 0.0 }): DecksController {
        val ctl = DecksController(DemoBackend(clock))
        ctl.startEngine()
        ctl.loadToDeck(0, DemoBackend.DEMO_TRACKS[0])
        ctl.loadToDeck(1, DemoBackend.DEMO_TRACKS[1])
        repeat(6) { ctl.tick() }
        return ctl
    }

    /**
     * A [windowW] × [windowH] dp window with [content] in a [boxW] × [boxH] dp box at ([x], [y]). [fit] collects
     * what the look controls report when they get too little room; [recomposed] collects the recomposition probe.
     */
    fun scene(
        windowW: Int, windowH: Int, boxW: Int, boxH: Int, x: Int = 0, y: Int = 0,
        lang: String = "en", skin: DecksSkin = DecksSkin.default,
        fit: ((String) -> Unit)? = null, recomposed: ((String) -> Unit)? = null,
        content: @Composable (Modifier) -> Unit,
    ): ImageComposeScene = ImageComposeScene(windowW, windowH, Density(1f)) {
        CompositionLocalProvider(
            LocalStrings provides DesktopStrings.forLanguage(lang),
            LocalFitProbe provides fit,
            LocalRecomposeProbe provides recomposed,
        ) {
            DecksTheme(reducedMotion = true, skin = skin) {
                Box(Modifier.fillMaxSize()) {
                    Box(Modifier.offset(x.dp, y.dp).size(boxW.dp, boxH.dp)) { content(Modifier.fillMaxSize()) }
                }
            }
        }
    }

    /** Two frames: the second one lays out popups that opened in the first. */
    fun ImageComposeScene.settle(): ImageComposeScene {
        render(0)
        render(16_666_667L)
        return this
    }

    /** Every semantics node of the window and of its popups (unmerged tree). */
    fun ImageComposeScene.nodes(): List<SemanticsNode> {
        val out = ArrayList<SemanticsNode>()
        fun walk(n: SemanticsNode) {
            out += n
            for (c in n.children) walk(c)
        }
        for (owner in semanticsOwners) walk(owner.unmergedRootSemanticsNode)
        return out
    }

    fun SemanticsNode.testTag(): String? = config.getOrNull(SemanticsProperties.TestTag)

    fun SemanticsNode.description(): String = config.getOrNull(SemanticsProperties.ContentDescription)?.joinToString(" ").orEmpty()

    fun List<SemanticsNode>.tagged(tag: String): List<SemanticsNode> = filter { it.testTag() == tag }

    /** The first node tagged [tag], or an error that lists the tags that are there. */
    fun List<SemanticsNode>.one(tag: String): SemanticsNode =
        firstOrNull { it.testTag() == tag } ?: error("no node tagged '$tag'; tags: ${mapNotNull { it.testTag() }.distinct().sorted()}")

    /** True when [n] lies inside the node tagged [ancestorTag] (walks the parents). */
    fun SemanticsNode.isInside(ancestorTag: String): Boolean {
        var p: SemanticsNode? = parent
        while (p != null) {
            if (p.testTag() == ancestorTag) return true
            p = p.parent
        }
        return false
    }

    /** Runs the click action of [n] (what a tap, Enter or TalkBack's double tap does). */
    fun SemanticsNode.click(): Boolean = config.getOrNull(SemanticsActions.OnClick)?.action?.invoke() == true

    /** Bounds in window coordinates before clipping: a control pushed out of the window keeps its real position here. */
    fun SemanticsNode.windowRect(): Rect = Rect(positionInWindow.x, positionInWindow.y, positionInWindow.x + size.width, positionInWindow.y + size.height)
}
