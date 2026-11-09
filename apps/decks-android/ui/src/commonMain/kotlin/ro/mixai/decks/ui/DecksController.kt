package ro.mixai.decks.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import ro.mixai.decks.ui.engine.Band
import ro.mixai.decks.ui.engine.DecksBackend
import ro.mixai.decks.ui.engine.IntentUi
import ro.mixai.decks.ui.engine.Monitoring
import ro.mixai.decks.ui.engine.PlanUi
import ro.mixai.decks.ui.engine.RemoteMixerUi
import ro.mixai.decks.ui.engine.RemotePairingUi
import ro.mixai.decks.ui.engine.RemotePort
import ro.mixai.decks.ui.engine.RemoteRoleUi
import ro.mixai.decks.ui.engine.RequestStateUi
import ro.mixai.decks.ui.engine.SafetyUi
import ro.mixai.decks.ui.engine.SetRecording
import ro.mixai.decks.ui.engine.SongRequestUi
import ro.mixai.decks.ui.engine.SuggestionUi
import ro.mixai.decks.ui.engine.TracklistEntryUi
import ro.mixai.decks.ui.engine.TracklistFormatUi
import ro.mixai.decks.ui.engine.TransitionRun
import ro.mixai.decks.ui.engine.TransitionStyleUi
import ro.mixai.decks.ui.engine.TransitionTrackUi
import ro.mixai.decks.ui.logic.DeckMath
import ro.mixai.decks.ui.model.CrateItem
import ro.mixai.decks.ui.model.EngineState
import ro.mixai.decks.ui.model.LoadPhase
import ro.mixai.decks.ui.model.MidiAction
import ro.mixai.decks.ui.model.PeaksData
import ro.mixai.decks.ui.model.ScanProgress
import ro.mixai.decks.ui.model.TrackMeta
import ro.mixai.decks.ui.model.TrackRow
import ro.mixai.decks.ui.model.WaveDeck
import ro.mixai.decks.ui.model.WaveFrame

/** UI-only control positions of one deck (the engine snapshot does not echo them all). */
class DeckControls {
    var tempoFader by mutableStateOf(0f)
    var tempoRangeIndex by mutableStateOf(1)
    var loopBeats by mutableStateOf(4.0)
    var jumpBeats by mutableStateOf(4.0)
    var eqLow by mutableStateOf(0f)
    var eqMid by mutableStateOf(0f)
    var eqHigh by mutableStateOf(0f)
    var filter by mutableStateOf(0f)
    var gainDb by mutableStateOf(0f)
    var volume by mutableStateOf(1f)
    var keyShift by mutableStateOf(0.0)
    var meta by mutableStateOf<TrackMeta?>(null)
    var peaks by mutableStateOf<PeaksData?>(null)
    var peaksVersion by mutableStateOf(0)
    var loadPhase by mutableStateOf<LoadPhase?>(null)
    var loadError by mutableStateOf<String?>(null)
    var hotCueDeleteMode by mutableStateOf(false)

    val tempoRange: Double get() = DeckMath.TEMPO_RANGES[tempoRangeIndex]
}

/**
 * The single state holder of the Decks UI. Owns the [DecksBackend], polls it once per frame
 * ([tick], driven by the root composable's frame clock) and exposes Compose state. All user
 * intents (buttons, keyboard, MIDI) go through here so they behave identically.
 */
class DecksController(val backend: DecksBackend) {
    var engine by mutableStateOf(EngineState())
        private set
    val controls = List(EngineState.DECKS) { DeckControls() }
    var crossfader by mutableStateOf(0f)
        private set
    var masterVolume by mutableStateOf(0.9f)
        private set
    var cueMix by mutableStateOf(0.5f)
        private set
    var headphoneLevel by mutableStateOf(0.8f)
        private set
    var startError by mutableStateOf<String?>(null)
        private set

    // Library
    var query by mutableStateOf("")
        private set
    var results by mutableStateOf<List<TrackRow>>(emptyList())
        private set
    val crates = mutableStateListOf<CrateItem>()
    var selectedCrate by mutableStateOf<Long?>(null)
        private set
    var selectedRow by mutableStateOf(0)
    var scan by mutableStateOf<ScanProgress?>(null)
        private set

