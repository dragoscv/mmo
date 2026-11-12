package ro.mixai.decks.ui.screens

import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.roundToInt
import ro.mixai.decks.ui.engine.PanelId
import ro.mixai.decks.ui.engine.PanelTier
import ro.mixai.decks.ui.logic.Format
import ro.mixai.decks.ui.model.DeckState
import ro.mixai.decks.ui.model.PeaksData

/*
 * Pure layout arithmetic of the Decks 1.5 panels (no Compose): what a deck / mixer / library shows
 * inline in the box the layout solver gave it, and what moves behind its MORE button. The panels
 * render exactly what these functions say, so "nothing is clipped at the tier minimum" is first a
 * property of numbers (commonTest PanelFitTest) and then of the rendered panels (desktopTest
 * ContentMinimumsTest). Sizes are dp = the CSS px of apps/mixai/src/components/deck.css and mixer.css.
 */

/* ── deck readout helpers (lib/deck-time.ts) ───────────────────────────── */

/** Remaining play time (seconds, at the current tempo) at which the time readout warns. */
const val WARN_SOON_SEC = 30.0
const val WARN_NOW_SEC = 15.0

enum class RemainWarn { None, Soon, Now }

/** Real seconds until the end of the track at the current tempo (0 when unknown). */
fun remainingSec(d: DeckState): Double {
    if (!(d.durationSec > 0)) return 0.0
    val tempo = if (d.tempo > 0) d.tempo else 1.0
    return maxOf(0.0, (d.durationSec - d.playheadSec) / tempo)
}

/** Warning level of the remaining-time readout. Only a playing deck warns. */
fun remainWarn(d: DeckState): RemainWarn {
    if (!d.loaded || !d.playing || !(d.durationSec > 0)) return RemainWarn.None
    val left = remainingSec(d)
    return when {
        left <= WARN_NOW_SEC -> RemainWarn.Now
        left <= WARN_SOON_SEC -> RemainWarn.Soon
        else -> RemainWarn.None
    }
}

/** `mm:ss` plus tenths, split so the fraction can be drawn smaller. Negative / NaN = 0. */
fun splitTime(sec: Double): Pair<String, String> {
    val s = if (sec.isFinite() && sec > 0) sec else 0.0
    val tenths = floor(s * 10).toLong()
    val m = tenths / 600
    val ss = (tenths % 600) / 10
    return "${m.toString().padStart(2, '0')}:${ss.toString().padStart(2, '0')}" to (tenths % 10).toString()
}

/** Tempo ratio as a signed percent with one decimal (`+2.5%`): the deck readout form. */
fun tempoText(ratio: Double): String = Format.signed((ratio - 1.0) * 100.0, 1) + "%"

/** True when two beat counts are the same loop / jump size. */
fun sameBeats(a: Double, b: Double): Boolean = abs(a - b) < 1e-9

/**
 * The slow part of a deck's state: everything the deck panel composes from, WITHOUT the values that move every
 * frame (playhead, elapsed, beat, level). The panel derives one of these from the 60 Hz snapshot and recomposes
 * only when it changes (structural equality); the playhead is read by the few leaves that draw it. Tempo and BPM
 * are kept as the texts the panel shows, so an engine that trims the tempo by a hair every frame (sync lock) does
 * not recompose the deck either.
 */
data class DeckView(
    val loaded: Boolean,
    val loading: Boolean,
    val title: String?,
    val durationSec: Double,
    val playing: Boolean,
    /** The track's own tempo (the phrase band is computed from it). */
    val bpm: Double?,
    /** Playing tempo with two decimals, or an em dash ([Format.bpm]). */
    val bpmText: String,
    /** Tempo deviation as the deck shows it ([tempoText]); [tempoShifted] = it is not 0. */
    val tempoText: String,
    val tempoShifted: Boolean,
    val keyLock: Boolean,
    /** Playing key (with the key shift), else the track's key. */
    val key: String?,
    val loopActive: Boolean,
    val loopStartSec: Double,
    val loopEndSec: Double,
    val slip: Boolean,
    val quantize: Boolean,
    val syncLock: Boolean,
    val hotCues: List<Double?>,
    /** The deck rests on its cue point (within 20 ms): CUE lights. */
    val atCue: Boolean,
    val warn: RemainWarn,
    /** This deck drives the master clock. */
    val master: Boolean,
)

