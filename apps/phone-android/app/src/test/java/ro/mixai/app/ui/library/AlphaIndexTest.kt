package ro.mixai.app.ui.library

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class AlphaIndexTest {
    @Test
    fun firstIndexPerLetterWithDiacriticsFolded() {
        val idx = alphaIndex(listOf("Avatar", "Ăla", "Batman", "Ștrumfii", "Star Wars", "2001"))
        assertEquals(0, idx['A'])
        assertEquals(2, idx['B'])
        assertEquals(3, idx['S'])
        assertEquals(5, idx['#'])
        assertFalse(idx.containsKey('C'))
    }
}
