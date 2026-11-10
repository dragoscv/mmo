package ro.mixai.decks.ui.engine

/** One library snapshot (FFI `LibrarySnapshot`). [reason]: `auto`, `manual`, `before-import`, `before-schema-v3`, `pre-restore` … */
data class SnapshotUi(
	val id: String,
	val createdAtMs: Long,
	val reason: String,
	val tracks: Long,
	val crates: Long,
	val cues: Long,
	val sizeBytes: Long,
	val schemaVersion: Int,
)

/** Result of a safety call: success value or a short error text for the panel. */
sealed interface SafetyResult<out T> {
	data class Ok<T>(val value: T) : SafetyResult<T>
	data class Failed(val reason: String) : SafetyResult<Nothing>
}

/**
 * Library snapshots, protect lock and one-click rollback (WP19-40) over `decks-ffi`.
 * Snapshots live next to the library file (`<db dir>/snapshots`); `DecksLibrary.open` takes the
 * daily automatic one. Calls are blocking but short (a snapshot is a `VACUUM INTO`); the panel
 * runs them off the UI thread. Policy: docs/decks/library-safety.md.
 */
interface SafetyPort {
	/** False for an in-memory library: snapshots and restore are unavailable, the lock still works. */
	val canSnapshot: Boolean

	fun isProtected(): Boolean
	fun setProtected(on: Boolean): SafetyResult<Unit>
	/** Newest first. */
	fun snapshots(): List<SnapshotUi>
	fun snapshotNow(reason: String = "manual"): SafetyResult<SnapshotUi>
	/** Replaces the library (verified first; the current state becomes a `pre-restore` snapshot). */
	fun restore(id: String): SafetyResult<SnapshotUi?>
	/** Keeps the newest [keepLast] plus one per day for [keepDailyDays]; returns how many were removed. */
	fun prune(keepLast: Int = 10, keepDailyDays: Int = 30): SafetyResult<Int>
}

/** Pure-Kotlin stand-in (demo engine, previews, tests): same rules as the Rust side. */
class DemoSafety(
	private val clock: () -> Long = { 0L },
	private val counts: () -> Triple<Long, Long, Long> = { Triple(0L, 0L, 0L) },
	override val canSnapshot: Boolean = true,
) : SafetyPort {
	private var protectedOn = false
	private val list = mutableListOf<SnapshotUi>()
	private var seq = 0

	override fun isProtected() = protectedOn

	override fun setProtected(on: Boolean): SafetyResult<Unit> {
		protectedOn = on
		return SafetyResult.Ok(Unit)
	}

	override fun snapshots(): List<SnapshotUi> = list.sortedByDescending { it.createdAtMs }

	override fun snapshotNow(reason: String): SafetyResult<SnapshotUi> {
		if (!canSnapshot) return SafetyResult.Failed("in-memory library")
		val (t, c, q) = counts()
		val s = SnapshotUi("demo-${++seq}-$reason", clock(), reason, t, c, q, 4096L * (t + 1), 3)
		list += s
		return SafetyResult.Ok(s)
	}

	override fun restore(id: String): SafetyResult<SnapshotUi?> {
		if (!canSnapshot) return SafetyResult.Failed("in-memory library")
		if (list.none { it.id == id }) return SafetyResult.Failed("not found: snapshot $id")
		return when (val pre = snapshotNow("pre-restore")) {
			is SafetyResult.Ok -> SafetyResult.Ok(pre.value)
			is SafetyResult.Failed -> pre
		}
	}

	override fun prune(keepLast: Int, keepDailyDays: Int): SafetyResult<Int> {
		val keep = SafetyLogic.retained(snapshots(), keepLast, keepDailyDays, clock()).map { it.id }.toSet()
		val before = list.size
		list.removeAll { it.id !in keep }
		return SafetyResult.Ok(before - list.size)
	}
}

/** Pure helpers shared by the panel and the demo (unit-tested). */
object SafetyLogic {
	private const val DAY_MS = 86_400_000L

	/** Retention rule identical to `decks_library::safety::prune_at`. [newestFirst] must be sorted. */
	fun retained(newestFirst: List<SnapshotUi>, keepLast: Int, keepDailyDays: Int, nowMs: Long): List<SnapshotUi> {
		val today = nowMs.floorDiv(DAY_MS)
		val days = mutableSetOf<Long>()
		return newestFirst.filterIndexed { i, s ->
			val day = s.createdAtMs.floorDiv(DAY_MS)
			val daily = today - day < keepDailyDays && days.add(day)
			i < keepLast || daily
		}
	}

	/** Reason → reason class for the label (`auto`, `manual`, `import`, `schema`, `pre_restore`, or the raw text). */
	fun reasonKind(reason: String): String = when {
		reason == "auto" -> "auto"
		reason == "manual" -> "manual"
		reason == "pre-restore" -> "pre_restore"
		reason.startsWith("before-schema") -> "schema"
		reason.startsWith("before-import") || reason.startsWith("before-migrate") -> "import"
		else -> reason
	}

	/** `2026-11-10 08:15` in UTC (no locale-dependent formatting in commonMain). */
	fun dateUtc(ms: Long): String {
		val secs = ms.floorDiv(1000L)
		val z = secs.floorDiv(86_400L) + 719_468
		val era = z.floorDiv(146_097L)
		val doe = z - era * 146_097
		val yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365
		val doy = doe - (365 * yoe + yoe / 4 - yoe / 100)
		val mp = (5 * doy + 2) / 153
		val d = doy - (153 * mp + 2) / 5 + 1
		val m = if (mp < 10) mp + 3 else mp - 9
		val y = yoe + era * 400 + (if (m <= 2) 1 else 0)
		val tod = secs.mod(86_400L)
		fun two(v: Long) = v.toString().padStart(2, '0')
		return "$y-${two(m)}-${two(d)} ${two(tod / 3600)}:${two((tod / 60) % 60)}"
	}
}
