package ro.mixai.tv.ui.home

import org.junit.Assert.assertEquals
import org.junit.Test

class OwnLibraryFirstTest {
    private fun order(vararg ids: String) = ownLibraryFirst(ids.toList()) { it }

    @Test
    fun ownRowsMoveAheadOfRecommendationsInD25Order() {
        assertEquals(
            listOf("continue", "watchlist", "new_in_library", "top_picks", "trending_on_your_providers", "upcoming"),
            order("continue", "top_picks", "trending_on_your_providers", "upcoming", "new_in_library", "watchlist"),
        )
    }

    @Test
    fun otherRowsKeepServerOrder() {
        assertEquals(listOf("new_in_library", "b", "a", "c"), order("b", "a", "new_in_library", "c"))
    }

    @Test
    fun alreadyOrderedHomeIsUnchanged() {
        val ids = arrayOf("continue", "new_in_library", "top_picks")
        assertEquals(ids.toList(), order(*ids))
    }

    @Test
    fun emptyIsEmpty() {
        assertEquals(emptyList<String>(), order())
    }
}