/** [DeckView] of [d]; [masterDeck] = `clock.sourceDeck`. Equal for two snapshots that differ only in the moving values. */
fun deckView(d: DeckState, masterDeck: Int?): DeckView = DeckView(
    loaded = d.loaded, loading = d.loading, title = d.title, durationSec = d.durationSec, playing = d.playing, bpm = d.bpm,
    bpmText = Format.bpm(d.effectiveBpm ?: d.bpm), tempoText = tempoText(d.tempo), tempoShifted = abs(d.tempo - 1.0) >= 0.0005,
    keyLock = d.keyLock, key = d.effectiveKey ?: d.key,
    loopActive = d.loopActive, loopStartSec = d.loopStartSec, loopEndSec = d.loopEndSec,
    slip = d.slip, quantize = d.quantize, syncLock = d.syncLock, hotCues = d.hotCues,
    atCue = d.loaded && !d.playing && abs(d.playheadSec - d.cuePointSec) < 0.02,
    warn = remainWarn(d),
    master = masterDeck == d.index,
)

/* ── deck ──────────────────────────────────────────────────────────────── */

/**
 * What a deck draws in its box. Rows top to bottom: header ([headerH]), [readoutRow] (22), the
 * overview ([waveH]; 0 = a 3 dp progress line at the bottom instead), [phase] (6: the phase meter
 * against the master clock), transport ([tpH]), [util]
 * (24: beat jump, key, tempo), [tabs] (24) over the tab body, or [padRows] rows of hot cue pads
 * (flexible, at least 24 each), [loopRow] (24). [gap] between rows, [pad] around.
 */
