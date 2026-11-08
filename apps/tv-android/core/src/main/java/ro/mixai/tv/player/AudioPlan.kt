package ro.mixai.tv.player

import ro.mixai.tv.data.generated.TrackCard
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.pow
import kotlin.math.sin

/** Playback audio preferences an app pushes into [MusicService.audioPrefs] (WP17-41e). Defaults = off. */
data class AudioPrefs(
    /** Crossfade length between tracks in ms (0 = plain gapless transitions). */
    val crossfadeMs: Int = 0,
    /** Loudness normalisation from the server's EBU R128 measurement (TrackCard.loudnessLufs / truePeakDbfs). */
    val normalize: Boolean = false,
    /** Automix (WP17-44): beat-aligned crossfades with tempo match up to ±6 % when both tracks have BPM data. */
    val automix: Boolean = false,
)

/** How one crossfade runs (automix): incoming start offset, tempo of both decks during the overlap, fade length. */
data class MixPlan(
    /** Seek the incoming track here before fading in (its first downbeat), ms. 0 = from the start. */
    val incomingStartMs: Long,
    /** Playback speed of the INCOMING track during the overlap (1 = native; glides back to 1 after the handoff). */
    val incomingRate: Float,
    /** Fade length snapped to whole bars of the outgoing track, ms. */
    val fadeMs: Long,
    val beatMatched: Boolean,
)

/** Pure decisions behind normalisation and crossfade, kept free of Android types for unit tests. */
object AudioPlan {
    const val TARGET_LUFS = -14.0
    /** Gain never pushes the measured true peak above this (dBTP), so a boost cannot clip. */
    const val CEILING_DBTP = -1.0
    const val MAX_BOOST_DB = 12.0
    const val MAX_CUT_DB = -24.0
    private const val MIN_FADE_MS = 1000L

    /**
     * Playback gain in dB for a track measured at [lufs] with [truePeak]: towards [target], boosts
     * capped by the true-peak ceiling; unknown peak → attenuate only; not analysed → 0.
     */
    fun gainDb(lufs: Double?, truePeak: Double?, target: Double = TARGET_LUFS): Double {
        if (lufs == null || !lufs.isFinite()) return 0.0
        val wanted = target - lufs
        val capped = if (truePeak != null && truePeak.isFinite()) minOf(wanted, CEILING_DBTP - truePeak) else minOf(wanted, 0.0)
        return capped.coerceIn(MAX_CUT_DB, MAX_BOOST_DB)
    }

    fun linear(db: Double): Float = 10.0.pow(db / 20.0).toFloat()

    /** Linear gain for a card, 1 when normalisation is off or the track is not analysed. */
    fun gainFor(card: TrackCard?, normalize: Boolean): Float =
        if (!normalize || card == null) 1f else linear(gainDb(card.loudnessLufs, card.truePeakDbfs))

    /** Next track continues the same album in order (incl. disc change): keep it gapless, never crossfade. */
    fun isAlbumContinuation(cur: TrackCard?, next: TrackCard?): Boolean {
        if (cur == null || next == null) return false
        if (cur.albumId.isBlank() || cur.albumId != next.albumId) return false
        val a = cur.track ?: return false
        val b = next.track ?: return false
        val curDisc = cur.disc ?: 1L
        val nextDisc = next.disc ?: 1L
        return (curDisc == nextDisc && b == a + 1) || (nextDisc == curDisc + 1 && b == 1L)
    }

    /** Fade length for the transition cur → next; 0 = plain gapless. Never more than a third of either track. */
    fun fadeMs(prefMs: Int, curDurMs: Long, nextDurMs: Long?, cur: TrackCard?, next: TrackCard?): Long {
        if (prefMs <= 0 || curDurMs <= 0 || isAlbumContinuation(cur, next)) return 0
        var f = minOf(prefMs.toLong(), curDurMs / 3)
        if (nextDurMs != null && nextDurMs > 0) f = minOf(f, nextDurMs / 3)
        return if (f < MIN_FADE_MS) 0 else f
    }

