package ro.mixai.decks.ui.i18n

import androidx.compose.runtime.Composable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf

/**
 * Every user-visible string of the Decks UI. Keys are snake_case; on Android each key maps to the
 * string resource `decks_<key>` in `res/values` + `res/values-ro` (the Android source of truth),
 * on Desktop to [DesktopStrings] (en + ro). Tests assert that both platforms define every key.
 * Templates use `%1`, `%2` placeholders (no locale-dependent formatting).
 */
enum class Str(val key: String) {
    AppName("app_name"),
    DeckA("deck_a"),
    DeckB("deck_b"),
    Play("play"),
    Pause("pause"),
    Cue("cue"),
    HotCue("hot_cue"),
    HotCueEmpty("hot_cue_empty"),
    HotCueDelete("hot_cue_delete"),
    Loop("loop"),
    LoopExit("loop_exit"),
    LoopHalve("loop_halve"),
    LoopDouble("loop_double"),
    BeatJumpBack("beat_jump_back"),
    BeatJumpForward("beat_jump_forward"),
    Tempo("tempo"),
    TempoRange("tempo_range"),
    TempoReset("tempo_reset"),
    KeyLock("key_lock"),
    KeyShiftUp("key_shift_up"),
    KeyShiftDown("key_shift_down"),
    KeyMatch("key_match"),
    Key("key"),
    Sync("sync"),
    SyncLock("sync_lock"),
    Quantize("quantize"),
    Slip("slip"),
    Master("master"),
    MasterClock("master_clock"),
    InternalClock("internal_clock"),
    Gain("gain"),
    EqHigh("eq_high"),
    EqMid("eq_mid"),
    EqLow("eq_low"),
    Filter("filter"),
    Volume("volume"),
    Crossfader("crossfader"),
    HeadphoneCue("headphone_cue"),
    HeadphoneMix("headphone_mix"),
    HeadphoneLevel("headphone_level"),
    MasterVolume("master_volume"),
    Library("library"),
    Search("search"),
    AllTracks("all_tracks"),
    Crates("crates"),
    ScanFolder("scan_folder"),
    Scanning("scanning"),
    ScanDone("scan_done"),
    LoadToA("load_to_a"),
    LoadToB("load_to_b"),
    NoTracks("no_tracks"),
    NoTrack("no_track"),
    Loading("loading"),
    LoadFailed("load_failed"),
    Waveform("waveform"),
    Overview("overview"),
    PhaseMeter("phase_meter"),
    JogWheel("jog_wheel"),
    Midi("midi"),
    MidiNone("midi_none"),
    MidiConnected("midi_connected"),
    DemoEngine("demo_engine"),
    EngineError("engine_error"),
    Bpm("bpm"),
    Elapsed("elapsed"),
    Remaining("remaining"),
    On("on"),
    Off("off"),
    Mixer("mixer"),
    Shortcuts("shortcuts"),
}

typealias StringTable = Map<String, String>

val LocalStrings = staticCompositionLocalOf<StringTable> { emptyMap() }

/** Looks up [s]; falls back to the key so a missing string is visible, never a crash. */
@Composable
@ReadOnlyComposable
fun str(s: Str): String = LocalStrings.current[s.key] ?: s.key

@Composable
@ReadOnlyComposable
fun str(s: Str, vararg args: Any): String = fill(str(s), *args)

fun fill(template: String, vararg args: Any): String {
    var out = template
    args.forEachIndexed { i, a -> out = out.replace("%${i + 1}", a.toString()) }
    return out
}