data class DeckFit(
    val pad: Int,
    val gap: Int,
    /** Two-row header (title row [row1] + readout row [row2]); else one 24 dp line. */
    val twoRowHeader: Boolean,
    val row1: Int,
    val row2: Int,
    val readoutRow: Boolean,
    val waveH: Int,
    val phase: Boolean,
    val tpH: Int,
    val cueW: Int,
    /** Fixed PLAY width; 0 = PLAY takes the room that is left in the row. */
    val playW: Int,
    /** PLAY shows its word next to the icon (it has at least [PLAY_WORD_MIN_W] dp). */
    val playWord: Boolean,
    val sync: Boolean,
    /** Sync lock, Q, SLIP, KEY lock and the two nudge cells in the transport row. */
    val toggles: Boolean,
    /** Key shift / match in the transport row (wide decks) instead of the util row. */
    val keysInTransport: Boolean,
    /** Tempo −, value, + in the transport row (decks without the util row). */
    val stepper: Boolean,
    val util: Boolean,
    /** Captions in the readout row and the label of the tempo fader. */
    val captions: Boolean,
    /** Artist after the title. */
    val artist: Boolean,
    val tabs: Boolean,
    val padRows: Int,
    val loopRow: Boolean,
    val more: Boolean,
    /** MORE sits in the header (icon tier) instead of the transport row. */
    val moreInHeader: Boolean,
    /**
     * One-line header without a readout row (a box forced under the icon minimum): the remaining time is always
     * there (a DJ needs time-to-end first); the BPM joins it only when a 40 dp title still fits beside both.
     */
    val headerBpm: Boolean = true,
) {
    val headerH: Int get() = if (twoRowHeader) row1 + 2 + row2 else LINE

    /** The key chip is in the header (two-row header, compact one-line header); false = it is in the MORE sheet. */
    val keyChip: Boolean get() = twoRowHeader || (!readoutRow && !moreInHeader)

    /** Neither pads nor tabs: no row flexes, so the transport row takes the few dp a lagging arrangement leaves ([FitLag]). */
    val transportFlex: Boolean get() = !tabs && padRows == 0

    /** Smallest height (dp) of the pads / tab body: two rows of 24 with a 4 dp gap under tabs. */
    val bodyMin: Int get() = if (tabs) 2 * PAD_MIN + PAD_GAP else if (padRows > 0) padRows * PAD_MIN + (padRows - 1) * PAD_GAP else 0

    /** Height (dp) the arrangement needs, padding included: every fixed row plus [bodyMin]. */
    val minHeight: Int get() {
        val rows = ArrayList<Int>()
        rows += headerH
        if (readoutRow) rows += READOUT
        if (waveH > 0) rows += waveH
        if (phase) rows += PHASE
        rows += tpH
        if (util) rows += LINE
        if (tabs) rows += LINE
        if (bodyMin > 0) rows += bodyMin
        if (loopRow) rows += LINE
        if (waveH == 0) rows += PROGRESS
        return 2 * pad + rows.sum() + gap * (rows.size - 1)
    }

    companion object {
        /** A 24 dp line: one-line header, util row, tab row, loop row. */
        const val LINE = 24
        const val READOUT = 22
        const val PROGRESS = 3
        const val PHASE = 6
        const val PAD_MIN = 24
        const val PAD_GAP = 4

        /** Width (dp) PLAY needs for its icon and word ("PAUZĂ" is the longest), and the width SYNC takes with its gap. */
        const val PLAY_WORD_MIN_W = 68
        const val SYNC_W = 48

        /** Tempo −, value, + with its gap; MORE with its gap. */
        const val STEPPER_W = 108
        const val MORE_W = 28

        /** Content width (dp) from which a compact deck has room for the toggles and the util row. */
        const val RICH_MIN_W = 440

        /** Content widths (dp) from which the full deck shows captions / moves the key cells into the transport row. */
        const val CAPTIONS_MIN_W = 524
        const val WIDE_MIN_W = 584

        /** Widths (dp) the one-line header keeps for the remaining time (with its warning icon) and for the BPM. */
        /** Widths (dp) the one-line header keeps for the remaining time ("−06:12" in 15 dp digits) and for the BPM ("126.00"). */
        const val HEADER_REMAIN_W = 52
        const val HEADER_BPM_W = 44

        /**
         * Content width (dp) from which a header line without a readout row holds the BPM beside the remaining time:
         * letter 18, title 40, BPM 44, remaining 52, MORE 24, with four gaps of 6 = 202 (the icon minimum has 208).
         */
        const val HEADER_BOTH_MIN_W = 18 + 6 + 40 + 6 + HEADER_BPM_W + 6 + HEADER_REMAIN_W + 6 + 24
    }
}

/** Largest box side (dp) the arrangements are computed for (an unbounded constraint is cut to this). */
const val MAX_BOX_DP = 8192.0

/* ── hysteresis ────────────────────────────────────────────────────────── */

/**
 * Dead band (dp) of the arrangements. Every arrangement has thresholds (a deck gets its tall rows from 296 dp, its
 * captions from 540 dp, the tier itself changes at the `PANEL_SPECS` minimums): without a dead band a window
 * dragged across one flips row heights at every pixel. A box that grows takes the richer arrangement only once it
 * is this far past the threshold; a box that shrinks drops it AT the threshold (it has to: it no longer fits).
 */
const val FIT_LAG_DP = 6.0

/**
 * A change of a box side by more than this (dp) in one step is not a drag: the window was maximised or rotated, or
 * the layout changed. The arrangement is then made for the box as given, with no lag.
 */
const val FIT_SNAP_DP = 48.0

/**
 * The side (dp) to arrange for when the box side is [now] and the last arrangement was made for [prev] (null = the
 * first one): it follows a shrinking box at once and trails a growing one by up to [band]. Never above [now], so
 * what is arranged for it always fits the real box.
 */
fun laggedSide(prev: Double?, now: Double, band: Double = FIT_LAG_DP): Double =
    if (prev == null) now else prev.coerceIn(now - maxOf(0.0, band), now)

/** What a panel arranges itself for: a tier and a box, both at most what the solver gave. */
data class LaggedBox(val tier: PanelTier, val w: Double, val h: Double)

/**
 * Hysteresis of one panel instance: remembers the box its last arrangement was made for and the box it last got.
 * Plain data (not Compose state): the panel calls [settle] once per new box.
 */
