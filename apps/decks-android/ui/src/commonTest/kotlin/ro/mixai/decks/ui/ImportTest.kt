package ro.mixai.decks.ui

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import ro.mixai.decks.ui.engine.DemoBackend
import ro.mixai.decks.ui.engine.DemoImport
import ro.mixai.decks.ui.engine.ImportConflictUi
import ro.mixai.decks.ui.engine.ImportFailure
import ro.mixai.decks.ui.engine.ImportOptionsUi
import ro.mixai.decks.ui.engine.ImportPort
import ro.mixai.decks.ui.engine.ImportPreviewUi
import ro.mixai.decks.ui.engine.ImportReportUi
import ro.mixai.decks.ui.engine.ImportResult
import ro.mixai.decks.ui.engine.ImportSource
import ro.mixai.decks.ui.engine.ImportTarget
import ro.mixai.decks.ui.screens.ImportState
import ro.mixai.decks.ui.screens.ImportStep

private class FakeImport(var locked: Boolean = false, var failRun: Boolean = false) : ImportPort {
    val previews = mutableListOf<ImportOptionsUi>()
    var ran: ImportOptionsUi? = null
    var resolvedSource: ImportSource? = null

    override fun resolve(source: ImportSource, path: String): ImportTarget? {
        resolvedSource = source
        return when {
            path.endsWith(".xml") -> ImportTarget(ImportSource.REKORDBOX, "rekordbox XML", path)
            path.endsWith("_Serato_") -> ImportTarget(ImportSource.SERATO, "Serato", path)
            else -> null
        }
    }

    override fun preview(target: ImportTarget, options: ImportOptionsUi): ImportResult<ImportPreviewUi> {
        previews += options
        val reloc = options.relocateRoots.size
        return ImportResult.Ok(
            ImportPreviewUi(
                target.label, 10, 6, 3, 1, 2 - reloc, reloc, 25, 9, 2, 14,
                List(2 - reloc) { "/gone/$it.mp3" }, locked, emptyList(),
            ),
        )
    }

    override fun run(target: ImportTarget, options: ImportOptionsUi): ImportResult<ImportReportUi> {
        if (locked) return ImportResult.Err(ImportFailure.PROTECTED, "locked")
        if (failRun) return ImportResult.Err(ImportFailure.FAILED, "disk full")
        ran = options
        return ImportResult.Ok(
            ImportReportUi(target.label, 10, 6, 3, 1, 25, 9, 2, 14, emptyList(), options.relocateRoots.size, 4, emptyList()),
        )
    }
}

class ImportTest {
    /** Counts imports; optional lock / throw (a uniffi InternalException is a plain Exception). */
    private class CountingImport(private val locked: Boolean = false, private val throwRun: Boolean = false) : ImportPort {
        var runs = 0
        private val inner = FakeImport(locked = locked)
        override fun resolve(source: ImportSource, path: String) = inner.resolve(source, path)
        override fun preview(target: ImportTarget, options: ImportOptionsUi) = inner.preview(target, options)
        override fun run(target: ImportTarget, options: ImportOptionsUi): ImportResult<ImportReportUi> {
            if (throwRun) throw Exception("rust panic")
            runs++
            return inner.run(target, options)
        }
    }

    /**
     * P1-20: a double tap must start ONE import. The panel claims the state with [ImportState.begin]
     * on the UI thread before launching the work, so the second tap is refused; the run itself goes
     * through `runClaimed`, which only the holder may call.
     */
    @Test fun aDoubleTapRunsTheImportOnlyOnce() {
        val fake = CountingImport()
        val s = ImportState(fake)
        s.pick("/exports/rekordbox.xml")
        assertTrue(s.canRun)

        // Tap 1 claims; tap 2 lands before the first finished and must be dropped.
        assertTrue(s.begin(), "first tap claims the panel")
        assertFalse(s.begin(), "second tap is refused while the first import runs")
        assertFalse(s.canRun, "and the Run button is disabled meanwhile")
        s.runClaimed()
        s.finish()

        assertEquals(1, fake.runs, "exactly one import")
        assertEquals(ImportStep.DONE, s.step)
    }

