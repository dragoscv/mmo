package ro.mixai.decks.ui.engine

/**
 * `.mixaipack` packs + zero-scroll layout solver (WP19-34, docs/decks/layouts.md "Native apps").
 *
 * The real implementation is [ro.mixai.decks.ui.engine.FfiPacks] over decks-ffi (one Rust solver
 * and one Rust pack verifier for Kotlin and Swift). [DemoPacks] is the pure-Kotlin fallback used by
 * the demo engine and tests: built-in presets only, with a port of the solver that is checked
 * against the same golden fixtures as the TS and Rust solvers (docs/decks/fixtures/layout-cases.json).
 * Sizes are dp (= CSS px of the desktop app).
 */
enum class PanelId(val key: String) {
    DeckA("deckA"), DeckB("deckB"), DeckC("deckC"), DeckD("deckD"), Clock("clock"), Mixer("mixer"),
    Crossfader("crossfader"), Library("library"), Automix("automix"), Sampler("sampler"), Plugins("plugins"),

    /** Scrolling waveforms of every deck in the layout (Decks 1.5); same order as `PANEL_IDS` of types.ts. */
    Waves("waves");

    companion object {
        fun of(key: String): PanelId? = entries.firstOrNull { it.key == key }
    }
}

/** Richest first; the solver picks the first one whose minimum fits. */
enum class PanelTier(val key: String) {
    Full("full"), Compact("compact"), Icon("icon");

    companion object {
        fun of(key: String): PanelTier? = entries.firstOrNull { it.key == key }
    }
}

data class PanelRect(val x: Double, val y: Double, val w: Double, val h: Double) {
    val area: Double get() = w * h
}

data class LayoutArea(val panel: PanelId, val col: Int, val row: Int, val colSpan: Int = 1, val rowSpan: Int = 1)

/** Layout document (same schema as `apps/mixai/src/layout/types.ts`). */
data class LayoutDoc(
    val id: String,
    val name: String,
    val columns: List<Double>,
    val rows: List<Double>,
    val areas: List<LayoutArea>,
    val gap: Double? = null,
) {
    /** Canonical JSON (what decks-ffi `layout_solve` takes). */
    fun toJson(): String = buildString {
        fun num(d: Double) = if (d == kotlin.math.floor(d) && kotlin.math.abs(d) < 1e15) d.toLong().toString() else d.toString()
        fun str(s: String) = "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\""
        append("{\"v\":1,\"id\":").append(str(id)).append(",\"name\":").append(str(name))
        append(",\"columns\":[").append(columns.joinToString(",") { num(it) }).append(']')
        append(",\"rows\":[").append(rows.joinToString(",") { num(it) }).append(']')
        append(",\"areas\":[")
        append(areas.joinToString(",") { a ->
            buildString {
                append("{\"panel\":\"").append(a.panel.key).append("\",\"col\":").append(a.col).append(",\"row\":").append(a.row)
                if (a.colSpan != 1) append(",\"colSpan\":").append(a.colSpan)
                if (a.rowSpan != 1) append(",\"rowSpan\":").append(a.rowSpan)
                append('}')
            }
        })
        append(']')
        gap?.let { append(",\"gap\":").append(num(it)) }
        append('}')
    }
}

data class PanelPlacement(val panel: PanelId, val rect: PanelRect, val tier: PanelTier)

data class LayoutSolution(val placements: List<PanelPlacement>, val docked: List<PanelId>, val dock: PanelRect?)

/**
 * The `style` block of a manifest-v2 skin (`PackStyle` of src/look/style-vars.ts), already validated
 * and resolved by decks-packs. [colors] = style colour key (`well`, `waveLow`, `cue1`, …) → 0xAARRGGBB;
 * [sizes] = style size key (`panelGap`, `controlRadius`, `wavePlayedAlpha`, …) → number.
 */
data class PackStyleUi(
    val look: String? = null,
    val platter: Boolean? = null,
    val layout: String? = null,
    val waves: String? = null,
    val colors: Map<String, Long> = emptyMap(),
    val sizes: Map<String, Double> = emptyMap(),
)

