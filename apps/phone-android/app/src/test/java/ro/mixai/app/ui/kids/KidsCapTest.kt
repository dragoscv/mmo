package ro.mixai.app.ui.kids

import org.junit.Assert.assertEquals
import org.junit.Test
import ro.mixai.app.data.DailyCapError
import ro.mixai.app.data.ProfileUsage

class KidsCapTest {
    private fun usage(
        watch: Long = 30,
        cap: Long? = 60,
        remaining: Long? = 30,
        over: Boolean = false,
        enforced: Boolean = true,
    ) = ProfileUsage(profileId = "kid", day = "2026-11-05", watchMin = watch, dailyCapMin = cap, remainingMin = remaining, overCap = over, enforced = enforced)

    @Test
    fun nullUsageHidden() {
        assertEquals(CapUi.Hidden, capUiState(null, isKid = true))
    }

    @Test
    fun adultHidden() {
        assertEquals(CapUi.Hidden, capUiState(usage(), isKid = false))
    }

    @Test
    fun notEnforcedHidden() {
        assertEquals(CapUi.Hidden, capUiState(usage(enforced = false), isKid = true))
    }

    @Test
    fun noCapHidden() {
        assertEquals(CapUi.Hidden, capUiState(usage(cap = null, remaining = null), isKid = true))
    }

    @Test
    fun remaining30NotLow() {
        assertEquals(CapUi.Remaining(30, 60, low = false), capUiState(usage(watch = 30, remaining = 30), isKid = true))
    }

    @Test
    fun remaining10IsLow() {
        assertEquals(CapUi.Remaining(10, 60, low = true), capUiState(usage(watch = 50, remaining = 10), isKid = true))
    }

    @Test
    fun remaining11NotLow() {
        assertEquals(CapUi.Remaining(11, 60, low = false), capUiState(usage(watch = 49, remaining = 11), isKid = true))
    }

    @Test
    fun remainingNullComputedFromCapMinusWatch() {
        assertEquals(CapUi.Remaining(15, 60, low = false), capUiState(usage(watch = 45, remaining = null), isKid = true))
    }

    @Test
    fun overCapLocked() {
        assertEquals(CapUi.Locked(60, 70), capUiState(usage(watch = 70, remaining = 0, over = true), isKid = true))
    }

    @Test
    fun overCapLockedEvenWithStaleRemaining() {
        assertEquals(CapUi.Locked(60, 40), capUiState(usage(watch = 40, remaining = 20, over = true), isKid = true))
    }

    @Test
    fun remainingZeroLocked() {
        assertEquals(CapUi.Locked(60, 60), capUiState(usage(watch = 60, remaining = 0), isKid = true))
    }

    @Test
    fun computedNegativeRemainingLocked() {
        assertEquals(CapUi.Locked(60, 75), capUiState(usage(watch = 75, remaining = null), isKid = true))
    }

    @Test
    fun fromDailyCapError() {
        val e = DailyCapError(error = "daily_cap", profileId = "kid", dailyCapMin = 90, watchMin = 95)
        assertEquals(CapUi.Locked(90, 95), capUiFromError(e))
        assertEquals(CapUi.Locked(null, 0), capUiFromError(DailyCapError(error = "daily_cap")))
    }
}