    /** The claim is released even when the port throws, so the panel never sticks on "Importing…". */
    @Test fun aThrowingRunStillReleasesTheBusyFlag() {
        val s = ImportState(CountingImport(throwRun = true))
        s.pick("/exports/rekordbox.xml")
        assertTrue(s.begin())
        val thrown = try {
            s.runClaimed()
            false
        } catch (_: Exception) {
            true
        } finally {
            s.finish()
        }
        assertTrue(thrown)
        assertFalse(s.busy)
        assertTrue(s.begin(), "claimable again")
        s.finish()
    }

    /** `runClaimed` re-checks the preconditions, so a stale claim cannot run a locked library. */
    @Test fun claimedRunStillRefusesALockedLibrary() {
        val fake = CountingImport(locked = true)
        val s = ImportState(fake)
        s.pick("/drive/_Serato_")
        assertTrue(s.begin())
        s.runClaimed()
        s.finish()
        assertEquals(0, fake.runs)
        assertEquals(ImportStep.PREVIEW, s.step)
    }

    @Test fun noPortMeansUnsupported() {
        val s = ImportState(null)
        assertFalse(s.available)
        s.pick("/x/rekordbox.xml")
        assertEquals(ImportFailure.UNSUPPORTED, s.failure)
        assertEquals(ImportStep.PICK, s.step)
    }

    @Test fun demoBackendHasNoImporterAndDemoImportRefuses() {
        assertNull(DemoBackend { 0.0 }.importer())
        assertNull(DemoImport.resolve(ImportSource.AUTO, "/x.xml"))
        val r = DemoImport.preview(ImportTarget(ImportSource.REKORDBOX, "x", "/x.xml"), ImportOptionsUi())
        assertTrue(r is ImportResult.Err && r.failure == ImportFailure.UNSUPPORTED)
    }

    @Test fun unrecognisedPathStaysOnPick() {
        val s = ImportState(FakeImport())
        s.pick("/music/notes.txt")
        assertEquals(ImportFailure.NOT_RECOGNISED, s.failure)
        assertEquals(ImportStep.PICK, s.step)
        assertNull(s.preview)
    }

    @Test fun previewThenRunWithChosenOptions() {
        val fake = FakeImport()
        val s = ImportState(fake)
        s.source = ImportSource.REKORDBOX
        s.pick("/exports/rekordbox.xml")
        assertEquals(ImportSource.REKORDBOX, fake.resolvedSource)
        assertEquals(ImportStep.PREVIEW, s.step)
        assertEquals(6, s.preview!!.newTracks)
        assertEquals(2, s.preview!!.missingFiles)
        assertTrue(s.canRun)

        s.setConflict(ImportConflictUi.MERGE)
        s.setDrift(false)
        s.addRelocateRoot("/Volumes/Music")
        s.addRelocateRoot("/Volumes/Music") // duplicate ignored
        assertEquals(listOf("/Volumes/Music"), s.options.relocateRoots)
        assertEquals(2, fake.previews.size, "adding a folder refreshes the preview")
        assertEquals(1, s.preview!!.relocatable)

        s.run()
        assertEquals(ImportStep.DONE, s.step)
        assertEquals(ImportOptionsUi(ImportConflictUi.MERGE, listOf("/Volumes/Music"), false), fake.ran)
        assertEquals(1, s.report!!.relocated)
        assertEquals(4, s.report!!.driftFixes)
        assertFalse(s.canRun)

        s.removeRelocateRoot("/Volumes/Music")
        assertTrue(s.options.relocateRoots.isEmpty())
        s.reset()
        assertEquals(ImportStep.PICK, s.step)
        assertNull(s.report)
    }

    @Test fun lockedLibraryPreviewsButCannotRun() {
        val fake = FakeImport(locked = true)
        val s = ImportState(fake)
        s.pick("/drive/_Serato_")
        assertEquals(ImportStep.PREVIEW, s.step)
        assertEquals(ImportFailure.PROTECTED, s.failure)
        assertFalse(s.canRun)
        s.run()
        assertNull(fake.ran)
        assertEquals(ImportStep.PREVIEW, s.step)
    }

    @Test fun failedRunReturnsToPreviewWithReason() {
        val s = ImportState(FakeImport(failRun = true))
        s.pick("/exports/rekordbox.xml")
        s.run()
        assertEquals(ImportStep.PREVIEW, s.step)
        assertEquals(ImportFailure.FAILED, s.failure)
        assertEquals("disk full", s.failureReason)
        assertNull(s.report)
    }
}
