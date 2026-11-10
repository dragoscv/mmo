package ro.mixai.decks.ui.engine

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import ro.mixai.decks.ffi.DecksException
import ro.mixai.decks.ffi.LayoutPanel
import ro.mixai.decks.ffi.LayoutTier
import ro.mixai.decks.ffi.PackSummary
import ro.mixai.decks.ffi.PackTrustLevel
import ro.mixai.decks.ffi.layoutMinimumSize
import ro.mixai.decks.ffi.layoutPresetsJson
import ro.mixai.decks.ffi.layoutSolve
import ro.mixai.decks.ffi.packInspect
import ro.mixai.decks.ffi.PackStore as FfiPackStore

/**
 * [PackPort] over decks-ffi (WP19-34): Rust pack verification + store + layout solver. [create]
 * returns null when the native library cannot be loaded (the UI then uses [DemoPacks]).
 */
class FfiPacks private constructor(private val store: FfiPackStore?) : PackPort {
    private val presets: List<LayoutDoc> = parseLayouts(layoutPresetsJson()).ifEmpty { DemoPacks.presets }

    @Volatile private var error: String? = null
    override val lastError: String? get() = error

    override fun layouts(): List<LayoutDoc> {
        val extra = runCatching { store?.layoutsJson()?.let(::parseLayouts) }.getOrNull().orEmpty()
        return presets + extra
    }

    override fun solve(layout: LayoutDoc, w: Double, h: Double, available: Set<PanelId>): LayoutSolution = runCatching {
        val s = layoutSolve(layout.toJson(), w, h, available.map { it.ffi() })
        LayoutSolution(
            s.placements.map { PanelPlacement(it.panel.ui(), PanelRect(it.rect.x, it.rect.y, it.rect.w, it.rect.h), it.tier.ui()) },
            s.docked.map { it.ui() },
            s.dock?.let { PanelRect(it.x, it.y, it.w, it.h) },
        )
    }.getOrElse { DemoPacks.solve(layout, w, h, available) }

    override fun minimumSize(layout: LayoutDoc): Pair<Double, Double> = runCatching {
        layoutMinimumSize(layout.toJson()).let { it.w to it.h }
    }.getOrElse { DemoPacks.minimumSize(layout) }

    /**
     * `Throwable`, not just [DecksException]: uniffi raises its own `InternalException` (a plain
     * `Exception`) for a Rust panic / bad handle and JNA raises `UnsatisfiedLinkError` when the
     * native library is missing — a rejected pack must never take the app down.
     */
    private inline fun guarded(block: () -> PackSummary): PackSummaryUi? = try {
        block().ui().also { error = null }
    } catch (e: DecksException) {
        error = (e as? DecksException.Pack)?.reason ?: e.toString()
        null
    } catch (t: Throwable) {
        error = t.message ?: t.toString()
        null
    }

    override fun inspect(bytes: ByteArray): PackSummaryUi? = guarded { packInspect(bytes) }

    override fun install(bytes: ByteArray): PackSummaryUi? {
        val s = store ?: return null.also { error = "no pack folder" }
        return guarded { s.install(bytes) }
    }

    override fun list(): List<PackSummaryUi> = runCatching { store?.list().orEmpty().map { it.ui() } }.getOrDefault(emptyList())

    override fun remove(id: String): Boolean = runCatching { store?.remove(id); store != null }.getOrDefault(false)