/** A verified pack, flattened for the UI. [colors] = pack token key → 0xRRGGBB (alpha in the high byte). */
data class PackSummaryUi(
    val id: String,
    val name: String,
    val version: String,
    val kind: String,
    val author: String,
    val trust: String,
    val mode: String?,
    val accent: String?,
    val colors: Map<String, Long>,
    val layouts: List<LayoutDoc>,
    /** Manifest schema version: 1, or 2 when the pack may carry a [style] block (Decks 1.5). */
    val manifestV: Int = 1,
    val style: PackStyleUi? = null,
)

interface PackPort {
    /** Built-in presets plus every installed pack layout (ids `<packId>/<layoutId>`). */
    fun layouts(): List<LayoutDoc>

    /** Id of the layout a fresh install starts on (`DEFAULT_LAYOUT` of presets.ts). */
    fun defaultLayoutId(): String = DemoPacks.DEFAULT_LAYOUT_ID

    /** Solve [layout] for a [w] × [h] dp container; panels outside [available] always go to the dock. */
    fun solve(layout: LayoutDoc, w: Double, h: Double, available: Set<PanelId>): LayoutSolution

    /** Smallest container at which every essential panel fits its icon tier. */
    fun minimumSize(layout: LayoutDoc): Pair<Double, Double>

    /** Validate + verify without installing; null when the pack is rejected ([lastError] says why). */
    fun inspect(bytes: ByteArray): PackSummaryUi? = null

    /** Install (verify + store); null when rejected ([lastError] says why). */
    fun install(bytes: ByteArray): PackSummaryUi? = null

    fun list(): List<PackSummaryUi> = emptyList()

    fun remove(id: String): Boolean = false

    /** English reason of the last rejected inspect / install, for the error toast. */
    val lastError: String? get() = null
}

/** Panel minimum sizes (dp) per tier, `PANEL_SPECS` of presets.ts. */
data class PanelSpec(val full: Pair<Double, Double>, val compact: Pair<Double, Double>, val icon: Pair<Double, Double>, val essential: Boolean) {
    fun min(t: PanelTier) = when (t) { PanelTier.Full -> full; PanelTier.Compact -> compact; PanelTier.Icon -> icon }
}

/** Pure-Kotlin fallback: built-in presets + a port of the solver (fixture-tested in LayoutTest). */
object DemoPacks : PackPort {
    const val DEFAULT_GAP = 12.0
    const val FIT_TOLERANCE = 0.5

    /** `DEFAULT_LAYOUT.id` of presets.ts (Decks 1.5: Pro; it was Classic up to 1.4). */
    const val DEFAULT_LAYOUT_ID = "pro"

    // Decks 1.5: a deck is a wide, short strip; the mixer puts its knobs beside the fader when short.
    private val deck = PanelSpec(480.0 to 250.0, 340.0 to 190.0, 220.0 to 110.0, true)
    val specs: Map<PanelId, PanelSpec> = mapOf(
        PanelId.DeckA to deck, PanelId.DeckB to deck, PanelId.DeckC to deck, PanelId.DeckD to deck,
        PanelId.Clock to PanelSpec(220.0 to 72.0, 160.0 to 40.0, 90.0 to 28.0, false),
        PanelId.Mixer to PanelSpec(240.0 to 250.0, 200.0 to 190.0, 150.0 to 110.0, true),
        PanelId.Crossfader to PanelSpec(220.0 to 84.0, 180.0 to 40.0, 140.0 to 28.0, true),
        PanelId.Library to PanelSpec(520.0 to 240.0, 320.0 to 160.0, 200.0 to 96.0, false),
        PanelId.Automix to PanelSpec(230.0 to 230.0, 190.0 to 130.0, 120.0 to 56.0, false),
        PanelId.Sampler to PanelSpec(270.0 to 250.0, 200.0 to 140.0, 120.0 to 56.0, false),
        PanelId.Plugins to PanelSpec(220.0 to 160.0, 160.0 to 96.0, 96.0 to 48.0, false),
        PanelId.Waves to PanelSpec(480.0 to 110.0, 320.0 to 64.0, 200.0 to 36.0, false),
    )

    private fun a(p: PanelId, c: Int, r: Int, cs: Int = 1, rs: Int = 1) = LayoutArea(p, c, r, cs, rs)
    private fun d(vararg w: Int) = w.map { it.toDouble() }

