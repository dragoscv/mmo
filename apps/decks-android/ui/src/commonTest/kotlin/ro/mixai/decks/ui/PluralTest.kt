package ro.mixai.decks.ui

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import ro.mixai.decks.ui.i18n.Counted
import ro.mixai.decks.ui.i18n.DesktopStrings
import ro.mixai.decks.ui.i18n.Str
import ro.mixai.decks.ui.i18n.counted
import ro.mixai.decks.ui.i18n.countedBeats
import ro.mixai.decks.ui.i18n.pluralLang
import ro.mixai.decks.ui.logic.Format
import ro.mixai.decks.ui.logic.Plural

/**
 * Counted sentences ("5 piese", "20 de piese", "Salt de 1 bătaie"): the plural form comes from the language's own
 * rule (logic/Format.kt `pluralCategory`), the sentence from the `<key>_one` / `_few` / `_other` strings. The same
 * rule and wording as the desktop app (apps/mixai `pluralCategory`, `beatsPlural`, messages-library / -decktabs).
 */
class PluralTest {
    @Test fun romanianOneFewAndTheFormWithDe() {
        val want = linkedMapOf(
            0L to Plural.Few, 1L to Plural.One, 2L to Plural.Few, 19L to Plural.Few, 20L to Plural.Other, 21L to Plural.Other,
            100L to Plural.Other, 101L to Plural.Few, 119L to Plural.Few, 120L to Plural.Other,
        )
        for ((n, form) in want) assertEquals(form, Format.pluralCategory("ro", n), "ro $n")
        // The rule is about the last two digits, at any size, and the sign does not matter.
        for (n in listOf(5L, 11L, 102L, 201L, 219L, 1001L, 1_000_019L, -5L)) assertEquals(Plural.Few, Format.pluralCategory("ro", n), "ro $n")
        for (n in listOf(32L, 64L, 99L, 200L, 220L, 1000L, 1_000_000L, -20L)) assertEquals(Plural.Other, Format.pluralCategory("ro", n), "ro $n")
        assertEquals(Plural.One, Format.pluralCategory("ro", -1L))
        // Only 1 itself is "one": 21, 101 and 1001 are not.
        assertEquals(listOf(1L), (0L..2000L).filter { Format.pluralCategory("ro", it) == Plural.One })
    }

    @Test fun englishOneAndOther() {
        assertEquals(Plural.Other, Format.pluralCategory("en", 0L))
        assertEquals(Plural.One, Format.pluralCategory("en", 1L))
        assertEquals(Plural.Other, Format.pluralCategory("en", 2L))
        for (n in listOf(5L, 19L, 20L, 21L, 100L, 101L, 119L, 120L)) assertEquals(Plural.Other, Format.pluralCategory("en", n), "en $n")
        assertTrue((0L..2000L).none { Format.pluralCategory("en", it) == Plural.Few }, "English has no few form")
    }

    @Test fun theLanguageIsRomanianByItsTagAndEnglishOtherwise() {
        for (lang in listOf("ro", "RO", "ro-RO", "ro_MD")) assertEquals(Plural.Few, Format.pluralCategory(lang, 5L), lang)
        for (lang in listOf("en", "en-GB", "", "fr", "de")) assertEquals(Plural.Other, Format.pluralCategory(lang, 5L), "'$lang'")
    }

    @Test fun aCountWithAFractionIsOtherInEnglishAndFewInRomanian() {
        for (n in listOf(0.5, 0.25, 1.5, 3.5, 20.5)) {
            assertEquals(Plural.Other, Format.pluralCategory("en", n), "en $n")
            assertEquals(Plural.Few, Format.pluralCategory("ro", n), "ro $n")
        }
        // A whole number written as a double follows the whole-number rule.
        assertEquals(Plural.One, Format.pluralCategory("en", 1.0))
        assertEquals(Plural.One, Format.pluralCategory("ro", 1.0))
        assertEquals(Plural.Few, Format.pluralCategory("ro", 16.0))
        assertEquals(Plural.Other, Format.pluralCategory("ro", 32.0))
        assertEquals(Plural.Other, Format.pluralCategory("ro", Double.NaN))
        assertEquals(Plural.Other, Format.pluralCategory("en", Double.POSITIVE_INFINITY))
    }