class FitLag {
    private var w: Double? = null
    private var h: Double? = null
    private var lastW = 0.0
    private var lastH = 0.0

    /**
     * The tier and box to arrange panel [id] for, given the solver's [tier] for a [w] × [h] dp box. The box is
     * [laggedSide] per side; the tier is the solver's rule applied to that box ([tierFor]) and never richer than the
     * solver's own answer. The first call, and a call after a jump of more than [FIT_SNAP_DP] on either side,
     * return the caller's tier and box unchanged. Idempotent for an unchanged box.
     */
    fun settle(id: PanelId, tier: PanelTier, w: Double, h: Double): LaggedBox {
        val jump = abs(w - lastW) > FIT_SNAP_DP || abs(h - lastH) > FIT_SNAP_DP
        lastW = w
        lastH = h
        if (this.w == null || this.h == null || jump) {
            this.w = w
            this.h = h
            return LaggedBox(tier, w, h)
        }
        val ew = laggedSide(this.w, w)
        val eh = laggedSide(this.h, h)
        this.w = ew
        this.h = eh
        val byBox = tierFor(id, ew, eh)
        return LaggedBox(if (byBox.ordinal > tier.ordinal) byBox else tier, ew, eh)
    }
}

/** The deck arrangement for a [w] × [h] dp box at [tier] (the box meets that tier's `PANEL_SPECS` minimum). */
fun deckFit(tier: PanelTier, w: Double, h: Double): DeckFit {
    val pad = if (tier == PanelTier.Full) 8 else 6
    val cw = floor(w.coerceIn(0.0, MAX_BOX_DP) - 2 * pad).toInt()
    val ch = floor(h.coerceIn(0.0, MAX_BOX_DP) - 2 * pad).toInt()
    when (tier) {
        PanelTier.Full -> {
            // Short decks (content under 280 dp, down to the 234 of the 250 minimum) take the tighter rows of deck.css:
            // header 18 + 2 + 24, overview 40, transport 28, util 24, tabs 24, 5 gaps of 3 = 175: the pads get 59 at 250.
            val short = ch < 280
            return DeckFit(
                pad = pad, gap = if (short) 3 else 4, twoRowHeader = true, row1 = if (short) 18 else 22, row2 = if (short) 24 else 28,
                readoutRow = false, waveH = if (short) 40 else if (ch >= 364) 48 else 44, phase = !short, tpH = if (short) 28 else 32,
                cueW = 56, playW = 88, playWord = true, sync = true, toggles = true, keysInTransport = cw >= DeckFit.WIDE_MIN_W, stepper = false,
                util = true, captions = cw >= DeckFit.CAPTIONS_MIN_W, artist = true, tabs = true, padRows = 2, loopRow = false,
                more = false, moreInHeader = false,
            )
        }
        PanelTier.Compact -> {
            // Wide but low (Pro on a 1366×768 window: about 553×239): everything the full tier has under a one-line header.
            // header 24 + overview 30 + transport 28 + util 24 + tabs 24 + body 52 + 5 gaps of 3 = 197.
            if (cw >= DeckFit.RICH_MIN_W && ch >= 197) {
                return DeckFit(
                    pad, 3, twoRowHeader = false, row1 = 0, row2 = 0, readoutRow = false, waveH = (30 + ch - 197).coerceAtMost(48), phase = false, tpH = 28,
                    cueW = 46, playW = 88, playWord = true, sync = true, toggles = true, keysInTransport = false, stepper = false, util = true, captions = false,
                    artist = true, tabs = true, padRows = 2, loopRow = false, more = false, moreInHeader = false,
                )
            }
            // The tabs go behind MORE: header 24 + overview 30 + transport 28 + pads + loop row 24 + 4 gaps of 3.
            // Two pad rows (52) from 170 dp of content (the 190 minimum has 178), one (24) below that.
            val padRows = if (ch >= 170) 2 else 1
            val fixed = 24 + 28 + 24 + 12 + (if (padRows == 2) 52 else 24)
            val stepper = cw >= 300
            // Room PLAY gets: the row minus CUE, SYNC, the stepper and MORE (4 dp gaps).
            val playRoom = cw - 46 - 4 - DeckFit.SYNC_W - (if (stepper) DeckFit.STEPPER_W else 0) - DeckFit.MORE_W
            return DeckFit(
                pad, 3, twoRowHeader = false, row1 = 0, row2 = 0, readoutRow = false, waveH = (ch - fixed).coerceIn(24, 44), phase = false, tpH = 28,
                cueW = 46, playW = 0, playWord = playRoom >= DeckFit.PLAY_WORD_MIN_W, sync = true, toggles = false, keysInTransport = false, stepper = stepper, util = false, captions = false,
                artist = false, tabs = false, padRows = padRows, loopRow = true, more = true, moreInHeader = false,
            )
        }
        PanelTier.Icon -> {
            // header 24 + readouts 22 + transport 28 with two gaps of 3 = 80; what is left decides the rest.
            var rem = ch - 80
            if (rem < 27) {
                // Minimum (220×110, content 98): CUE and PLAY take the height, a 3 dp progress line closes the panel.
                // A box the solver forced under the icon minimum (an essential panel never docks) gives up the readout
                // row first: the remaining time then sits in the header line, and the BPM beside it when there is room.
                val readouts = ch >= 86
                return DeckFit(
                    pad, 3, twoRowHeader = false, row1 = 0, row2 = 0, readoutRow = readouts, waveH = 0, phase = false,
                    tpH = (ch - (if (readouts) 58 else 33)).coerceIn(28, 44),
                    cueW = 64, playW = 0, playWord = cw - 64 - 4 >= DeckFit.PLAY_WORD_MIN_W, sync = false, toggles = false, keysInTransport = false, stepper = false,
                    util = false, captions = false, artist = cw >= 300, tabs = false, padRows = 0, loopRow = false, more = true, moreInHeader = true,
                    headerBpm = readouts || cw >= DeckFit.HEADER_BOTH_MIN_W,
                )
            }
            rem -= 27 // the overview (24) and its gap
            val padRows = if (rem >= 63) 2 else if (rem >= 31) 1 else 0
            rem -= when (padRows) { 2 -> 63; 1 -> 31; else -> 0 }
            val loopRow = padRows > 0 && rem >= 27
            if (loopRow) rem -= 27
            val wave = 24 + rem.coerceIn(0, 24)
            rem -= wave - 24
            val tp = 28 + rem.coerceIn(0, 16)
            val cueW = if (padRows > 0) 56 else 64
            // SYNC joins CUE and PLAY when the pads are there and PLAY still keeps a 32 dp target.
            val sync = padRows > 0 && cw - cueW - 4 - DeckFit.SYNC_W >= 32
            val playRoom = cw - cueW - 4 - (if (sync) DeckFit.SYNC_W else 0)
            return DeckFit(
                pad, 3, twoRowHeader = false, row1 = 0, row2 = 0, readoutRow = true, waveH = wave, phase = false, tpH = tp,
                cueW = cueW, playW = 0, playWord = playRoom >= DeckFit.PLAY_WORD_MIN_W, sync = sync, toggles = false, keysInTransport = false, stepper = false,
                util = false, captions = false, artist = cw >= 300, tabs = false, padRows = padRows, loopRow = loopRow, more = true, moreInHeader = true,
            )
        }
    }
}

