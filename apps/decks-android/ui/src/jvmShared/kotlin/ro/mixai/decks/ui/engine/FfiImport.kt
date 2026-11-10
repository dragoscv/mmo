package ro.mixai.decks.ui.engine

import java.io.File
import ro.mixai.decks.ffi.DecksException
import ro.mixai.decks.ffi.DecksLibrary
import ro.mixai.decks.ffi.ImportConflict
import ro.mixai.decks.ffi.ImportOptions
import ro.mixai.decks.ffi.LibraryFormat
import ro.mixai.decks.ffi.detectImportFormat
import ro.mixai.decks.ffi.importPreview
import ro.mixai.decks.ffi.importRun

/** [ImportPort] over decks-ffi `detect_import_format` / `import_preview` / `import_run` (WP19-38). */
class FfiImport(private val library: DecksLibrary) : ImportPort {

    override fun resolve(source: ImportSource, path: String): ImportTarget? {
        val detected = runCatching { detectImportFormat(path) }.getOrNull()
        val format: LibraryFormat
        val target: String
        when (source) {
            ImportSource.AUTO -> {
                detected ?: return null
                format = detected.format
                target = detected.path
            }
            ImportSource.REKORDBOX -> {
                // A USB stick / export.pdb is rekordbox too; anything else is read as XML.
                if (detected != null && detected.format is LibraryFormat.RekordboxPdb) {
                    format = detected.format
                    target = detected.path
                } else {
                    format = LibraryFormat.RekordboxXml
                    target = path
                }
            }
            ImportSource.TRAKTOR -> {
                format = LibraryFormat.TraktorNml
                target = path
            }
            ImportSource.SERATO -> {
                if (detected != null && detected.format is LibraryFormat.SeratoCrates) {
                    format = detected.format
                    target = detected.path
                } else {
                    val dir = File(path)
                    format = LibraryFormat.SeratoCrates(volumeRoot(dir))
                    target = path
                }
            }
        }
        return ImportTarget(sourceOf(format), labelOf(format), target).also { formats[it] = format }
    }

    override fun preview(target: ImportTarget, options: ImportOptionsUi): ImportResult<ImportPreviewUi> = call {
        val p = importPreview(library, formatOf(target), target.path, options.ffi())
        ImportPreviewUi(
            source = p.source,
            tracksSeen = p.tracksSeen.toInt(),
            newTracks = p.newTracks.toInt(),
            matchedByPath = p.matchedByPath.toInt(),
            matchedByHash = p.matchedByHash.toInt(),
            missingFiles = p.missingFiles.toInt(),
            relocatable = p.relocatable.toInt(),
            cues = p.cues.toInt(),
            grids = p.grids.toInt(),
            playlists = p.playlists.toInt(),
            playlistEntries = p.playlistEntries.toInt(),
            missingSample = p.missingSample,
            protected = p.protected,
            warnings = p.warnings,
        )
    }

    override fun run(target: ImportTarget, options: ImportOptionsUi): ImportResult<ImportReportUi> = call {
        val r = importRun(library, formatOf(target), target.path, options.ffi())
        val s = r.summary
        ImportReportUi(
            source = s.source,
            tracksSeen = s.tracksSeen.toInt(),
            inserted = s.tracksInserted.toInt(),
            mergedByPath = s.tracksMergedByPath.toInt(),
            mergedByHash = s.tracksMergedByHash.toInt(),
            cues = s.cuesImported.toInt(),
            grids = s.gridsImported.toInt(),
            playlists = s.playlistsImported.toInt(),
            playlistEntries = s.playlistEntries.toInt(),
            unmatched = s.unmatchedFiles,
            relocated = r.relocated.toInt(),
            driftFixes = r.driftFixes.toInt(),
            warnings = s.warnings,
        )
    }

    /** Formats resolved by [resolve], so preview/run use the exact one (Serato volume root, PDB root). */
    private val formats = java.util.concurrent.ConcurrentHashMap<ImportTarget, LibraryFormat>()

    private fun formatOf(t: ImportTarget): LibraryFormat = formats[t] ?: when (t.source) {
        ImportSource.TRAKTOR -> LibraryFormat.TraktorNml
        ImportSource.SERATO -> LibraryFormat.SeratoCrates(volumeRoot(File(t.path)))
        else -> LibraryFormat.RekordboxXml
    }

    private fun ImportOptionsUi.ffi() = ImportOptions(
        conflict = when (conflict) {
            ImportConflictUi.KEEP_EXISTING -> ImportConflict.KEEP_EXISTING
            ImportConflictUi.PREFER_IMPORTED -> ImportConflict.PREFER_IMPORTED
            ImportConflictUi.MERGE -> ImportConflict.MERGE
        },
        relocateRoots = relocateRoots,
        correctDrift = correctDrift,
    )

    private inline fun <T> call(block: () -> T): ImportResult<T> = try {
        ImportResult.Ok(block())
    } catch (e: DecksException.Protected) {
        ImportResult.Err(ImportFailure.PROTECTED, e.reason)
    } catch (e: DecksException.Unsupported) {
        ImportResult.Err(ImportFailure.UNSUPPORTED, e.reason)
    } catch (t: Throwable) {
        System.err.println("[decks] import failed: $t")
        ImportResult.Err(ImportFailure.FAILED, t.message ?: t.toString())
    }

    private companion object {
        /** The drive / mount a `_Serato_` folder's relative paths hang off. */
        fun volumeRoot(dir: File): String {
            val abs = dir.absoluteFile
            val parts = abs.path.replace('\\', '/').split('/')
            if (parts.size > 2 && parts[1] == "Volumes") return "/Volumes/${parts[2]}"
            var root = abs
            while (root.parentFile != null) root = root.parentFile
            return root.path
        }

        fun sourceOf(f: LibraryFormat) = when (f) {
            is LibraryFormat.TraktorNml -> ImportSource.TRAKTOR
            is LibraryFormat.SeratoCrates -> ImportSource.SERATO
            else -> ImportSource.REKORDBOX
        }

        fun labelOf(f: LibraryFormat) = when (f) {
            is LibraryFormat.RekordboxXml -> "rekordbox XML"
            is LibraryFormat.RekordboxPdb -> "rekordbox USB (export.pdb)"
            is LibraryFormat.TraktorNml -> "Traktor NML"
            is LibraryFormat.SeratoCrates -> "Serato"
            is LibraryFormat.EngineDj -> "Engine DJ"
            is LibraryFormat.NeutralJson -> "MixAI JSON"
            is LibraryFormat.OneLibrary -> "OneLibrary"
        }
    }
}