    /** Equal-power curves (constant perceived loudness through the overlap). */
    fun fadeOut(t: Float): Float = cos(t.coerceIn(0f, 1f) * PI / 2).toFloat()
    fun fadeIn(t: Float): Float = sin(t.coerceIn(0f, 1f) * PI / 2).toFloat()

    // ─── Automix (WP17-44) ─────────────────────────────────────────────────

    const val MAX_RATE_PCT = 6.0
    const val MIN_BPM_CONFIDENCE = 0.5
    /** Never skip more than this into the incoming track to reach its first downbeat. */
    const val MAX_LEAD_IN_MS = 8_000L

    private fun usableBpm(t: TrackCard?): Double? {
        val b = t?.bpm ?: return null
        if (!b.isFinite() || b < 40 || b > 260) return null
        val c = t.bpmConfidence
        return if (c != null && c < MIN_BPM_CONFIDENCE) null else b
    }

    /**
     * Speed for the incoming track so its tempo matches the outgoing one (half/double tempo folded), or null when
     * either BPM is unknown / unreliable or the change would exceed ±[MAX_RATE_PCT] %.
     */
    fun rateFor(cur: TrackCard?, next: TrackCard?): Float? {
        val a = usableBpm(cur) ?: return null
        var b = usableBpm(next) ?: return null
        while (b < a / 1.5) b *= 2
        while (b > a * 1.5) b /= 2
        val rate = a / b
        return if (abs(rate - 1) * 100 <= MAX_RATE_PCT) rate.toFloat() else null
    }

    /**
     * Automix plan for cur → next on top of [fadeMs] (0 = no crossfade at all). Without BPM data it degrades to a
     * plain crossfade from the start of the next track; with a beat grid the incoming track enters on its first
     * downbeat and the fade is snapped to whole 4-beat bars of the outgoing tempo (at least one bar).
     */
    fun mixPlan(prefs: AudioPrefs, fadeMs: Long, cur: TrackCard?, next: TrackCard?): MixPlan {
        if (!prefs.automix || fadeMs <= 0) return MixPlan(0, 1f, fadeMs, false)
        val rate = rateFor(cur, next) ?: return MixPlan(0, 1f, fadeMs, false)
        val lead = next?.firstBeatSec?.takeIf { it.isFinite() && it >= 0 }?.let { (it * 1000).toLong() }
            ?.takeIf { it <= MAX_LEAD_IN_MS } ?: 0L
        val barMs = 4 * 60_000.0 / usableBpm(cur)!!
        val bars = floor(fadeMs / barMs)
        return MixPlan(lead, rate, if (bars >= 1) (bars * barMs).toLong() else fadeMs, true)
    }

    /**
     * Position in the outgoing track where the fade starts: `dur - fade`, moved back to the previous downbeat of
     * the outgoing track when its tempo and first downbeat are known (so the incoming downbeat lands on one).
     */
    fun fadeStartMs(curDurMs: Long, cur: TrackCard?, fadeMs: Long): Long {
        val plain = curDurMs - fadeMs
        val bpm = usableBpm(cur) ?: return plain
        val first = cur?.firstBeatSec?.takeIf { it.isFinite() && it >= 0 }?.times(1000) ?: return plain
        if (plain <= first) return plain
        val bar = 4 * 60_000.0 / bpm
        return (first + floor((plain - first) / bar) * bar).toLong()
    }

    /** Speed during the post-handoff glide back to 1 over [glideMs]: linear from [from] to 1. */
    fun glideRate(from: Float, elapsedMs: Long, glideMs: Long): Float {
        if (glideMs <= 0 || elapsedMs >= glideMs) return 1f
        val t = (elapsedMs.toFloat() / glideMs).coerceIn(0f, 1f)
        return from + (1f - from) * t
    }
}