/* ── mixer ─────────────────────────────────────────────────────────────── */

/**
 * What the mixer draws: channel | master column | channel. With [strip] a channel is, top to
 * bottom, a 12 dp head (the deck letter), the body (a knob column beside the fader and its level
 * meter) and the 24 dp CUE (headphone cue) button; without it, the fader and the meter alone.
 * The master column: label + level knob ([masterKnob]), the master meter, the two headphone knobs
 * ([sends]). What is not inline is behind [more].
 */
data class MixerFit(
    val pad: Int,
    val masterW: Int,
    val channelW: Int,
    val strip: Boolean,
    /** Knobs beside the fader: 5 (trim, hi, mid, low, filter), 3 (the EQ) or 0. */
    val knobs: Int,
    val faderW: Int,
    /** Width of the channel level meter; 0 = no room for one. */
    val vuW: Int,
    val vuGap: Int,
    val masterKnob: Boolean,
    val sends: Boolean,
    val more: Boolean,
) {
    /** Height (dp) the arrangement needs, padding included ([withCrossfader] = the 24 dp crossfader row under it). */
    fun minHeight(withCrossfader: Boolean = false): Int {
        val body = if (knobs > 0) knobs * KNOB_ROW + (knobs - 1) * KNOB_GAP else FADER_MIN
        val channel = if (strip) HEAD + ROW_GAP + body + ROW_GAP + FOOT else body
        val master = (if (masterKnob) HEAD + ROW_GAP + KNOB + ROW_GAP else 0) + METER_MIN +
            (if (sends) 2 * (ROW_GAP + KNOB_ROW) else 0) + (if (more) ROW_GAP + FOOT else 0)
        return 2 * pad + maxOf(channel, master) + (if (withCrossfader) ROW_GAP + FOOT else 0)
    }

    /** Width (dp) the arrangement needs, padding included. */
    val minWidth: Int get() {
        val channel = (if (knobs > 0) KNOB_COL + ROW_GAP else 0) + faderW + (if (vuW > 0) vuW + vuGap else 0)
        return 2 * pad + masterW + 2 * (COL_GAP + channel)
    }

    companion object {
        const val KNOB = 24

        /** A knob (24) with its legend (10). */
        const val KNOB_ROW = 34
        const val KNOB_GAP = 2
        const val KNOB_COL = 34
        const val COL_GAP = 3
        const val ROW_GAP = 3
        const val HEAD = 12
        const val FOOT = 24
        const val FADER_MIN = 36
        const val METER_MIN = 36

        /** Channel height (dp) from which the fader gets a head and a CUE button. */
        const val STRIP_MIN_H = 150

        /** Channel width (dp) from which a knob column fits beside the fader: knobs 34 + 3 + fader 24 + 2 + meter 4. */
        const val KNOBS_MIN_W = 67
    }
}

