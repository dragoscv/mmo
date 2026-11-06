package ro.mixai.music.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class KaraokeTest {
    @Test fun lineWithoutTagsIsOneWordAtLineStart() {
        val words = Karaoke.parse("Hello world", 5_000, 9_000)
        assertEquals(listOf(KaraokeWord("Hello world", 5_000)), words)
        assertFalse(Karaoke.hasWordTiming("Hello world"))
    }

    @Test fun twoDigitFractionsAreCentiseconds() {
        val words = Karaoke.parse("<00:12.34>Hello <00:12.80>world", 12_000, 20_000)
        assertEquals(listOf(KaraokeWord("Hello ", 12_340), KaraokeWord("world", 12_800)), words)
    }

    @Test fun threeDigitFractionsAreMilliseconds() {
        val words = Karaoke.parse("<01:02.345>a <01:02.900>b", 60_000, null)
        assertEquals(listOf(KaraokeWord("a ", 62_345), KaraokeWord("b", 62_900)), words)
    }

    @Test fun tagWithoutFractionIsWholeSeconds() {
        assertEquals(listOf(KaraokeWord("x", 3_000)), Karaoke.parse("<00:03>x", 0, null))
    }

    @Test fun leadingUntaggedTextStartsAtLineStart() {
        val words = Karaoke.parse("Oh <00:10.50>yeah", 10_000, 15_000)
        assertEquals(listOf(KaraokeWord("Oh ", 10_000), KaraokeWord("yeah", 10_500)), words)
    }

    @Test fun concatenationEqualsPlainText() {
        val line = "Oh <00:10.50>yeah <00:11.00>baby <00:11.50>"
        val words = Karaoke.parse(line, 10_000, 15_000)
        assertEquals(Karaoke.plainText(line), words.joinToString("") { it.text })
        assertEquals("Oh yeah baby ", Karaoke.plainText(line))
    }

    @Test fun plainTextStripsTags() {
        assertEquals("Hello world", Karaoke.plainText("<00:12.34>Hello <00:12.80>world"))
        assertTrue(Karaoke.hasWordTiming("<00:12.34>Hello"))
    }

    @Test fun malformedTagIsKeptAsText() {
        val line = "<ab:cd>Hi <00:01.00>there"
        assertEquals("<ab:cd>Hi there", Karaoke.plainText(line))
        assertEquals(
            listOf(KaraokeWord("<ab:cd>Hi ", 0), KaraokeWord("there", 1_000)),
            Karaoke.parse(line, 0, null),
        )
        assertFalse(Karaoke.hasWordTiming("<1:2.3x>nope"))
    }

    @Test fun tagTimesAreClampedToLineBounds() {
        val words = Karaoke.parse("<00:01.00>early <00:30.00>late", 5_000, 10_000)
        assertEquals(listOf(5_000L, 10_000L), words.map { it.startMs })
    }

    @Test fun activeWordIndexBeforeInsideAfter() {
        val words = Karaoke.parse("<00:12.34>Hello <00:12.80>world", 12_000, 20_000)
        assertEquals(-1, Karaoke.activeWordIndex(words, 12_000))
        assertEquals(0, Karaoke.activeWordIndex(words, 12_340))
        assertEquals(0, Karaoke.activeWordIndex(words, 12_799))
        assertEquals(1, Karaoke.activeWordIndex(words, 12_800))
        assertEquals(1, Karaoke.activeWordIndex(words, 99_000))
        assertEquals(-1, Karaoke.activeWordIndex(emptyList(), 1_000))
    }
}