    /** Same order and content as `BUILTIN_LAYOUTS` + `STAGE` of presets.ts (and decks-layout `all_presets`). */
    val presets: List<LayoutDoc> = listOf(
        // Pro (default): waveform band on top, decks around the mixer, library below.
        LayoutDoc("pro", "Pro", d(16, 7, 16), d(7, 12, 2, 19), listOf(
            a(PanelId.Waves, 0, 0, cs = 3), a(PanelId.DeckA, 0, 1, rs = 2), a(PanelId.Mixer, 1, 1), a(PanelId.Crossfader, 1, 2),
            a(PanelId.DeckB, 2, 1, rs = 2), a(PanelId.Library, 0, 3, cs = 3),
        )),
        // Vertical waves: tall parallel waveforms between the decks; the mixer sits beside the library.
        LayoutDoc("pro-vertical", "Vertical waves", d(16, 7, 9, 7), d(19, 2, 19), listOf(
            a(PanelId.DeckA, 0, 0, rs = 2), a(PanelId.Waves, 1, 0), a(PanelId.Crossfader, 1, 1),
            a(PanelId.DeckB, 2, 0, cs = 2, rs = 2), a(PanelId.Library, 0, 2, cs = 3), a(PanelId.Mixer, 3, 2),
        )),
        LayoutDoc("classic", "Classic", d(5, 3, 5), d(1, 9, 2, 6), listOf(
            a(PanelId.DeckA, 0, 0, rs = 3), a(PanelId.Clock, 1, 0), a(PanelId.Mixer, 1, 1), a(PanelId.Crossfader, 1, 2),
            a(PanelId.DeckB, 2, 0, rs = 3), a(PanelId.Library, 0, 3, cs = 2), a(PanelId.Automix, 2, 3),
        )),
        LayoutDoc("performance", "Performance", d(5, 3, 5), d(1, 9, 2, 3), listOf(
            a(PanelId.DeckA, 0, 0, rs = 4), a(PanelId.Clock, 1, 0), a(PanelId.Mixer, 1, 1), a(PanelId.Crossfader, 1, 2),
            a(PanelId.Sampler, 1, 3), a(PanelId.DeckB, 2, 0, rs = 4),
        )),
        LayoutDoc("library", "Library", d(5, 3, 5), d(6, 2, 9), listOf(
            a(PanelId.DeckA, 0, 0, rs = 2), a(PanelId.Mixer, 1, 0), a(PanelId.Crossfader, 1, 1), a(PanelId.DeckB, 2, 0, rs = 2),
            a(PanelId.Library, 0, 2, cs = 2), a(PanelId.Automix, 2, 2),
        )),
        LayoutDoc("four-deck", "4 decks", d(4, 4, 3, 4, 4), d(1, 9, 2, 5), listOf(
            a(PanelId.DeckC, 0, 0, rs = 3), a(PanelId.DeckA, 1, 0, rs = 3), a(PanelId.Clock, 2, 0), a(PanelId.Mixer, 2, 1),
            a(PanelId.Crossfader, 2, 2), a(PanelId.DeckB, 3, 0, rs = 3), a(PanelId.DeckD, 4, 0, rs = 3),
            a(PanelId.Library, 0, 3, cs = 3), a(PanelId.Automix, 3, 3), a(PanelId.Sampler, 4, 3),
        )),
        LayoutDoc("ultrawide", "Ultra-wide", d(4, 5, 3, 5, 3), d(1, 9, 2, 4), listOf(
            a(PanelId.Library, 0, 0, rs = 4), a(PanelId.DeckA, 1, 0, rs = 4), a(PanelId.Clock, 2, 0), a(PanelId.Mixer, 2, 1),
            a(PanelId.Crossfader, 2, 2), a(PanelId.Plugins, 2, 3), a(PanelId.DeckB, 3, 0, rs = 4),
            a(PanelId.Automix, 4, 0, rs = 2), a(PanelId.Sampler, 4, 2, rs = 2),
        )),
        LayoutDoc("stage", "Stage", d(5, 2, 5), d(9, 2), listOf(
            a(PanelId.DeckA, 0, 0, rs = 2), a(PanelId.Mixer, 1, 0), a(PanelId.Crossfader, 1, 1), a(PanelId.DeckB, 2, 0, rs = 2),
        )),
    )