/** The mixer arrangement for a [w] × [h] dp box at [tier]; [withCrossfader] = a 24 dp crossfader row at the bottom. */
fun mixerFit(tier: PanelTier, w: Double, h: Double, withCrossfader: Boolean = false): MixerFit {
    val pad = if (tier == PanelTier.Icon) 4 else 6
    // 48 dp holds the legends under the master column's knobs ("MASTER", "PHONES"); the icon tier has the meter only.
    val masterW = if (tier == PanelTier.Icon) 24 else 48
    val innerH = floor(h.coerceIn(0.0, MAX_BOX_DP) - 2 * pad).toInt() - (if (withCrossfader) MixerFit.FOOT + MixerFit.ROW_GAP else 0)
    val channelW = floor((w.coerceIn(0.0, MAX_BOX_DP) - 2 * pad - masterW - 2 * MixerFit.COL_GAP) / 2).toInt()
    val strip = innerH >= MixerFit.STRIP_MIN_H
    val bodyH = innerH - (if (strip) MixerFit.HEAD + MixerFit.FOOT + 2 * MixerFit.ROW_GAP else 0)
    val knobs = when {
        !strip || channelW < MixerFit.KNOBS_MIN_W -> 0
        bodyH >= 5 * MixerFit.KNOB_ROW + 4 * MixerFit.KNOB_GAP -> 5
        bodyH >= 3 * MixerFit.KNOB_ROW + 2 * MixerFit.KNOB_GAP -> 3
        else -> 0
    }
    val room = channelW - (if (knobs > 0) MixerFit.KNOB_COL + MixerFit.ROW_GAP else 0)
    val vuW = if (room >= 24 + 3 + 8) 8 else if (room >= 24 + 2 + 4) 4 else 0
    val vuGap = if (vuW == 8) 3 else 2
    val faderW = (room - (if (vuW > 0) vuW + vuGap else 0)).coerceIn(24, 32)
    // Master column, top to bottom: label 12 + knob 24, meter (36 or more), two send knobs of 34, MORE 24; gaps of 3.
    val knobBlock = MixerFit.HEAD + MixerFit.KNOB + 2 * MixerFit.ROW_GAP
    val moreBlock = MixerFit.ROW_GAP + MixerFit.FOOT
    val masterKnob = tier != PanelTier.Icon && innerH >= knobBlock + MixerFit.METER_MIN + moreBlock
    val channelsWhole = strip && knobs == 5
    val sends = masterKnob && innerH >= knobBlock + MixerFit.METER_MIN + 2 * (MixerFit.ROW_GAP + MixerFit.KNOB_ROW) + (if (channelsWhole) 0 else moreBlock)
    return MixerFit(pad, masterW, channelW, strip, knobs, faderW, vuW, vuGap, masterKnob, sends, more = !channelsWhole || !sends)
}

