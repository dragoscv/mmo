package ro.mixai.keybpm

import android.app.Application
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import ro.mixai.keybpm.audio.MicCapture
import ro.mixai.keybpm.data.KeyBpmPrefs
import ro.mixai.keybpm.data.LogEntry
import ro.mixai.keybpm.data.SetLog
import ro.mixai.keybpm.library.Library
import ro.mixai.keybpm.songid.PcmRing
import ro.mixai.keybpm.songid.PendingSignatures
import ro.mixai.keybpm.songid.SongIdResult
import ro.mixai.keybpm.songid.SongMatch
import ro.mixai.keybpm.songid.createSongIdEngine
import ro.mixai.tv.data.MmoApi
import uniffi.mixai_listen_ffi.EngineConfig
import uniffi.mixai_listen_ffi.KeyBpmEngine
import uniffi.mixai_listen_ffi.KeyNotation
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Process-wide live session (WP18-18): engine + mic + snapshot poll live here, not in the ViewModel, so listening
 * keeps going with the screen off or another app in front. [ListenService] holds the process in the foreground
 * (type microphone) while [ListenUi.listening] is true and mirrors the reading in an ongoing notification.
 */
class ListenSession(private val app: Application) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val mic = MicCapture(app)
    @Volatile private var engine: KeyBpmEngine? = null
    private var poll: Job? = null
    private val _ui = MutableStateFlow(ListenUi())
    val ui: StateFlow<ListenUi> = _ui.asStateFlow()
    val log = SetLog(app)
    private val prefs = KeyBpmPrefs(app)
    private val songId = createSongIdEngine(app, BuildConfig.SHAZAM_TOKEN_URL)
    private val pending = PendingSignatures(app)
    /** Last ~15 s of PCM16 for Song ID (only allocated when ShazamKit is in the build). */
    @Volatile private var ring: PcmRing? = null
    private var identifyJob: Job? = null
    @Volatile private var lastIdentifyAt = 0L
    /** Set-log entry of the song currently playing (live mode), so a match lands on it. */
    @Volatile private var currentEntryAt: Long? = null
    /** Match made before the reading locked: applied by the next [save]. */
    @Volatile private var unsavedMatch: SongIdUi.Found? = null

    init {
        scope.launch { log.load() }
        _ui.value = _ui.value.copy(songIdAvailable = songId.available, pendingIds = if (songId.available) pending.all().size else 0)
        scope.launch { prefs.tracklistMode.collect { on -> _ui.value = _ui.value.copy(tracklistMode = on) } }
    }

    /** Caller must hold RECORD_AUDIO and be in the foreground (FGS microphone start rule). */
    fun start() {
        if (_ui.value.listening) return
        val e = KeyBpmEngine(EngineConfig(48_000u, 88.0, _ui.value.a4.toDouble()))
        engine = e
        ring = if (songId.available) PcmRing(48_000, RING_SECONDS) else null
        val ok = mic.start { block ->
            engine?.pushPcmBytes(toLeBytes(block))
            ring?.push(block)
        }
        if (!ok) {
            engine = null
            e.close()
            _ui.value = _ui.value.copy(micFailed = true)
            return
        }
        // Recreate with the real capture rate (48 or 44.1 kHz) before the first block is analysed.
        if (mic.sampleRate != 48_000) {
            engine = KeyBpmEngine(EngineConfig(mic.sampleRate.toUInt(), 88.0, _ui.value.a4.toDouble()))
            e.close()
            if (songId.available) ring = PcmRing(mic.sampleRate, RING_SECONDS)
        }
        currentEntryAt = null
        unsavedMatch = null
        _ui.value = _ui.value.copy(
            listening = true, snapshot = null, micFailed = false, keyChange = null, tempoFactor = 1.0,
            fileName = null, fileError = false, saved = false, startedAtMillis = System.currentTimeMillis(),
            songId = SongIdUi.Idle,
        )
        ContextCompat.startForegroundService(app, ListenService.intent(app))
        retryPending()
        poll = scope.launch {
            while (isActive) {
                val s = engine?.snapshot() ?: break
                val change = if (s.keyChanged) s.key?.key?.camelot else null
                // A key change mid-set is a new song for the log.
                if (change != null) {
                    currentEntryAt = null
                    unsavedMatch = null
                    identifyJob?.cancel()
                }
                _ui.value = _ui.value.copy(
                    snapshot = s, keyChange = change ?: _ui.value.keyChange, saved = _ui.value.saved && change == null,
                    songId = if (change != null) SongIdUi.Idle else _ui.value.songId,
                )
                if (!_ui.value.saved && s.key?.locked == true && s.tempo?.locked == true) save("mic")
                delay(50)
            }
        }
    }

    fun stop() {
        mic.stop()
        poll?.cancel()
        poll = null
        identifyJob?.cancel()
        identifyJob = null
        engine?.close()
        engine = null
        ring = null
        val sid = _ui.value.songId
        _ui.value = _ui.value.copy(
            listening = false, startedAtMillis = null,
            songId = if (sid is SongIdUi.Collecting || sid is SongIdUi.Matching) SongIdUi.Idle else sid,
        )
        app.stopService(ListenService.intent(app))
    }

    fun again() {
        stop()
        start()
    }

    /** Saves the current reading (auto on lock while listening, manual from the Save button / file mode). */
    fun save(source: String = if (_ui.value.fileName != null) "file" else "mic") {
        val u = _ui.value
        val k = u.snapshot?.key ?: return
        val t = u.snapshot.tempo ?: return
        _ui.value = u.copy(saved = true)
        val at = System.currentTimeMillis()
        val m = if (source == "mic") unsavedMatch else null
        if (source == "mic") currentEntryAt = at
        unsavedMatch = null
        scope.launch {
            val base = LogEntry(at, k.key.camelot, k.key.name, t.bpm * u.tempoFactor, k.confidence, source, title = u.fileName)
            log.add(if (m != null) withMatch(base, m) else base)
            // Tracklist mode: one Song ID per new song, at most one attempt every 45 s.
            if (source == "mic" && m == null && u.tracklistMode && songId.available && System.currentTimeMillis() - lastIdentifyAt > TRACKLIST_GAP_MS) identify()
        }
    }

    /** Song ID on the last seconds of live audio (WP18-06). Waits up to 20 s for enough audio. */
    fun identify() {
        if (!songId.available || !_ui.value.listening) return
        if (identifyJob?.isActive == true) return
        identifyJob = scope.launch {
            lastIdentifyAt = System.currentTimeMillis()
            val r0 = ring ?: return@launch
            if (r0.filledSeconds < MIN_ID_SECONDS) {
                _ui.value = _ui.value.copy(songId = SongIdUi.Collecting)
                val deadline = System.currentTimeMillis() + 20_000
                while (isActive && (ring?.filledSeconds ?: 0.0) < MIN_ID_SECONDS && System.currentTimeMillis() < deadline) delay(250)
            }
            val r = ring ?: return@launch
            _ui.value = _ui.value.copy(songId = SongIdUi.Matching)
            val entryAt = currentEntryAt
            val result = songId.identify(r.snapshot(ID_SECONDS), r.sampleRate, entryAt)
            lastIdentifyAt = System.currentTimeMillis()
            _ui.value = _ui.value.copy(songId = applyResult(result, entryAt, live = true), pendingIds = pending.all().size)
            if (result is SongIdResult.Match) retryPending()
        }
    }

    fun setTracklistMode(on: Boolean) {
        scope.launch { prefs.setTracklistMode(on) }
        if (on && _ui.value.listening && _ui.value.saved && currentEntryAt != null && _ui.value.songId is SongIdUi.Idle) identify()
    }

    /** "Add to MixAI queue" for the identified library track. */
    fun addFoundToQueue() {
        val f = _ui.value.songId as? SongIdUi.Found ?: return
        val id = f.libraryTrackId ?: return
        scope.launch {
            val api = libraryApi() ?: return@launch
            val profile = (app as KeyBpmApp).settings.activeProfile.first().id
            val ok = runCatching { Library.addToQueue(api, profile, id) }.isSuccess
            if (ok) {
                val cur = _ui.value.songId
                if (cur is SongIdUi.Found && cur.libraryTrackId == id) _ui.value = _ui.value.copy(songId = cur.copy(queued = true))
            }
        }
    }

    /** Converts an engine result to UI state and writes a match into the set log. */
    private suspend fun applyResult(result: SongIdResult, entryAt: Long?, live: Boolean): SongIdUi = when (result) {
        is SongIdResult.Match -> {
            val found = withLibrary(result.song)
            when {
                entryAt != null -> {
                    val kept = log.update(entryAt) { withMatch(it, found) }
                    if (live && kept != null) currentEntryAt = kept
                }
                live -> unsavedMatch = found
            }
            found
        }
        SongIdResult.NoMatch -> SongIdUi.NoMatch
        is SongIdResult.Queued -> SongIdUi.Offline
        is SongIdResult.Failed -> SongIdUi.Error(result.reason)
    }

    private fun withMatch(e: LogEntry, f: SongIdUi.Found) = e.copy(
        title = f.song.title, artist = f.song.artist, isrc = f.song.isrc, artworkUrl = f.song.artworkUrl,
        appleMusicUrl = f.song.appleMusicUrl, libraryTrackId = f.libraryTrackId, libraryCamelot = f.libraryCamelot,
        libraryBpm = f.libraryBpm, libraryPath = f.libraryTrackId?.let { libraryPaths[it] },
    )

    private val libraryPaths = java.util.concurrent.ConcurrentHashMap<String, String>()

    private suspend fun libraryApi(): MmoApi? {
        val conn = (app as KeyBpmApp).settings.connection.first()
        if (conn.baseUrl.isBlank() || conn.token.isBlank()) return null
        return MmoApi(conn.baseUrl, conn.token).also { api ->
            if (conn.userId.isNotBlank()) api.extraHeaders = { mapOf("x-user-id" to conn.userId) }
        }
    }

    /** "In your MixAI library" check (optional server; silent when offline or not connected). */
    private suspend fun withLibrary(song: SongMatch): SongIdUi.Found {
        val api = runCatching { libraryApi() }.getOrNull() ?: return SongIdUi.Found(song)
        val hit = runCatching { Library.findSong(api, song.title, song.artist) }.getOrNull() ?: return SongIdUi.Found(song)
        Library.filePath(api, hit.id)?.let { libraryPaths[hit.id] = it }
        return SongIdUi.Found(song, hit.id, hit.keyCamelot, hit.bpm)
    }

    /** Matches fingerprints captured offline (at most 5 per pass). */
    private fun retryPending() {
        if (!songId.available) return
        scope.launch {
            for (s in pending.all().take(5)) {
                pending.remove(s)
                val r = songId.retry(s)
                if (r is SongIdResult.Queued) break
                applyResult(r, s.entryAtMillis, live = false)
            }
            _ui.value = _ui.value.copy(pendingIds = pending.all().size)
        }
    }

    fun deleteEntry(atMillis: Long) {
        scope.launch { log.remove(atMillis) }
    }

    fun clearLog() {
        scope.launch { log.clear() }
    }

    fun cycleTempo() {
        val next = when (_ui.value.tempoFactor) { 1.0 -> 2.0; 2.0 -> 0.5; else -> 1.0 }
        _ui.value = _ui.value.copy(tempoFactor = next)
    }

    fun setNotation(n: KeyNotation) {
        _ui.value = _ui.value.copy(notation = n)
    }

    fun setA4(hz: Int) {
        val v = hz.coerceIn(415, 466)
        engine?.setA4(v.toDouble())
        _ui.value = _ui.value.copy(a4 = v)
    }

    fun dismissKeyChange() {
        _ui.value = _ui.value.copy(keyChange = null, micFailed = false)
    }

    /** File mode: copy the picked document to cache (symphonia needs a path + extension) and analyse it. */
    fun analyzeUri(uri: android.net.Uri) {
        stop()
        val name = app.contentResolver.query(uri, arrayOf(android.provider.OpenableColumns.DISPLAY_NAME), null, null, null)
            ?.use { c -> if (c.moveToFirst()) c.getString(0) else null } ?: "audio"
        _ui.value = _ui.value.copy(analysing = true, fileName = name, snapshot = null, fileError = false, keyChange = null, saved = false)
        scope.launch(Dispatchers.IO) {
            val ext = name.substringAfterLast('.', "mp3").lowercase().take(5)
            val tmp = java.io.File(app.cacheDir, "analyse.$ext")
            val result = runCatching {
                app.contentResolver.openInputStream(uri)!!.use { input -> tmp.outputStream().use { input.copyTo(it) } }
                uniffi.mixai_listen_ffi.analyzeFile(tmp.absolutePath, 88.0)
            }
            tmp.delete()
            _ui.value = _ui.value.copy(analysing = false, snapshot = result.getOrNull(), fileError = result.isFailure)
        }
    }

    fun clearFile() {
        _ui.value = _ui.value.copy(fileName = null, snapshot = null, fileError = false)
    }

    private fun toLeBytes(block: FloatArray): ByteArray {
        val bb = ByteBuffer.allocate(block.size * 4).order(ByteOrder.LITTLE_ENDIAN)
        bb.asFloatBuffer().put(block)
        return bb.array()
    }

    private companion object {
        const val RING_SECONDS = 15
        const val MIN_ID_SECONDS = 8.0
        const val ID_SECONDS = 12.0
        const val TRACKLIST_GAP_MS = 45_000L
    }
}
