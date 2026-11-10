package ro.mixai.decks.ui.engine

/** Source application chosen in the import screen; [AUTO] detects it from the picked path. */
enum class ImportSource { AUTO, REKORDBOX, SERATO, TRAKTOR }

/** What happens when an imported track is already in the library (FFI `ImportConflict`). */
enum class ImportConflictUi { KEEP_EXISTING, PREFER_IMPORTED, MERGE }

data class ImportOptionsUi(
    val conflict: ImportConflictUi = ImportConflictUi.PREFER_IMPORTED,
    val relocateRoots: List<String> = emptyList(),
    val correctDrift: Boolean = true,
)

/** A resolved import target: [label] names the format ("rekordbox XML"), [path] is what the engine reads. */
data class ImportTarget(val source: ImportSource, val label: String, val path: String)

/** Read-only counts shown before importing (FFI `ImportPreviewRecord`). */
data class ImportPreviewUi(
    val source: String,
    val tracksSeen: Int,
    val newTracks: Int,
    val matchedByPath: Int,
    val matchedByHash: Int,
    val missingFiles: Int,
    val relocatable: Int,
    val cues: Int,
    val grids: Int,
    val playlists: Int,
    val playlistEntries: Int,
    val missingSample: List<String>,
    val protected: Boolean,
    val warnings: List<String>,
)

/** Import result (FFI `ImportRunReport`). */
data class ImportReportUi(
    val source: String,
    val tracksSeen: Int,
    val inserted: Int,
    val mergedByPath: Int,
    val mergedByHash: Int,
    val cues: Int,
    val grids: Int,
    val playlists: Int,
    val playlistEntries: Int,
    val unmatched: List<String>,
    val relocated: Int,
    val driftFixes: Int,
    val warnings: List<String>,
)

/** Why an import call failed. [PROTECTED] = the library lock is on (WP19-40). */
enum class ImportFailure { UNSUPPORTED, PROTECTED, NOT_RECOGNISED, FAILED }

/** Either a value or a failure with the engine's reason. */
sealed interface ImportResult<out T> {
    data class Ok<T>(val value: T) : ImportResult<T>
    data class Err(val failure: ImportFailure, val reason: String) : ImportResult<Nothing>
}

/**
 * Import from rekordbox / Serato / Traktor (WP19-38). Calls read files and can take seconds on a
 * big collection: callers run them off the UI thread.
 */
interface ImportPort {
    /** Resolves [path] for [source]; [ImportSource.AUTO] detects the format (null = not a DJ library). */
    fun resolve(source: ImportSource, path: String): ImportTarget?
    fun preview(target: ImportTarget, options: ImportOptionsUi): ImportResult<ImportPreviewUi>
    fun run(target: ImportTarget, options: ImportOptionsUi): ImportResult<ImportReportUi>
}

/** Stand-in for the demo engine: nothing can be imported without the native library. */
object DemoImport : ImportPort {
    private val none = ImportResult.Err(ImportFailure.UNSUPPORTED, "demo engine")
    override fun resolve(source: ImportSource, path: String): ImportTarget? = null
    override fun preview(target: ImportTarget, options: ImportOptionsUi): ImportResult<ImportPreviewUi> = none
    override fun run(target: ImportTarget, options: ImportOptionsUi): ImportResult<ImportReportUi> = none
}