/* ── library ───────────────────────────────────────────────────────────── */

/** Heights (dp) of a library row (pointer / touch input), and of the column header (with its hairline). */
const val LIB_ROW_DP = 22
const val LIB_ROW_TOUCH_DP = 48
const val LIB_HEAD_DP = 20

/** Library row height (dp) for the input in use: 48 dp targets on touch, the dense 22 dp rows with a pointer. */
fun libRowDp(touch: Boolean): Int = if (touch) LIB_ROW_TOUCH_DP else LIB_ROW_DP

/** Height (dp) of the library toolbar (with its hairline). */
fun libToolbarDp(tier: PanelTier): Int = if (tier == PanelTier.Icon) 26 else 28

/**
 * Whole rows of [rowDp] that fit a library panel [h] dp high at [tier] (the icon tier has no column header). The ONE
 * row count of the library: `LibraryPanel` calls it for its list and its crate column; neither measures rows itself
 * (desktopTest LibraryAccessTest counts the rendered rows against this function). [h] is cut to [MAX_BOX_DP].
 */
fun libraryRows(tier: PanelTier, h: Double, rowDp: Int = LIB_ROW_DP): Int =
    floor((h.coerceIn(0.0, MAX_BOX_DP) - libToolbarDp(tier) - (if (tier == PanelTier.Icon) 0 else LIB_HEAD_DP)) / rowDp).toInt().coerceAtLeast(0)

/**
 * First row of the visible window ([visible] rows of [total], now starting at [first]) after the
 * selection moved to [selected]: the window moves by the smallest amount that shows the selected
 * row, and never past the ends of the list.
 */
fun windowFor(first: Int, visible: Int, total: Int, selected: Int): Int {
    if (visible <= 0 || total <= 0) return 0
    val f = when {
        selected < first -> selected
        selected >= first + visible -> selected - visible + 1
        else -> first
    }
    return f.coerceIn(0, maxOf(0, total - visible))
}

/**
 * "Played": a track counts once it was on air (its deck playing) for [thresholdSec] in total
 * (30 s, as `history-store.ts`). [sample] takes the track ids of the playing decks; [onPlayed]
 * gets each id once.
 */
class PlayedLog(private val thresholdSec: Double = 30.0, private val onPlayed: (String) -> Unit) {
    private val heard = HashMap<String, Double>()
    private val done = HashSet<String>()

    fun sample(dtSec: Double, onAir: List<String?>) {
        if (!(dtSec > 0)) return
        for (id in onAir.filterNotNull().distinct()) {
            if (id in done) continue
            val t = (heard[id] ?: 0.0) + dtSec
            if (t >= thresholdSec) {
                heard.remove(id)
                done += id
                onPlayed(id)
            } else {
                heard[id] = t
            }
        }
    }
}

/* ── phrase band (lib/phrases.ts) ──────────────────────────────────────── */

enum class PhraseKind { Intro, Break, Build, Main, Outro }

data class Phrase(val kind: PhraseKind, val fromSec: Double, val toSec: Double)

/**
 * Phrase band of the overview: a coarse map of a track's structure, the port of `detectPhrases`
 * (apps/mixai/src/lib/phrases.ts) for a constant grid. Blocks of `barsPerBlock` bars; each block's
 * mean level and mean bass level are scaled by the track's own loud level (90th percentile of the
 * blocks), then: main = loud and bass-heavy, break = bass (nearly) gone, build = in between and
 * rising into a main block, intro / outro = the quiet run at the very start / end. Neighbouring
 * blocks with the same label merge. Empty without a tempo, without peaks, or under two blocks.
 */
