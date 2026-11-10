package ro.mixai.decks.ui

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue
import ro.mixai.decks.ui.engine.DemoBackend
import ro.mixai.decks.ui.engine.DemoSafety
import ro.mixai.decks.ui.engine.SafetyLogic
import ro.mixai.decks.ui.engine.SafetyPort
import ro.mixai.decks.ui.engine.SafetyResult
import ro.mixai.decks.ui.engine.SnapshotUi
import ro.mixai.decks.ui.screens.SafetyNotice
import ro.mixai.decks.ui.screens.SafetyState
import ro.mixai.decks.ui.screens.decksStatusText
import ro.mixai.decks.ui.theme.DecksColors
import ro.mixai.decks.ui.theme.DecksSkin
import ro.mixai.decks.ui.theme.Oklab
import androidx.compose.ui.graphics.Color

private const val DAY = 86_400_000L

private fun snap(id: String, at: Long, reason: String = "auto") = SnapshotUi(id, at, reason, 1, 0, 0, 1, 3)

/** Port whose restore fails (bad snapshot) — the panel must report it and keep the list. */
private class FailingRestore(private val inner: DemoSafety) : SafetyPort by inner {
    override fun restore(id: String): SafetyResult<SnapshotUi?> = SafetyResult.Failed("snapshot $id is damaged (sha256 mismatch)")
}

/** Port that throws like uniffi's `InternalException` (a plain `Exception`, not a `DecksException`). */
private class ThrowingSafety(private val inner: DemoSafety) : SafetyPort by inner {
    override fun snapshotNow(reason: String): SafetyResult<SnapshotUi> = throw Exception("rust panic")
}

class SafetyTest {
    /**
     * P1-20: warning / success / danger used as TEXT on the Import and Safety panels must reach
     * WCAG AA 4.5:1 on every skin, light ones included (raw amber on a light panel is ~2:1).
     */
    @Test fun statusTextMeetsAaOnEveryPreset() {
        try {
            var lightSkins = 0
            for (skin in DecksSkin.presets + DecksSkin.presets.map { it.copy(dark = !it.dark) }) {
                DecksColors.apply(skin)
                if (!skin.dark) lightSkins++
                val bg = DecksColors.background
                val s = DecksColors.surface
                val panel = Color(
                    s.red * s.alpha + bg.red * (1 - s.alpha),
                    s.green * s.alpha + bg.green * (1 - s.alpha),
                    s.blue * s.alpha + bg.blue * (1 - s.alpha),
                    1f,
                )
                for ((name, role) in listOf("warning" to DecksColors.warning, "success" to DecksColors.success, "danger" to DecksColors.danger)) {
                    val c = Oklab.contrast(decksStatusText(role), panel)
                    assertTrue(c >= 4.5, "${skin.id} dark=${skin.dark} $name text: $c")
                }
            }
            assertTrue(lightSkins > 0, "the light skins were actually checked")
            // Non-vacuous: on at least one light skin the raw amber fails and the fallback kicks in.
            DecksColors.apply(DecksSkin.default.copy(dark = false))
            assertEquals(DecksColors.foreground, decksStatusText(DecksColors.warning), "amber falls back on light")
        } finally {
            DecksColors.apply(DecksSkin.default)
        }
    }

    @Test fun busyGuardIsClaimOnceAndAlwaysReleasable() {
        val s = SafetyState(DemoSafety())
        assertFalse(s.busy)
        assertTrue(s.begin(), "first claim wins")
        assertTrue(s.busy)
        assertFalse(s.begin(), "a second tap while busy is dropped")
        s.finish()
        assertFalse(s.busy)
        assertTrue(s.begin(), "claimable again after finish")
        s.finish()
    }

    /**
     * P1-16: an action that throws must still release the panel — the composable runs it in a
     * try/finally, so one error cannot leave the UI disabled forever.
     */
    @Test fun aThrowingActionStillReleasesTheBusyFlag() {
        val s = SafetyState(ThrowingSafety(DemoSafety()))
        assertTrue(s.begin())
        val thrown = try {
            s.snapshotNow()
            false
        } catch (_: Exception) {
            true
        } finally {
            s.finish()
        }
        assertTrue(thrown, "the port threw, as uniffi's InternalException would")
        assertFalse(s.busy, "the panel is usable again")
        assertTrue(s.begin(), "and claimable")
        s.finish()
    }

