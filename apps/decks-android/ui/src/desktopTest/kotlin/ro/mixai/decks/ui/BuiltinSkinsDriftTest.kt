package ro.mixai.decks.ui

import androidx.compose.ui.graphics.Color
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue
import ro.mixai.decks.ui.theme.BuiltinSkins
import ro.mixai.decks.ui.theme.DecksColors
import ro.mixai.decks.ui.theme.DecksSkin
import ro.mixai.decks.ui.theme.Oklab

/**
 * `theme/Look.kt` `BuiltinSkins` is a hand mirror of `apps/mixai/src/packs/builtin-skins.ts`
 * (Mainroom, Crate, Pilot). This test READS the TS file — the source of truth — and compares every
 * colour, size and flag with the Kotlin palettes, so the mirror cannot drift unnoticed (it had,
 * within hours: 8 Crate and 5 Pilot values, with SkinTest pinning the stale Kotlin literals).
 */
class BuiltinSkinsDriftTest {
    private val repo: File = generateSequence(File(System.getProperty("user.dir")).absoluteFile) { it.parentFile }
        .first { File(it, "apps/mixai/src/packs/builtin-skins.ts").isFile }
    private val source: String = File(repo, "apps/mixai/src/packs/builtin-skins.ts").readText()
        // Line comments carry "≈ #rrggbb" hints; no string in the file contains "//".
        .lines().joinToString("\n") { it.substringBefore("//") }

    /** Minimal reader for the object literals of the file: quoted or bare keys, strings, numbers, booleans, nesting. */
    private class Literal(private val s: String, private var i: Int) {
        private fun skip() {
            while (i < s.length && (s[i].isWhitespace() || s[i] == ',')) i++
        }

        private fun string(): String {
            val end = s.indexOf('"', i + 1)
            check(end > i) { "unterminated string at $i" }
            return s.substring(i + 1, end).also { i = end + 1 }
        }

        fun obj(): Map<String, Any> {
            check(s[i] == '{') { "object expected at $i" }
            i++
            val m = LinkedHashMap<String, Any>()
            while (true) {
                skip()
                if (s[i] == '}') {
                    i++
                    return m
                }
                val key = if (s[i] == '"') string() else {
                    val st = i
                    while (s[i].isLetterOrDigit() || s[i] == '_') i++
                    s.substring(st, i)
                }
                check(key.isNotEmpty()) { "key expected at $i" }
                skip()
                check(s[i] == ':') { "':' expected after $key" }
                i++
                skip()
                check(m.put(key, when (s[i]) {
                    '{' -> obj()
                    '"' -> string()
                    else -> {
                        val st = i
                        while (s[i] != ',' && s[i] != '}' && s[i] != '\n') i++
                        s.substring(st, i).trim()
                    }
                }) == null) { "duplicate key $key" }
            }
        }
    }

    private fun tokens(const: String): Map<String, Any> {
        val head = "const $const: PackTokens = "
        val at = source.indexOf(head)
        assertTrue(at >= 0, "$const not found in builtin-skins.ts")
        return Literal(source, at + head.length).obj()
    }

    @Suppress("UNCHECKED_CAST")
    private fun Map<String, Any>.sub(key: String): Map<String, Any> = (this[key] as? Map<String, Any>) ?: error("no `$key` block")

    private fun hex(c: Color) = "#" + DecksColors.rgb(c).toString(16).padStart(6, '0')

    /** Every difference between a TS colour block and its Kotlin mirror, as readable lines. */
    private fun diff(where: String, ts: Map<String, Any>, kotlin: Map<String, Color>): List<String> {
        val out = ArrayList<String>()
        for ((k, v) in ts) {
            val want = BuiltinSkins.color(v as String)
            val got = kotlin[k]
            if (got == null) out += "$where.$k: missing in Look.kt (TS $v)"
            else if (got != want) out += "$where.$k: Look.kt ${hex(got)} != TS $v (${hex(want)})"
        }
        for (k in kotlin.keys - ts.keys) out += "$where.$k: in Look.kt but not in TS"
        return out
    }

    private fun drift(): List<String> {
        val out = ArrayList<String>()
        for ((const, id) in listOf("MAINROOM" to "mainroom", "CRATE" to "crate", "PILOT" to "pilot")) {
            val ts = tokens(const)
            val style = ts.sub("style")
            val kt = BuiltinSkins.style(id) ?: error("no Kotlin style for $id")
            // A parse that found nothing must not pass as "no drift".
            assertTrue(ts.sub("colors").size >= 17 && style.sub("colors").size >= 20 && ts.sub("decks").size == 4, "$const parsed")
            out += diff("$id.colors", ts.sub("colors"), kt.base)
            out += diff("$id.style.colors", style.sub("colors"), kt.colors)
            out += diff("$id.decks", ts.sub("decks"), listOf("a", "b", "c", "d").zip(kt.decks).toMap())
            val sizes = style.sub("sizes").mapValues { (it.value as String).toDouble() }
            if (sizes != kt.sizes) out += "$id.style.sizes: Look.kt ${kt.sizes} != TS $sizes"
            if (style["waves"] != kt.waves) out += "$id.style.waves: Look.kt ${kt.waves} != TS ${style["waves"]}"
            val platter = (style["platter"] as String?)?.toBooleanStrict()
            if (platter != kt.platter) out += "$id.style.platter: Look.kt ${kt.platter} != TS $platter"
            if (style["look"] != "signature") out += "$id.style.look: TS ${style["look"]}, the Kotlin preset assumes signature"
            // Token dimensions of the preset (the layout is deliberately not compared: see DecksSkin.DEFAULT_LAYOUT).
            val preset = DecksSkin.presets.first { it.id == id }
            val dims = mapOf("mode" to if (preset.dark) "dark" else "light", "surface" to preset.surface, "density" to preset.density, "radius" to preset.radius)
            for ((k, v) in dims) if (ts[k] != v) out += "$id.$k: preset $v != TS ${ts[k]}"
        }
        return out
    }

    @Test fun kotlinSkinPalettesEqualBuiltinSkinsTs() {
        val d = drift()
        assertTrue(d.isEmpty(), "${d.size} value(s) of theme/Look.kt differ from apps/mixai/src/packs/builtin-skins.ts (TS wins):\n" + d.joinToString("\n"))
    }

    @Test fun colourLiteralsAreParsedStrictly() {
        assertEquals(Color(0x12, 0x34, 0x56, 255), BuiltinSkins.color("#123456"))
        assertEquals(Oklab.toSrgb(0.874, 0.003, 286.0), BuiltinSkins.color("oklch(0.874 0.003 286)").let {
            DecksColors.rgb(it).toInt().let { v -> Triple(v shr 16, (v shr 8) and 0xFF, v and 0xFF) }
        })
        // 8 digits would shift the channels, 3 digits and typos would throw at launch: all refused here, in tests.
        for (bad in listOf("#12345678", "#123", "123456", "#12345g", "", "oklch(0.5 0.1)", "oklch(a b c)", "rgb(1 2 3)")) {
            assertFailsWith<IllegalArgumentException>(bad) { BuiltinSkins.color(bad) }
        }
    }
}