    /** Native-only layout for phones (< 700 dp wide): decks side by side, mixer and library below. */
    val phone = LayoutDoc("phone", "Phone", d(1, 1), d(6, 5, 1, 4), listOf(
        a(PanelId.DeckA, 0, 0), a(PanelId.DeckB, 1, 0), a(PanelId.Mixer, 0, 1, cs = 2),
        a(PanelId.Crossfader, 0, 2, cs = 2), a(PanelId.Library, 0, 3, cs = 2),
    ), gap = 8.0)

    override fun layouts(): List<LayoutDoc> = presets

    data class Track(val start: Double, val size: Double)

    fun tracks(total: Double, weights: List<Double>, gap: Double): List<Track> {
        val n = weights.size
        if (n == 0) return emptyList()
        val sum = weights.sumOf { maxOf(0.0, it) }.takeIf { it != 0.0 } ?: n.toDouble()
        val free = maxOf(0.0, total - gap * (n - 1))
        var at = 0.0
        return weights.map { w ->
            val size = free * maxOf(0.0, w) / sum
            Track(at, size).also { at += size + gap }
        }
    }

    fun fits(r: PanelRect, min: Pair<Double, Double>) = r.w + FIT_TOLERANCE >= min.first && r.h + FIT_TOLERANCE >= min.second

    fun pickTier(r: PanelRect, spec: PanelSpec): PanelTier? = PanelTier.entries.firstOrNull { fits(r, spec.min(it)) }

    override fun solve(layout: LayoutDoc, w: Double, h: Double, available: Set<PanelId>): LayoutSolution {
        val gap = layout.gap ?: DEFAULT_GAP
        val cols = tracks(w, layout.columns, gap)
        val rows = tracks(h, layout.rows, gap)
        val placements = ArrayList<PanelPlacement>()
        val docked = ArrayList<PanelId>()
        for (a in layout.areas) {
            val c0 = cols.getOrNull(a.col)
            val r0 = rows.getOrNull(a.row)
            val c1 = cols.getOrNull(minOf(cols.size - 1, a.col + a.colSpan - 1))
            val r1 = rows.getOrNull(minOf(rows.size - 1, a.row + a.rowSpan - 1))
            if (c0 == null || r0 == null || c1 == null || r1 == null) continue
            if (a.panel !in available) { docked += a.panel; continue }
            val rect = PanelRect(c0.start, r0.start, c1.start + c1.size - c0.start, r1.start + r1.size - r0.start)
            val spec = specs.getValue(a.panel)
            val tier = pickTier(rect, spec)
            when {
                tier != null -> placements += PanelPlacement(a.panel, rect, tier)
                spec.essential -> placements += PanelPlacement(a.panel, rect, PanelTier.Icon)
                else -> docked += a.panel
            }
        }
        var dock: PanelRect? = null
        if (docked.isNotEmpty()) {
            // maxByOrNull keeps the first of equal areas, like the stable sort in solver.ts.
            val host = placements.filter { !specs.getValue(it.panel).essential }.maxByOrNull { it.rect.area }
                ?: placements.maxByOrNull { it.rect.area }
            dock = host?.rect
        }
        return LayoutSolution(placements, docked, dock)
    }

    override fun minimumSize(layout: LayoutDoc): Pair<Double, Double> {
        val gap = layout.gap ?: DEFAULT_GAP
        fun need(weights: List<Double>, horizontal: Boolean): Double {
            val sum = weights.sum()
            var best = 0.0
            for (a in layout.areas) {
                val spec = specs.getValue(a.panel)
                if (!spec.essential) continue
                val start = if (horizontal) a.col else a.row
                val s = if (horizontal) a.colSpan else a.rowSpan
                val share = weights.subList(minOf(start, weights.size), minOf(start + s, weights.size)).sum() / sum
                val min = if (horizontal) spec.icon.first else spec.icon.second
                best = maxOf(best, (min - gap * (s - 1)) / share + gap * (weights.size - 1))
            }
            return kotlin.math.ceil(best)
        }
        return need(layout.columns, true) to need(layout.rows, false)
    }
}