    // MIDI
    var midiStatus by mutableStateOf<String?>(null)
    var lastMidi by mutableStateOf<String?>(null)
        private set

    // Connected mode (phone remote / second screen / Party DJ)
    var remote: RemotePort? = null
        private set
    var remoteOn by mutableStateOf(false)
        private set
    var remoteError by mutableStateOf(false)
        private set
    var pairings by mutableStateOf<Map<RemoteRoleUi, RemotePairingUi>>(emptyMap())
        private set
    var requests by mutableStateOf<List<SongRequestUi>>(emptyList())
        private set
    var partyOpen by mutableStateOf(true)
        private set
    var remoteClients by mutableStateOf(0)
        private set

    // AI Transition Designer
    var suggestions by mutableStateOf<List<SuggestionUi>>(emptyList())
        private set
    var plan by mutableStateOf<PlanUi?>(null)
        private set
    var mixProgress by mutableStateOf<Double?>(null)
        private set
    var safety by mutableStateOf<List<SafetyUi>>(emptyList())
        private set
    var lastIntent by mutableStateOf<IntentUi?>(null)
        private set
    private var mixRun: TransitionRun? = null
    private var planFrom = 0
    private var planTo = 1
    private var planBars: Int? = null
    private var planStyle: TransitionStyleUi? = null

    // Set recording (WP19-22)
    private var recording: SetRecording? = null
    var recordingOn by mutableStateOf(false)
        private set
    var recordElapsed by mutableStateOf(0.0)
        private set
    var tracklist by mutableStateOf<List<TracklistEntryUi>>(emptyList())
        private set
    var lastSetWav by mutableStateOf<String?>(null)
        private set
    var recordError by mutableStateOf(false)
        private set

    private val loadTickets = LongArray(EngineState.DECKS) { -1L }
    private var scanId = -1L
    private var frame = 0L
    private var started = false

    fun startEngine() {
        if (started) return
        started = true
        startError = backend.start()
        backend.setMasterVolume(masterVolume)
        backend.setMonitoring(Monitoring(cueMix, headphoneLevel))
        refreshLibrary()
    }

    /** Called once per frame (≈60 Hz). Cheap: one snapshot; loads/scans polled every 6th frame. */
    fun tick() {
        engine = backend.snapshot()
        frame++
        if (frame % 6L == 0L) pollJobs()
        if (remote != null && frame % 4L == 0L) pumpRemote()
        mixRun?.let { r ->
            val (p, done) = r.tick(engine.clock.beat)
            mixProgress = p
            if (done) { mixRun = null; mixProgress = null; plan = null }
        }
        if (frame % 30L == 0L) refreshSafety()
        recording?.let { r ->
            if (frame % 15L == 0L) {
                r.observe()
                recordElapsed = r.elapsedSec()
                tracklist = r.entries()
            }
        }
    }

    // ---- Set recording -------------------------------------------------------------------

    /** Start recording the master to [wavPath] with an automatic tracklist. */
    fun startRecording(wavPath: String): Boolean {
        if (recording != null) return true
        val r = backend.setRecorder()?.start(wavPath)
        recordError = r == null
        if (r == null) return false
        recording = r
        recordingOn = true
        tracklist = emptyList()
        lastSetWav = wavPath
        for (d in controls.indices) labelForRecording(d)
        return true
    }

    fun stopRecording() {
        val r = recording ?: return
        tracklist = r.stop()
        recording = null
        recordingOn = false
    }

    fun removeTracklistEntry(index: Int) {
        val r = recording
        if (r != null) { r.remove(index); tracklist = r.entries() }
        else if (index in tracklist.indices) {
            val l = tracklist.toMutableList()
            val gone = l.removeAt(index)
            if (index > 0) l[index - 1] = l[index - 1].copy(playedSec = l[index - 1].playedSec + gone.playedSec)
            tracklist = l
        }
    }

