package ro.mixai.decks.ui

import java.io.File
import kotlin.math.abs
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.double
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import ro.mixai.decks.ui.engine.DemoPacks
import ro.mixai.decks.ui.engine.FfiPacks
import ro.mixai.decks.ui.engine.LayoutDoc
import ro.mixai.decks.ui.engine.LayoutSolution
import ro.mixai.decks.ui.engine.PackPort
import ro.mixai.decks.ui.engine.PanelPlacement
import ro.mixai.decks.ui.engine.PanelId
import ro.mixai.decks.ui.engine.PanelRect
import ro.mixai.decks.ui.engine.PanelTier
import ro.mixai.decks.ffi.LayoutPanel
import ro.mixai.decks.ffi.layoutMinimumSize
import ro.mixai.decks.ffi.layoutPresetsJson
import ro.mixai.decks.ffi.layoutSolve

/**
 * Golden fixtures shared with the TS solver (source of truth) and decks-layout (WP19-34):
 * docs/decks/fixtures/layout-cases.json. Both the Kotlin demo solver and the decks-ffi solver must
 * reproduce every case.
 */
class LayoutFixturesTest {
    private val repo: File = generateSequence(File(System.getProperty("user.dir")).absoluteFile) { it.parentFile }
        .first { File(it, "docs/decks/fixtures/layout-cases.json").isFile }
    private val root: JsonObject = Json.parseToJsonElement(File(repo, "docs/decks/fixtures/layout-cases.json").readText()).jsonObject
    private val layouts = FfiPacks.parseLayouts(root.getValue("layouts").toString())
    private val all = PanelId.entries.toSet()

    private fun rect(o: JsonObject) = PanelRect(
        o.getValue("x").jsonPrimitive.double, o.getValue("y").jsonPrimitive.double,
        o.getValue("w").jsonPrimitive.double, o.getValue("h").jsonPrimitive.double,
    )

    private fun close(a: PanelRect?, b: PanelRect?) = (a == null && b == null) ||
        (a != null && b != null && abs(a.x - b.x) < 1e-9 && abs(a.y - b.y) < 1e-9 && abs(a.w - b.w) < 1e-9 && abs(a.h - b.h) < 1e-9)

    private fun matches(got: LayoutSolution, want: JsonObject): Boolean {
        val wp = want.getValue("placements").jsonArray.map { it.jsonObject }
        val docked = want.getValue("docked").jsonArray.map { PanelId.of(it.jsonPrimitive.content)!! }
        val dock = (want["dock"] as? JsonObject)?.let(::rect)
        return got.docked == docked && close(got.dock, dock) && got.placements.size == wp.size &&
            got.placements.zip(wp).all { (g, w) ->
                g.panel.key == w.getValue("panel").jsonPrimitive.content &&
                    g.tier == PanelTier.of(w.getValue("tier").jsonPrimitive.content) &&
                    close(g.rect, rect(w.getValue("rect").jsonObject))
            }
    }

    private fun check(port: PackPort, name: String) {
        val cases = root.getValue("cases").jsonArray.map { it.jsonObject }
        assertTrue(cases.size >= 300, "${cases.size} cases")
        val bad = cases.filterNot { c ->
            val l = layouts.first { it.id == c.getValue("layout").jsonPrimitive.content }
            matches(port.solve(l, c.getValue("w").jsonPrimitive.double, c.getValue("h").jsonPrimitive.double, all), c.getValue("solution").jsonObject)
        }.map { "${it["layout"]} ${it["w"]}x${it["h"]}" }
        assertTrue(bad.isEmpty(), "$name: ${bad.size} of ${cases.size} cases differ from TS, first ${bad.take(5)}")
        for (m in root.getValue("minimum").jsonArray.map { it.jsonObject }) {
            val l = layouts.first { it.id == m.getValue("layout").jsonPrimitive.content }
            val s = m.getValue("size").jsonObject
            assertEquals(s.getValue("w").jsonPrimitive.double to s.getValue("h").jsonPrimitive.double, port.minimumSize(l), "$name ${l.id}")
        }
    }

    @Test fun fixturePresetsEqualTheKotlinPresets() {
        assertEquals(DemoPacks.presets, layouts)
    }

    @Test fun demoSolverMatchesTheGoldenCases() = check(DemoPacks, "demo")