object Phrases {
    /** Bass share (of the track's loud bass level) under which a block has "no bass". */
    const val BASS_GONE = 0.35

    /** Level share (of the track's loud level) from which a block is "loud". */
    const val LOUD = 0.72

    private fun mean(lane: ByteArray, from: Double, to: Double): Double {
        val a = maxOf(0, floor(from).toInt())
        val b = minOf(lane.size, ceil(to).toInt())
        if (b <= a) return 0.0
        var s = 0L
        for (i in a until b) s += lane[i].toInt() and 0xFF
        return s.toDouble() / (b - a)
    }

    private fun percentile(values: List<Double>, p: Double): Double {
        if (values.isEmpty()) return 0.0
        val sorted = values.sorted()
        return sorted[(p * (sorted.size - 1)).roundToInt().coerceIn(0, sorted.size - 1)]
    }

    fun detect(wave: PeaksData?, bpm: Double?, firstBeatSec: Double, durationSec: Double, beatsPerBar: Int = 4, barsPerBlock: Int = 8): List<Phrase> {
        if (wave == null || bpm == null || !(bpm > 0) || !(durationSec > 0) || wave.pointsPerSecond <= 0 || wave.size == 0) return emptyList()
        val blockBeats = maxOf(1, beatsPerBar) * maxOf(1, barsPerBlock)
        // Block edges on the grid, starting at the first beat; audio before it joins the first block.
        val edges = ArrayList<Double>()
        edges += 0.0
        for (n in 1 until 4000) {
            val t = firstBeatSec + n * blockBeats * 60.0 / bpm
            if (!t.isFinite() || t >= durationSec) break
            if (t > edges.last() + 0.5) edges += t
        }
        edges += durationSec
        val count = edges.size - 1
        if (count < 2) return emptyList()

        val level = ArrayList<Double>(count)
        val bass = ArrayList<Double>(count)
        for (i in 0 until count) {
            val from = edges[i] * wave.pointsPerSecond
            val to = edges[i + 1] * wave.pointsPerSecond
            val lo = mean(wave.low, from, to)
            bass += lo
            level += (lo + mean(wave.mid, from, to) + mean(wave.high, from, to)) / 3
        }
        val loudLevel = percentile(level, 0.9)
        val loudBass = percentile(bass, 0.9)
        if (!(loudLevel > 0)) return emptyList()

        val rel = level.map { it / loudLevel }
        val relBass = bass.map { if (loudBass > 0) it / loudBass else 0.0 }
        val kinds = Array(count) { i -> if (relBass[i] < BASS_GONE) PhraseKind.Break else if (rel[i] >= LOUD) PhraseKind.Main else PhraseKind.Build }
        // "build" only when it actually leads into a main block; otherwise it is a calmer main part.
        for (i in 0 until count) {
            if (kinds[i] != PhraseKind.Build) continue
            val next = kinds.getOrNull(i + 1)
            val rising = i + 1 < count && rel[i + 1] > rel[i]
            if (!(next == PhraseKind.Main && rising) && next != PhraseKind.Build) kinds[i] = if (rel[i] >= LOUD * 0.8) PhraseKind.Main else PhraseKind.Break
        }
        for (i in count - 2 downTo 0) {
            if (kinds[i] == PhraseKind.Build && kinds[i + 1] != PhraseKind.Build && kinds[i + 1] != PhraseKind.Main) kinds[i] = PhraseKind.Break
        }
        // The quiet run at the start is the intro, at the end the outro (never the whole track).
        var a = 0
        while (a < count - 1 && kinds[a] == PhraseKind.Break) {
            kinds[a] = PhraseKind.Intro
            a++
        }
        var b = count - 1
        while (b > 0 && kinds[b] == PhraseKind.Break) {
            kinds[b] = PhraseKind.Outro
            b--
        }

        val out = ArrayList<Phrase>()
        for (i in 0 until count) {
            val last = out.lastOrNull()
            if (last != null && last.kind == kinds[i]) out[out.size - 1] = last.copy(toSec = edges[i + 1])
            else out += Phrase(kinds[i], edges[i], edges[i + 1])
        }
        return out
    }
}