    /** Export the current tracklist; empty when unavailable. */
    fun exportTracklist(format: TracklistFormatUi, title: String, dj: String): String {
        val port = backend.setRecorder() ?: return ""
        val wav = lastSetWav?.substringAfterLast('/')?.substringAfterLast('\\') ?: "set.wav"
        return port.export(tracklist, format, wav, title, dj)
    }

    private fun labelForRecording(d: Int) {
        val r = recording ?: return
        val s = deck(d) ?: return
        if (!s.loaded) return
        val row = deckRows[d]
        r.label(d, row?.id ?: "deck$d:${s.title}", controls[d].meta?.title ?: row?.title ?: s.title ?: "", row?.artist ?: "", null, row?.path)
    }

    private val deckRows = arrayOfNulls<TrackRow>(EngineState.DECKS)

    // ---- AI Transition Designer ----------------------------------------------------------

    /** The deck carrying the mix right now: the louder playing deck (crossfader-aware), else 0. */
    fun liveDeck(): Int {
        val playing = engine.decks.take(2).filter { it.playing && it.loaded }
        if (playing.size == 1) return playing[0].index
        if (playing.size == 2) return if (crossfader <= 0f) 0 else 1
        return 0
    }

    private fun deckTrack(d: Int): TransitionTrackUi? {
        val s = deck(d) ?: return null
        if (!s.loaded) return null
        val m = controls[d].meta
        return TransitionTrackUi(
            id = "deck$d:${s.title}",
            title = m?.title ?: s.title ?: "",
            artist = deckArtists[d] ?: "",
            bpm = s.bpm ?: m?.bpm,
            key = s.key ?: m?.key,
            durationSec = s.durationSec,
            firstBeatSec = m?.firstBeatSec ?: 0.0,
        )
    }

    private fun TrackRow.features() = TransitionTrackUi(id, title, artist ?: "", bpm, key, durationSec ?: 0.0)

    /** Rank the visible library rows as next after the live deck. */
    fun suggestNext() {
        val port = backend.transitions() ?: return
        val live = deckTrack(liveDeck()) ?: return
        suggestions = port.rankNext(live, results.take(500).map { it.features() }, 8)
    }

    /** Load the best suggestion on the other deck. */
    fun loadSuggestion(id: String) {
        val row = results.firstOrNull { it.id == id } ?: return
        loadToDeck(1 - liveDeck(), row)
    }

    /** Plan a transition from the live deck to the other one (both loaded). */
    fun planMix(bars: Int? = planBars, style: TransitionStyleUi? = planStyle): PlanUi? {
        val port = backend.transitions() ?: return null
        val from = liveDeck()
        val to = 1 - from
        val a = deckTrack(from) ?: return null
        val b = deckTrack(to) ?: return null
        val p = port.plan(a, b, from, to, deck(from)?.playheadSec ?: 0.0, bars, style) ?: return null
        planFrom = from
        planTo = to
        planBars = bars
        planStyle = style
        plan = p
        return p
    }

    /** Prepare the incoming deck (cue + tempo) and start the automation on the planned beat. */
    fun startMix(): Boolean {
        val port = backend.transitions() ?: return false
        val p = plan ?: planMix() ?: return false
        backend.seek(planTo, p.toCueSec)
        val ratio = p.toTempoRatio
        val c = controls[planTo]
        c.tempoFader = DeckMath.ratioToFader(ratio, c.tempoRange).coerceIn(-1f, 1f)
        backend.setTempo(planTo, ratio)
        val r = port.startRun(p.automationJson, engine.clock.beat + p.beatsUntilStart) ?: return false
        mixRun = r
        mixProgress = 0.0
        return true
    }

    fun cancelMix() {
        mixRun = null
        mixProgress = null
        plan = null
    }

    private fun refreshSafety() {
        val port = backend.transitions() ?: return
        val d = liveDeck()
        val live = deckTrack(d)
        if (live == null || deck(d)?.playing != true) { safety = emptyList(); return }
        safety = port.safety(live, deck(d)?.playheadSec ?: 0.0, deck(d)?.tempo ?: 1.0, deckTrack(1 - d), plan?.bars)
    }

