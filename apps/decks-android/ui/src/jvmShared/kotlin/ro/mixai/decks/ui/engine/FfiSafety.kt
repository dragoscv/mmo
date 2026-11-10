package ro.mixai.decks.ui.engine

import ro.mixai.decks.ffi.DecksException
import ro.mixai.decks.ffi.DecksLibrary
import ro.mixai.decks.ffi.LibrarySnapshot

/** [SafetyPort] over decks-ffi `DecksLibrary` (WP19-40): snapshots, protect lock, restore. */
class FfiSafety(private val library: DecksLibrary) : SafetyPort {
	private fun LibrarySnapshot.ui() = SnapshotUi(
		id = id,
		createdAtMs = createdAtMs,
		reason = reason,
		tracks = tracks.toLong(),
		crates = crates.toLong(),
		cues = cues.toLong(),
		sizeBytes = sizeBytes.toLong(),
		schemaVersion = schemaVersion.toInt(),
	)

	/**
	 * Every failure becomes a [SafetyResult.Failed]. `Throwable`, not `RuntimeException`: uniffi
	 * raises its own `InternalException` (a plain `Exception`) for a Rust panic or a bad handle,
	 * and JNA raises `UnsatisfiedLinkError` when the library disappears — neither may crash the app.
	 */
	private inline fun <T> call(block: () -> T): SafetyResult<T> = try {
		SafetyResult.Ok(block())
	} catch (e: DecksException) {
		SafetyResult.Failed(e.reason())
	} catch (t: Throwable) {
		SafetyResult.Failed(t.message ?: t.toString())
	}

	private fun DecksException.reason(): String = when (this) {
		is DecksException.Protected -> reason
		is DecksException.Library -> reason
		is DecksException.NotFound -> reason
		is DecksException.Unsupported -> reason
		is DecksException.InvalidArgument -> reason
		else -> toString()
	}

	override val canSnapshot: Boolean by lazy { runCatching { library.canSnapshot() }.getOrDefault(false) }

	override fun isProtected(): Boolean = runCatching { library.isProtected() }.getOrDefault(false)

	override fun setProtected(on: Boolean): SafetyResult<Unit> = call { library.setProtected(on) }

	override fun snapshots(): List<SnapshotUi> =
		runCatching { library.listSnapshots().map { it.ui() } }.getOrDefault(emptyList())

	override fun snapshotNow(reason: String): SafetyResult<SnapshotUi> = call { library.snapshotNow(reason).ui() }

	override fun restore(id: String): SafetyResult<SnapshotUi?> = call { library.restoreSnapshot(id).preRestore?.ui() }

	override fun prune(keepLast: Int, keepDailyDays: Int): SafetyResult<Int> =
		call { library.pruneSnapshots(keepLast.toUInt(), keepDailyDays.toUInt()).size }
}