    companion object {
        /** [dir] = the packs folder (`filesDir/packs`, `~/.mixai-decks/packs`); null = inspect + solver only. */
        fun create(dir: String?): PackPort? = try {
            FfiPacks(dir?.let { FfiPackStore(it) })
        } catch (_: Throwable) {
            null
        }

        private val json = Json { ignoreUnknownKeys = true }

        private fun JsonElement.num(key: String): Double? = (this as? JsonObject)?.get(key)?.jsonPrimitive?.doubleOrNull

        /** LayoutDoc JSON array → [LayoutDoc]s; entries with unknown panels are skipped. */
        fun parseLayouts(text: String): List<LayoutDoc> = runCatching {
            (json.parseToJsonElement(text) as JsonArray).mapNotNull { el ->
                runCatching {
                    val o = el.jsonObject
                    LayoutDoc(
                        id = o.getValue("id").jsonPrimitive.content,
                        name = o.getValue("name").jsonPrimitive.content,
                        columns = o.getValue("columns").jsonArray.map { it.jsonPrimitive.doubleOrNull!! },
                        rows = o.getValue("rows").jsonArray.map { it.jsonPrimitive.doubleOrNull!! },
                        areas = o.getValue("areas").jsonArray.map { a ->
                            val ao = a.jsonObject
                            LayoutArea(
                                PanelId.of(ao.getValue("panel").jsonPrimitive.content)!!,
                                ao.getValue("col").jsonPrimitive.intOrNull!!,
                                ao.getValue("row").jsonPrimitive.intOrNull!!,
                                ao["colSpan"]?.jsonPrimitive?.intOrNull ?: 1,
                                ao["rowSpan"]?.jsonPrimitive?.intOrNull ?: 1,
                            )
                        },
                        gap = el.num("gap"),
                    )
                }.getOrNull()
            }
        }.getOrDefault(emptyList())

        private fun PanelId.ffi(): LayoutPanel = when (this) {
            PanelId.DeckA -> LayoutPanel.DECK_A
            PanelId.DeckB -> LayoutPanel.DECK_B
            PanelId.DeckC -> LayoutPanel.DECK_C
            PanelId.DeckD -> LayoutPanel.DECK_D
            PanelId.Clock -> LayoutPanel.CLOCK
            PanelId.Mixer -> LayoutPanel.MIXER
            PanelId.Crossfader -> LayoutPanel.CROSSFADER
            PanelId.Library -> LayoutPanel.LIBRARY
            PanelId.Automix -> LayoutPanel.AUTOMIX
            PanelId.Sampler -> LayoutPanel.SAMPLER
            PanelId.Plugins -> LayoutPanel.PLUGINS
        }

        private fun LayoutPanel.ui(): PanelId = when (this) {
            LayoutPanel.DECK_A -> PanelId.DeckA
            LayoutPanel.DECK_B -> PanelId.DeckB
            LayoutPanel.DECK_C -> PanelId.DeckC
            LayoutPanel.DECK_D -> PanelId.DeckD
            LayoutPanel.CLOCK -> PanelId.Clock
            LayoutPanel.MIXER -> PanelId.Mixer
            LayoutPanel.CROSSFADER -> PanelId.Crossfader
            LayoutPanel.LIBRARY -> PanelId.Library
            LayoutPanel.AUTOMIX -> PanelId.Automix
            LayoutPanel.SAMPLER -> PanelId.Sampler
            LayoutPanel.PLUGINS -> PanelId.Plugins
        }

        private fun LayoutTier.ui(): PanelTier = when (this) {
            LayoutTier.FULL -> PanelTier.Full
            LayoutTier.COMPACT -> PanelTier.Compact
            LayoutTier.ICON -> PanelTier.Icon
        }

        private fun PackSummary.ui() = PackSummaryUi(
            id = id, name = name, version = version, kind = kind, author = author,
            trust = when (trust) {
                PackTrustLevel.OFFICIAL -> "official"
                PackTrustLevel.VERIFIED -> "verified"
                PackTrustLevel.COMMUNITY -> "community"
                PackTrustLevel.UNSIGNED -> "unsigned"
            },
            mode = mode, accent = accent,
            colors = colors.associate { c -> c.key to (((c.alpha.coerceIn(0f, 1f) * 255f + 0.5f).toLong() shl 24) or c.rgb.toLong()) },
            layouts = parseLayouts(layoutsJson),
        )
    }
}