    @Test fun demoBackendHasNoSafetyPort() {
        assertNull(DemoBackend { 0.0 }.librarySafety())
        val s = SafetyState(null)
        s.refresh()
        assertFalse(s.available)
        assertFalse(s.canSnapshot)
        assertFalse(s.confirmRestore())
    }

    @Test fun protectToggleRoundTrips() {
        val port = DemoSafety()
        val s = SafetyState(port)
        s.refresh()
        assertFalse(s.protected)
        s.toggleProtected()
        assertTrue(s.protected)
        assertTrue(port.isProtected())
        s.toggleProtected()
        assertFalse(port.isProtected())
    }

    @Test fun snapshotNowListsNewestFirst() {
        var now = 1_000L
        val port = DemoSafety(clock = { now }, counts = { Triple(12L, 3L, 40L) })
        val s = SafetyState(port)
        s.snapshotNow()
        now = 2_000L
        s.snapshotNow()
        assertEquals(2, s.snapshots.size)
        assertEquals(2_000L, s.snapshots.first().createdAtMs)
        assertEquals(12L, s.snapshots.first().tracks)
        assertEquals("manual", s.snapshots.first().reason)
    }

    @Test fun restoreNeedsConfirmAndAddsPreRestore() {
        var now = 1_000L
        val port = DemoSafety(clock = { now })
        val s = SafetyState(port)
        s.snapshotNow()
        val target = s.snapshots.single()
        s.askRestore(target)
        assertEquals(target, s.confirming)
        s.cancelRestore()
        assertNull(s.confirming)
        assertEquals(1, s.snapshots.size, "cancel does nothing")

        now = 5_000L
        s.askRestore(target)
        assertTrue(s.confirmRestore())
        assertNull(s.confirming)
        assertEquals(SafetyNotice.Restored, s.notice)
        assertEquals("pre-restore", s.snapshots.first().reason)
        assertFalse(s.confirmRestore(), "nothing pending any more")
    }

    @Test fun failedRestoreIsReported() {
        val inner = DemoSafety()
        val s = SafetyState(FailingRestore(inner))
        s.snapshotNow()
        s.askRestore(s.snapshots.single())
        assertFalse(s.confirmRestore())
        val n = assertIs<SafetyNotice.Failed>(s.notice)
        assertTrue(n.reason.contains("sha256"))
        assertEquals(1, s.snapshots.size)
    }

    @Test fun inMemoryLibraryCannotSnapshot() {
        val port = DemoSafety(canSnapshot = false)
        val s = SafetyState(port)
        assertTrue(s.available)
        assertFalse(s.canSnapshot)
        s.snapshotNow()
        assertIs<SafetyNotice.Failed>(s.notice)
        assertTrue(s.snapshots.isEmpty())
    }

    @Test fun retentionMatchesTheRustRule() {
        // Mid-day: `now - 1 s` must stay on the same UTC day as `now`.
        val now = 100 * DAY + DAY / 2
        val list = buildList {
            for (d in 0 until 6) {
                add(snap("d$d-a", now - d * DAY - 1_000))
                add(snap("d$d-b", now - d * DAY - 2_000))
            }
            add(snap("old", now - 40 * DAY))
        }.sortedByDescending { it.createdAtMs }
        val kept = SafetyLogic.retained(list, keepLast = 3, keepDailyDays = 4, nowMs = now).map { it.id }
        assertEquals(listOf("d0-a", "d0-b", "d1-a", "d2-a", "d3-a"), kept)
        val port = DemoSafety(clock = { now })
        repeat(5) { port.snapshotNow() }
        assertEquals(SafetyResult.Ok(4), port.prune(keepLast = 1, keepDailyDays = 0))
        assertEquals(1, port.snapshots().size)
    }

    @Test fun reasonKindsAndUtcDates() {
        assertEquals("auto", SafetyLogic.reasonKind("auto"))
        assertEquals("import", SafetyLogic.reasonKind("before-import"))
        assertEquals("import", SafetyLogic.reasonKind("before-migrate"))
        assertEquals("schema", SafetyLogic.reasonKind("before-schema-v3"))
        assertEquals("pre_restore", SafetyLogic.reasonKind("pre-restore"))
        assertEquals("custom", SafetyLogic.reasonKind("custom"))
        assertEquals("1970-01-01 00:00", SafetyLogic.dateUtc(0))
        assertEquals("2025-11-10 08:15", SafetyLogic.dateUtc(1_762_762_500_123))
        assertEquals("2024-02-29 23:59", SafetyLogic.dateUtc(1_709_251_140_000))
    }
}
