package ro.mixai.decks.ui.i18n

import androidx.compose.runtime.Composable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import ro.mixai.decks.ui.logic.Format
import ro.mixai.decks.ui.logic.Plural

/**
 * Every user-visible string of the Decks UI. Keys are snake_case; on Android each key maps to the
 * string resource `decks_<key>` in `res/values` + `res/values-ro` (the Android source of truth),
 * on Desktop to [DesktopStrings] (en + ro). Tests assert that both platforms define every key.
 * Templates use `%1`, `%2` placeholders (no locale-dependent formatting).
 *
 * A sentence with a count has one key per plural form, `<key>_one` / `_few` / `_other` ([Counted], [strCount],
 * [strBeats]): English uses one / other, Romanian one ("1 piesă"), few ("2 piese") and other ("20 de piese").
 * `plural_rule` is not shown: it names the language whose rule the table's forms follow ("en" / "ro"), so a
 * table and its rule always travel together (Android: `values` / `values-ro`).
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
    Skin("skin"),
    SkinNext("skin_next"),
    SkinSignature("skin_signature"),
    SkinGlassClassic("skin_glass_classic"),
    SkinMainroom("skin_mainroom"),
    SkinCrate("skin_crate"),
    SkinPilot("skin_pilot"),
    SkinClub("skin_club"),
    SkinBooth("skin_booth"),
    SkinStudio("skin_studio"),
    SkinEmerald("skin_emerald"),
    LoadQueued("load_queued"),
    LoadDecoding("load_decoding"),
    LoadAnalysing("load_analysing"),
    SetTitle("set_title"),
    SetRecord("set_record"),
    SetStop("set_stop"),
    SetRecordFailed("set_record_failed"),
    SetEmpty("set_empty"),
    SetRemove("set_remove"),
    SetExport("set_export"),
    SetExportText("set_export_text"),
    SetDefaultName("set_default_name"),
    AiTitle("ai_title"),
    AiSuggest("ai_suggest"),
    AiMix("ai_mix"),
    AiMixing("ai_mixing"),
    AiCancel("ai_cancel"),
    AiLoad("ai_load"),
    AiWarning("ai_warning"),
    AiCommandHint("ai_command_hint"),
    AiRun("ai_run"),
    Connect("connect"),
    ConnectToggle("connect_toggle"),
    ConnectHint("connect_hint"),
    ConnectUnavailable("connect_unavailable"),
    ConnectClients("connect_clients"),
    ConnectRemote("connect_remote"),
    ConnectScreen("connect_screen"),
    ConnectParty("connect_party"),
    ConnectNewCode("connect_new_code"),
    ConnectLock("connect_lock"),
    ConnectLockHint("connect_lock_hint"),
    Requests("requests"),
    RequestsOpen("requests_open"),
    RequestsClosed("requests_closed"),
    RequestsToggle("requests_toggle"),
    RequestsClear("requests_clear"),
    RequestsNone("requests_none"),
    RequestVotes("request_votes"),
    RequestAccept("request_accept"),
    RequestPlayed("request_played"),
    RequestReject("request_reject"),
    RequestPending("request_pending"),
    RequestAccepted("request_accepted"),
    RequestRejected("request_rejected"),
    RequestPlayedState("request_played_state"),
    SafetyTitle("safety_title"),
    SafetyProtect("safety_protect"),
    SafetyProtectHint("safety_protect_hint"),
    SafetyProtected("safety_protected"),
    SafetySnapshotNow("safety_snapshot_now"),
    SafetySnapshots("safety_snapshots"),
    SafetyNone("safety_none"),
    SafetyCounts("safety_counts"),
    SafetyRestore("safety_restore"),
    SafetyRestoreConfirm("safety_restore_confirm"),
    SafetyRestoreYes("safety_restore_yes"),
    SafetyCancel("safety_cancel"),
    SafetyRestored("safety_restored"),
    SafetyFailed("safety_failed"),
    SafetyUnavailable("safety_unavailable"),
    SafetyReasonAuto("safety_reason_auto"),
    SafetyReasonManual("safety_reason_manual"),
    SafetyReasonImport("safety_reason_import"),
    SafetyReasonSchema("safety_reason_schema"),
    SafetyReasonPreRestore("safety_reason_pre_restore"),
    DeckC("deck_c"),
    DeckD("deck_d"),
    PanelClock("panel_clock"),
    PanelAutomix("panel_automix"),
    PanelSampler("panel_sampler"),
    PanelPlugins("panel_plugins"),
    PanelWaves("panel_waves"),
    PanelUnavailable("panel_unavailable"),
    DockTab("dock_tab"),
    Layout("layout"),
    LayoutNext("layout_next"),
    LayoutPro("layout_pro"),
    LayoutProVertical("layout_pro_vertical"),
    LayoutClassic("layout_classic"),
    LayoutPerformance("layout_performance"),
    LayoutLibrary("layout_library"),
    LayoutFourDeck("layout_four_deck"),
    LayoutUltrawide("layout_ultrawide"),
    LayoutStage("layout_stage"),
    PackImport("pack_import"),
    PackInstalled("pack_installed"),
    PackRejected("pack_rejected"),
    ImportTitle("import_title"),
    ImportSourceLabel("import_source"),
    ImportAuto("import_auto"),
    ImportPick("import_pick"),
    ImportUnsupported("import_unsupported"),
    ImportNotRecognised("import_not_recognised"),
    ImportProtected("import_protected"),
    ImportFailed("import_failed"),
    ImportPreviewTitle("import_preview_title"),
    ImportTracks("import_tracks"),
    ImportExtras("import_extras"),
    ImportMissing("import_missing"),
    ImportWarnings("import_warnings"),
    ImportConflict("import_conflict"),
    ImportKeep("import_keep"),
    ImportPrefer("import_prefer"),
    ImportMerge("import_merge"),
    ImportDrift("import_drift"),
    ImportRelocate("import_relocate"),
    ImportRemoveFolder("import_remove_folder"),
    ImportRun("import_run"),
    ImportRunning("import_running"),
    ImportClose("import_close"),
    ImportDone("import_done"),
    ImportReportRelocated("import_report_relocated"),
    ImportReportMissing("import_report_missing"),
    GridTitle("grid_title"),
    GridFixed("grid_fixed"),
    GridFixedHint("grid_fixed_hint"),
    GridFlexHint("grid_flex_hint"),
    GridMarkers("grid_markers"),
    GridMarkerEmpty("grid_marker_empty"),
    GridMarkerAdd("grid_marker_add"),
    GridMarkerItem("grid_marker_item"),
    GridMarkerRemove("grid_marker_remove"),
    GridMarkerEarlier("grid_marker_earlier"),
    GridMarkerLater("grid_marker_later"),
    GridTempoUp("grid_tempo_up"),
    GridTempoDown("grid_tempo_down"),
    GridBpmAt("grid_bpm_at"),
    GridClose("grid_close"),
    TabCues("tab_cues"),
    TabLoops("tab_loops"),
    MoreControls("more_controls"),
    KeyShort("key_short"),
    KeyLockShort("key_lock_short"),
    MatchShort("match_short"),
    NudgeBack("nudge_back"),
    NudgeForward("nudge_forward"),
    TempoDown("tempo_down"),
    TempoUp("tempo_up"),
    JumpSizeOne("jump_size_one"),
    JumpSizeFew("jump_size_few"),
    JumpSizeOther("jump_size_other"),
    Ending("ending"),
    LegendTrim("legend_trim"),
    LegendHi("legend_hi"),
    LegendMid("legend_mid"),
    LegendLow("legend_low"),
    LegendFilter("legend_filter"),
    LegendMix("legend_mix"),
    LegendPhones("legend_phones"),
    ColTitle("col_title"),
    ColArtist("col_artist"),
    ColTime("col_time"),
    CratePrev("crate_prev"),
    CrateNext("crate_next"),
    TrackPlayed("track_played"),
    TrackOnDeck("track_on_deck"),
    TrackCountOne("track_count_one"),
    TrackCountFew("track_count_few"),
    TrackCountOther("track_count_other"),
    LoopIn("loop_in"),
    LoopOut("loop_out"),
    LoopInShort("loop_in_short"),
    LoopOutShort("loop_out_short"),
    LoopExitShort("loop_exit_short"),
    SearchShort("search_short"),
    PluralRule("plural_rule"),
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

/** The three plural forms of one sentence with a count. */
enum class Counted(val one: Str, val few: Str, val other: Str) {
    JumpSize(Str.JumpSizeOne, Str.JumpSizeFew, Str.JumpSizeOther),
    TrackCount(Str.TrackCountOne, Str.TrackCountFew, Str.TrackCountOther);