    /**
     * Guards P1-19 itself: [FfiPacks] silently falls back to the Kotlin solver, so a parity test
     * written against it would be green even with Rust dead. Asserting that the fallback really
     * happens (invalid layout JSON → a Kotlin answer instead of a throw) proves the parity test
     * above had to bypass [FfiPacks] to mean anything, and that [RustSolver] does throw.
     */
    @Test fun ffiPacksFallsBackSilentlySoTheParityTestMustCallRustDirectly() {
        ensureFfiLibrary()
        val port = assertNotNull(FfiPacks.create(null), "decks_ffi host library must load for this test")
        // A layout the Rust parser rejects (zero columns/rows).
        val broken = LayoutDoc("broken", "broken", emptyList(), emptyList(), emptyList())
        assertEquals(DemoPacks.solve(broken, 1280.0, 800.0, all), port.solve(broken, 1280.0, 800.0, all), "FfiPacks swallows it")
        assertEquals(DemoPacks.minimumSize(broken), port.minimumSize(broken), "FfiPacks swallows it")
        assertFailsWith<Throwable>("the direct Rust solver must surface the failure") {
            RustSolver.solve(broken, 1280.0, 800.0, all)
        }
        assertFailsWith<Throwable>("the direct Rust solver must surface the failure") { RustSolver.minimumSize(broken) }
    }

    @Test fun ffiSolverMatchesTheGoldenCases() {
        ensureFfiLibrary()
        // Through `layoutSolve` / `layoutMinimumSize` DIRECTLY, never through FfiPacks: that class
        // falls back to the Kotlin DemoPacks solver on any exception, so testing it would pass even
        // if Rust threw on every case (WP19-40 P1-19). A missing / broken native library must FAIL
        // this test, so the throw is deliberately not caught.
        assertEquals(
            DemoPacks.presets, FfiPacks.parseLayouts(layoutPresetsJson()),
            "layout_presets_json == the Kotlin presets",
        )
        check(RustSolver, "ffi")
    }

    /**
     * The Rust solver with NO fallback: the only [PackPort] methods [check] uses are [solve] and
     * [minimumSize], and each one calls the UniFFI function straight through.
     */
    private object RustSolver : PackPort {
        override fun layouts(): List<LayoutDoc> = FfiPacks.parseLayouts(layoutPresetsJson())

        override fun solve(layout: LayoutDoc, w: Double, h: Double, available: Set<PanelId>): LayoutSolution {
            val s = layoutSolve(layout.toJson(), w, h, available.map { ffiPanel(it) })
            return LayoutSolution(
                s.placements.map {
                    PanelPlacement(
                        PanelId.of(it.panel.name.lowercase().toPanelKey())!!,
                        PanelRect(it.rect.x, it.rect.y, it.rect.w, it.rect.h),
                        PanelTier.of(it.tier.name.lowercase())!!,
                    )
                },
                s.docked.map { PanelId.of(it.name.lowercase().toPanelKey())!! },
                s.dock?.let { PanelRect(it.x, it.y, it.w, it.h) },
            )
        }

        override fun minimumSize(layout: LayoutDoc): Pair<Double, Double> =
            layoutMinimumSize(layout.toJson()).let { it.w to it.h }

        /** `DECK_A` → `deckA`, `MIXER` → `mixer` (the UniFFI enum name → the [PanelId] key). */
        private fun String.toPanelKey(): String {
            val parts = split('_')
            return parts.first() + parts.drop(1).joinToString("") { it.replaceFirstChar(Char::uppercaseChar) }
        }

        private fun ffiPanel(p: PanelId): LayoutPanel =
            LayoutPanel.entries.first { it.name.lowercase().toPanelKey() == p.key }
    }

    /** Point UniFFI at the host library built by :decks-core:cargoBuildHostFfi (same as DesktopDecks.configureLibrary). */
    private fun ensureFfiLibrary() {
        val key = "uniffi.component.decks_ffi.libraryOverride"
        if (System.getProperty(key) != null) return
        val name = System.mapLibraryName("decks_ffi")
        val target = System.getenv("CARGO_TARGET_DIR")?.let(::File) ?: File(repo, "apps/mixai/src-tauri/target")
        listOfNotNull(System.getProperty("decks.ffi.path")?.let(::File), File(target, "debug/$name"))
            .firstOrNull { it.isFile }?.let { System.setProperty(key, it.absolutePath) }
    }
}
