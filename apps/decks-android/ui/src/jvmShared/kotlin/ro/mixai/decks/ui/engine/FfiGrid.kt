package ro.mixai.decks.ui.engine

import ro.mixai.decks.ffi.DecksEngine
import ro.mixai.decks.ffi.DecksLibrary
import ro.mixai.decks.ffi.DriftSource
import ro.mixai.decks.ffi.GridState
import ro.mixai.decks.ffi.deckGrid
import ro.mixai.decks.ffi.driftCheck
import ro.mixai.decks.ffi.gridAddMarker
import ro.mixai.decks.ffi.gridApplyToDeck
import ro.mixai.decks.ffi.gridMoveMarker
import ro.mixai.decks.ffi.gridRemoveMarker
import ro.mixai.decks.ffi.gridSetBase
import ro.mixai.decks.ffi.gridSetFixed
import ro.mixai.decks.ffi.trackGrid
import ro.mixai.decks.ffi.trackGridMarkers

/**
 * [GridPort] over decks-ffi (WP19-37). Every call is wrapped: a missing grid, a locked library
 * or a stopped engine comes back as `null` / `false`, never as a crash.
 */
class FfiGrid(
    private val engine: DecksEngine,
    private val library: DecksLibrary,
) : GridPort {
    override fun grid(trackId: String): GridStateUi? =
        runCatching { trackGrid(library, trackId).ui() }.getOrNull()

    override fun markers(trackId: String): List<GridMarkerUi> =
        runCatching { trackGridMarkers(library, trackId).map { it.ui() } }.getOrDefault(emptyList())

    override fun setFixed(trackId: String, fixed: Boolean): GridStateUi? =
        runCatching { gridSetFixed(library, trackId, fixed).ui() }.getOrNull()

    override fun setBase(trackId: String, bpm: Double, firstBeatSec: Double, downbeatOffset: Int): GridStateUi? =
        runCatching {
            gridSetBase(library, trackId, bpm, firstBeatSec, downbeatOffset.coerceIn(0, 3).toUByte()).ui()
        }.getOrNull()

    override fun addMarker(trackId: String, sec: Double, bpm: Double): GridStateUi? =
        runCatching { gridAddMarker(library, trackId, sec, bpm).ui() }.getOrNull()

    override fun moveMarker(trackId: String, atSec: Double, newSec: Double, newBpm: Double?, toleranceSec: Double): GridStateUi? =
        runCatching { gridMoveMarker(library, trackId, atSec, newSec, newBpm, toleranceSec).ui() }.getOrNull()

    override fun removeMarker(trackId: String, atSec: Double, toleranceSec: Double): GridStateUi? =
        runCatching { gridRemoveMarker(library, trackId, atSec, toleranceSec).ui() }.getOrNull()

    override fun applyToDeck(deck: Int, grid: GridStateUi): Boolean =
        runCatching { gridApplyToDeck(engine, deck.toUByte(), grid.ffi()); true }.getOrDefault(false)

    override fun deckGrid(deck: Int): GridStateUi? =
        runCatching { deckGrid(engine, deck.toUByte()).ui() }.getOrNull()

    override fun driftCheck(path: String, source: String): Double =
        runCatching { driftCheck(path, source.driftSource()).shiftSec }.getOrDefault(0.0)
}

private fun String.driftSource(): DriftSource = when (lowercase()) {
    "rekordbox" -> DriftSource.REKORDBOX
    "serato" -> DriftSource.SERATO
    "traktor" -> DriftSource.TRAKTOR
    "engine", "enginedj", "engine dj" -> DriftSource.ENGINE_DJ
    "mixai" -> DriftSource.MIX_AI
    else -> DriftSource.UNKNOWN
}

private fun ro.mixai.decks.ffi.GridMarker.ui() = GridMarkerUi(sec, bpm, beat.toInt())

private fun GridState.ui() = GridStateUi(
    trackId = trackId,
    bpm = bpm,
    firstBeatSec = firstBeatSec,
    downbeatOffset = downbeatOffset.toInt(),
    fixed = fixed,
    markers = markers.map { it.ui() },
)

private fun GridStateUi.ffi() = GridState(
    trackId = trackId,
    bpm = bpm,
    firstBeatSec = firstBeatSec,
    downbeatOffset = downbeatOffset.coerceIn(0, 3).toUByte(),
    fixed = fixed,
    markers = markers.map { ro.mixai.decks.ffi.GridMarker(it.sec, it.bpm, it.beat.coerceAtLeast(0).toUInt()) },
)