    /** Voice / typed command (RO / EN). Returns false when not understood. */
    fun command(text: String): Boolean {
        val port = backend.transitions() ?: return false
        val i = port.parseIntent(text) ?: return false
        lastIntent = i
        val d = i.deck ?: liveDeck()
        when (i.action) {
            "mix_next" -> { plan = null; planMix(i.bars, i.style); startMix() }
            "suggest" -> suggestNext()
            "cancel" -> cancelMix()
            "play" -> backend.play(d)
            "pause" -> backend.pause(d)
            "sync" -> syncTap(d)
            "loop" -> { i.beats?.let { controls[d].loopBeats = it }; backend.loopAuto(d, controls[d].loopBeats) }
            else -> return false
        }
        return true
    }

    // ---- Connected mode ------------------------------------------------------------------

    /** Start or stop the LAN server. Returns false when it could not start (demo engine, port). */
    fun setRemoteEnabled(on: Boolean): Boolean {
        if (on == remoteOn) return true
        if (!on) {
            remote?.close()
            remote = null
            remoteOn = false
            pairings = emptyMap()
            requests = emptyList()
            remoteClients = 0
            return true
        }
        val r = backend.startRemote()
        remoteError = r == null
        if (r == null) return false
        remote = r
        remoteOn = true
        r.setPartyOpen(partyOpen)
        pairings = RemoteRoleUi.entries.mapNotNull { role -> r.pairing(role)?.let { role to it } }.toMap()
        for (d in controls.indices) labelDeck(d)
        return true
    }

    fun rotatePairing(role: RemoteRoleUi) {
        val p = remote?.rotate(role) ?: return
        pairings = pairings + (role to p)
    }

    fun changePartyOpen(open: Boolean) {
        partyOpen = open
        remote?.setPartyOpen(open)
    }

    fun moderate(id: Long, state: RequestStateUi) {
        val r = remote ?: return
        r.setRequestState(id, state)
        requests = r.requests()
    }

    fun clearDoneRequests() {
        val r = remote ?: return
        r.clearDone()
        requests = r.requests()
    }

    private fun labelDeck(d: Int) {
        val m = controls[d].meta
        remote?.setTrackLabels(d, m?.title ?: deck(d)?.title, artistOf(d))
    }

    private val deckArtists = arrayOfNulls<String>(EngineState.DECKS)

    private fun artistOf(d: Int): String? = deckArtists[d]

    private fun pumpRemote() {
        val r = remote ?: return
        val rep = r.pump()
        for (m in rep.mixer) applyRemoteMixer(m)
        if (frame % 24L == 0L) {
            requests = r.requests()
            remoteClients = r.clientCount()
        }
    }

    /** Moves this shell's knobs when a phone moved them (the engine already applied it). */
    fun applyRemoteMixer(m: RemoteMixerUi) {
        when (m) {
            is RemoteMixerUi.Volume -> controls.getOrNull(m.deck)?.volume = m.value
            is RemoteMixerUi.Eq -> controls.getOrNull(m.deck)?.let { c ->
                when (m.band) { Band.LOW -> c.eqLow = m.db; Band.MID -> c.eqMid = m.db; Band.HIGH -> c.eqHigh = m.db }
            }
            is RemoteMixerUi.Filter -> controls.getOrNull(m.deck)?.filter = m.value
            is RemoteMixerUi.Crossfader -> crossfader = m.value
            is RemoteMixerUi.MasterVolume -> masterVolume = m.value
        }
    }

    private fun pollJobs() {
        for (d in loadTickets.indices) {
            val t = loadTickets[d]
            if (t < 0) continue
            val st = backend.loadStatus(t) ?: continue
            val c = controls[d]
            c.loadPhase = st.phase
            c.loadError = st.error
            when (st.phase) {
                LoadPhase.READY -> {
                    loadTickets[d] = -1
                    c.meta = backend.trackMeta(d)
                    c.peaks = backend.peaks(d)
                    c.peaksVersion++
                    c.loadPhase = null
                    labelDeck(d)
                    labelForRecording(d)
                }
                LoadPhase.FAILED, LoadPhase.CANCELLED -> loadTickets[d] = -1
                else -> Unit
            }
        }
        if (scanId >= 0) {
            val s = backend.scanStatus(scanId)
            scan = s
            if (s != null && s.finished) {
                scanId = -1
                refreshLibrary()
            }
        }
    }