    @Test fun aBeatCountIsReadAsItIsShown() {
        // The jump sizes: 1, 2, 4, 8, 16, 32.
        assertEquals(listOf(Plural.One, Plural.Few, Plural.Few, Plural.Few, Plural.Few, Plural.Other), listOf("1", "2", "4", "8", "16", "32").map { Format.beatsPlural("ro", it) })
        assertEquals(listOf(Plural.One, Plural.Other, Plural.Other), listOf("1", "2", "32").map { Format.beatsPlural("en", it) })
        // A fraction written with a slash reads as one in both languages ("1/2 beat", "1/2 bătaie"); a decimal one does not.
        for (label in listOf("1/2", "1/4", "1/32")) for (lang in listOf("en", "ro")) assertEquals(Plural.One, Format.beatsPlural(lang, label), "$lang $label")
        assertEquals(Plural.Few, Format.beatsPlural("ro", "0.5"))
        assertEquals(Plural.Other, Format.beatsPlural("en", "0.5"))
        assertEquals(Plural.Other, Format.beatsPlural("ro", "?"), "not a number")
    }

    @Test fun theTrackCountSentence() {
        val ro = linkedMapOf(
            0 to "0 piese", 1 to "1 piesă", 2 to "2 piese", 19 to "19 piese", 20 to "20 de piese", 21 to "21 de piese",
            100 to "100 de piese", 101 to "101 piese", 119 to "119 piese", 120 to "120 de piese",
        )
        for ((n, text) in ro) assertEquals(text, counted(DesktopStrings.ro, Counted.TrackCount, n), "ro $n")
        val en = linkedMapOf(0 to "0 tracks", 1 to "1 track", 2 to "2 tracks", 21 to "21 tracks", 101 to "101 tracks")
        for ((n, text) in en) assertEquals(text, counted(DesktopStrings.en, Counted.TrackCount, n), "en $n")
    }

    @Test fun theJumpSizeSentence() {
        val ro = linkedMapOf("1" to "Salt de 1 bătaie", "2" to "Salt de 2 bătăi", "4" to "Salt de 4 bătăi", "16" to "Salt de 16 bătăi", "32" to "Salt de 32 de bătăi")
        for ((label, text) in ro) assertEquals(text, countedBeats(DesktopStrings.ro, Counted.JumpSize, label), "ro $label")
        val en = linkedMapOf("1" to "Jump size 1 beat", "2" to "Jump size 2 beats", "32" to "Jump size 32 beats")
        for ((label, text) in en) assertEquals(text, countedBeats(DesktopStrings.en, Counted.JumpSize, label), "en $label")
    }

    @Test fun everyCountedSentenceHasItsThreeFormsInBothTables() {
        assertEquals("en", pluralLang(DesktopStrings.en))
        assertEquals("ro", pluralLang(DesktopStrings.ro))
        assertEquals("en", pluralLang(emptyMap()), "a table that does not name its rule gets the English one")
        for (c in Counted.entries) {
            assertEquals(listOf("_one", "_few", "_other"), listOf(c.one, c.few, c.other).map { it.key.substring(it.key.lastIndexOf('_')) }, "$c: key names")
            assertEquals(1, listOf(c.one, c.few, c.other).map { it.key.substringBeforeLast('_') }.distinct().size, "$c: one sentence")
            for ((lang, table) in listOf("en" to DesktopStrings.en, "ro" to DesktopStrings.ro)) for (form in Plural.entries) {
                val text = table[c.form(form).key] ?: error("$lang has no ${c.form(form).key}")
                assertTrue("%1" in text, "$lang ${c.form(form).key} has the count: $text")
            }
            // Romanian: the other form is the one with "de"; the one and few forms have none before the noun.
            assertTrue(Regex("%1 de \\p{L}").containsMatchIn(DesktopStrings.ro.getValue(c.other.key)), "ro ${c.other.key}")
            assertTrue(listOf(c.one, c.few).none { "%1 de " in DesktopStrings.ro.getValue(it.key) }, "ro $c one / few")
            // English: few reads like other (the rule never picks it, the key exists for parity).
            assertEquals(DesktopStrings.en.getValue(c.other.key), DesktopStrings.en.getValue(c.few.key), "en $c few")
        }
        // The single-form keys they replace are gone.
        assertTrue(Str.entries.none { it.key == "jump_size" || it.key == "track_count" })
    }
}