    fun form(p: Plural): Str = when (p) {
        Plural.One -> one
        Plural.Few -> few
        Plural.Other -> other
    }
}

/** The language whose plural rule [table] follows (its `plural_rule` entry); English when the table does not say. */
fun pluralLang(table: StringTable): String = table[Str.PluralRule.key] ?: "en"

/** [s] for the whole count [n], in the plural form [table]'s language needs: "1 track", "5 piese", "20 de piese". */
fun counted(table: StringTable, s: Counted, n: Int): String {
    val key = s.form(Format.pluralCategory(pluralLang(table), n.toLong())).key
    return fill(table[key] ?: key, n)
}

/** [s] for a beat count as it is shown ([label]: "1", "4", "32"): "Jump size 1 beat", "Salt de 4 bătăi", "Salt de 32 de bătăi". */
fun countedBeats(table: StringTable, s: Counted, label: String): String {
    val key = s.form(Format.beatsPlural(pluralLang(table), label)).key
    return fill(table[key] ?: key, label)
}

@Composable
@ReadOnlyComposable
fun strCount(s: Counted, n: Int): String = counted(LocalStrings.current, s, n)

@Composable
@ReadOnlyComposable
fun strBeats(s: Counted, label: String): String = countedBeats(LocalStrings.current, s, label)