    // ---- Library -------------------------------------------------------------------------

    fun refreshLibrary() {
        crates.clear()
        crates.addAll(backend.crates())
        results = selectedCrate?.let { backend.crateTracks(it) } ?: backend.search(query, 500)
        selectedRow = selectedRow.coerceIn(0, maxOf(0, results.size - 1))
    }

    fun search(q: String) {
        query = q
        selectedCrate = null
        results = backend.search(q, 500)
        selectedRow = 0
    }

    fun selectCrate(id: Long?) {
        selectedCrate = id
        results = id?.let { backend.crateTracks(it) } ?: backend.search(query, 500)
        selectedRow = 0
    }

    fun scanFolder(folder: String) {
        scanId = backend.scanFolder(folder)
        scan = ScanProgress(0, 0, scanId < 0, scanId < 0, 0, if (scanId < 0) "scan refused" else null)
    }

    fun loadToDeck(deck: Int, row: TrackRow) {
        val c = controls[deck]
        c.meta = null
        c.peaks = null
        c.loadError = null
        c.loadPhase = LoadPhase.QUEUED
        c.tempoFader = 0f
        c.keyShift = 0.0
        deckArtists[deck] = row.artist
        deckRows[deck] = row
        loadTickets[deck] = backend.load(deck, row.path)
        if (loadTickets[deck] < 0) {
            c.loadPhase = LoadPhase.FAILED
            c.loadError = "load refused"
        }
    }

    fun loadSelected(deck: Int) {
        results.getOrNull(selectedRow)?.let { loadToDeck(deck, it) }
    }

    fun moveSelection(delta: Int) {
        if (results.isEmpty()) return
        selectedRow = (selectedRow + delta).coerceIn(0, results.size - 1)
    }

    // ---- Transport -----------------------------------------------------------------------

    fun deck(i: Int) = engine.decks.getOrNull(i)

    fun togglePlay(d: Int) {
        if (deck(d)?.playing == true) backend.pause(d) else backend.play(d)
    }

    fun cue(d: Int, pressed: Boolean) = backend.cue(d, pressed)

    fun hotCue(d: Int, slot: Int) {
        val c = controls[d]
        val set = deck(d)?.hotCues?.getOrNull(slot) != null
        when {
            c.hotCueDeleteMode && set -> backend.hotCueDelete(d, slot)
            set -> backend.hotCueJump(d, slot)
            else -> backend.hotCueSet(d, slot)
        }
    }

    fun toggleHotCueDelete(d: Int) { controls[d].hotCueDeleteMode = !controls[d].hotCueDeleteMode }

    fun loopAuto(d: Int) {
        if (deck(d)?.loopActive == true) backend.loopExit(d) else backend.loopAuto(d, controls[d].loopBeats)
    }

    fun loopHalve(d: Int) {
        val c = controls[d]
        c.loopBeats = DeckMath.stepLoop(c.loopBeats, up = false)
        if (deck(d)?.loopActive == true) backend.loopHalve(d)
    }

    fun loopDouble(d: Int) {
        val c = controls[d]
        c.loopBeats = DeckMath.stepLoop(c.loopBeats, up = true)
        if (deck(d)?.loopActive == true) backend.loopDouble(d)
    }

    fun beatJump(d: Int, forward: Boolean) {
        val b = controls[d].jumpBeats
        backend.beatJump(d, if (forward) b else -b)
    }

    fun seekFraction(d: Int, fraction: Float) {
        val dur = deck(d)?.durationSec ?: return
        if (dur > 0) backend.seek(d, dur * fraction.coerceIn(0f, 1f))
    }

    fun nudge(d: Int, seconds: Double) {
        val p = deck(d)?.playheadSec ?: return
        backend.seek(d, (p + seconds).coerceAtLeast(0.0))
    }

    // ---- Tempo / key / sync --------------------------------------------------------------

    fun setTempoFader(d: Int, v: Float) {
        val c = controls[d]
        c.tempoFader = v.coerceIn(-1f, 1f)
        if (deck(d)?.syncLock == true) backend.setSyncLock(d, false)
        backend.setTempo(d, DeckMath.faderToRatio(c.tempoFader, c.tempoRange))
    }

    fun cycleTempoRange(d: Int) {
        val c = controls[d]
        val ratio = DeckMath.faderToRatio(c.tempoFader, c.tempoRange)
        c.tempoRangeIndex = (c.tempoRangeIndex + 1) % DeckMath.TEMPO_RANGES.size
        c.tempoFader = DeckMath.ratioToFader(ratio, c.tempoRange)
        backend.setTempo(d, DeckMath.faderToRatio(c.tempoFader, c.tempoRange))
    }

    fun resetTempo(d: Int) = setTempoFader(d, 0f)

    fun toggleKeyLock(d: Int) = backend.setKeyLock(d, !(deck(d)?.keyLock ?: false))

    fun shiftKey(d: Int, delta: Double) {
        val c = controls[d]
        c.keyShift = (c.keyShift + delta).coerceIn(-12.0, 12.0)
        backend.setKeyShift(d, c.keyShift)
    }

    fun keyMatch(d: Int) {
        controls[d].keyShift = backend.keyMatch(d)
    }

    /** Tap = one-shot beat sync; tapping a locked deck unlocks it (CDJ "SYNC" semantics). */
    fun syncTap(d: Int) {
        val locked = deck(d)?.syncLock == true
        if (locked) backend.setSyncLock(d, false) else backend.phaseSync(d, false)
    }

    fun syncLock(d: Int) = backend.setSyncLock(d, !(deck(d)?.syncLock ?: false))
    fun toggleQuantize(d: Int) = backend.setQuantize(d, !(deck(d)?.quantize ?: true))
    fun toggleSlip(d: Int) = backend.setSlip(d, !(deck(d)?.slip ?: false))

    // ---- Mixer ---------------------------------------------------------------------------

    fun setEq(d: Int, band: Band, db: Float) {
        val c = controls[d]
        val v = db.coerceIn(-26f, 6f)
        when (band) { Band.LOW -> c.eqLow = v; Band.MID -> c.eqMid = v; Band.HIGH -> c.eqHigh = v }
        backend.setEq(d, band, v)
    }

    fun setFilter(d: Int, v: Float) { controls[d].filter = v.coerceIn(-1f, 1f); backend.setFilter(d, controls[d].filter) }
    fun setGain(d: Int, db: Float) { controls[d].gainDb = db.coerceIn(-12f, 12f); backend.setGain(d, controls[d].gainDb) }
    fun setVolume(d: Int, v: Float) { controls[d].volume = v.coerceIn(0f, 1f); backend.setVolume(d, controls[d].volume) }
    fun togglePfl(d: Int) = backend.setPfl(d, !(deck(d)?.pfl ?: false))
    fun changeCrossfader(v: Float) { crossfader = v.coerceIn(-1f, 1f); backend.setCrossfader(crossfader) }
    fun changeMaster(v: Float) { masterVolume = v.coerceIn(0f, 1f); backend.setMasterVolume(masterVolume) }
    fun changeCueMix(v: Float) { cueMix = v.coerceIn(0f, 1f); backend.setMonitoring(Monitoring(cueMix, headphoneLevel)) }
    fun changeHeadphoneLevel(v: Float) { headphoneLevel = v.coerceIn(0f, 1f); backend.setMonitoring(Monitoring(cueMix, headphoneLevel)) }

    // ---- Waveform frame ------------------------------------------------------------------

    fun waveFrame(zoomSeconds: Float, reducedMotion: Boolean) = WaveFrame(
        decks = engine.decks.map { d ->
            val c = controls[d.index]
            WaveDeck(
                index = d.index,
                loaded = d.loaded,
                playheadSec = d.playheadSec,
                durationSec = d.durationSec,
                bpm = d.bpm ?: c.meta?.bpm,
                firstBeatSec = c.meta?.firstBeatSec,
                cuePointSec = d.cuePointSec,
                hotCues = d.hotCues,
                loopActive = d.loopActive,
                loopStartSec = d.loopStartSec,
                loopEndSec = d.loopEndSec,
                peaksVersion = c.peaksVersion,
            )
        },
        zoomSeconds = zoomSeconds,
        reducedMotion = reducedMotion,
    )

    // ---- MIDI ----------------------------------------------------------------------------

    /** Raw bytes from a platform MIDI port → mapping engine → the same intents as the UI. */
    fun onMidiBytes(port: String, bytes: ByteArray, timestampUs: Long) {
        backend.onMidi(port, bytes, timestampUs).forEach(::dispatch)
    }

    /** Applies one decoded controller action. Public for tests. Returns false when unhandled. */
    fun dispatch(a: MidiAction): Boolean {
        lastMidi = "${a.group}.${a.kind}" + (a.deck?.let { " #${it + 1}" } ?: "")
        val d = (a.deck ?: 0).coerceIn(0, EngineState.DECKS - 1)
        val pressed = a.pressed ?: true
        val v = a.value ?: 0f
        when (a.group) {
            "deck" -> when (a.kind) {
                "play_pause" -> if (pressed) togglePlay(d)
                "cue" -> cue(d, pressed)
                "sync" -> if (pressed) syncTap(d)
                "sync_off" -> backend.setSyncLock(d, false)
                "tempo" -> setTempoFader(d, v)
                "tempo_range_cycle" -> if (pressed) cycleTempoRange(d)
                "key_lock" -> if (pressed) toggleKeyLock(d)
                "key_shift" -> { val st = a.semitones ?: 0.0; controls[d].keyShift = st; backend.setKeyShift(d, st) }
                "hot_cue" -> if (pressed) a.slot?.let { hotCue(d, it.coerceIn(0, 7)) }
                "hot_cue_delete" -> a.slot?.let { backend.hotCueDelete(d, it) }
                "auto_loop" -> if (pressed) { a.beats?.let { controls[d].loopBeats = it }; loopAuto(d) }
                "loop_in" -> if (pressed) backend.loopIn(d)
                "loop_out" -> if (pressed) backend.loopOut(d)
                "loop_exit" -> backend.loopExit(d)
                "loop_halve" -> if (pressed) loopHalve(d)
                "loop_double" -> if (pressed) loopDouble(d)
                "loop_active_toggle" -> if (pressed) backend.loopToggle(d)
                "beat_jump" -> if (pressed) backend.beatJump(d, a.beats ?: controls[d].jumpBeats)
                "beat_jump_by_size" -> if (pressed) beatJump(d, (a.direction ?: 1) > 0)
                "jog_bend" -> a.delta?.let { nudge(d, it * 0.002) }
                "jog_search", "jog_scratch" -> a.delta?.let { nudge(d, it * 0.02) }
                else -> return false
            }
            "mixer" -> when (a.kind) {
                "volume" -> setVolume(d, v)
                "trim" -> setGain(d, DeckMath.unitToTrimDb(v))
                "eq" -> setEq(
                    d,
                    when (a.band) { "low" -> Band.LOW; "mid" -> Band.MID; else -> Band.HIGH },
                    DeckMath.unitToEqDb(v),
                )
                "filter" -> setFilter(d, DeckMath.unitToBipolar(v))
                "crossfader" -> changeCrossfader(DeckMath.unitToBipolar(v))
                "master_volume" -> changeMaster(v)
                "headphone_mix" -> changeCueMix(v)
                "headphone_level" -> changeHeadphoneLevel(v)
                "headphone_cue" -> if (pressed) togglePfl(d)
                else -> return false
            }
            "library" -> when (a.kind) {
                "scroll", "scroll_fast" -> moveSelection(((a.delta ?: 0f) * if (a.kind == "scroll_fast") 10 else 1).toInt())
                "load" -> if (pressed) loadSelected(d)
                else -> return false
            }
            else -> return false
        }
        return true
    }
}
