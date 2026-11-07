package ro.mixai.tv.player

import ro.mixai.tv.data.generated.TrackCard
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.pow
import kotlin.math.sin

/** Playback audio preferences an app pushes into [MusicService.audioPrefs] (WP17-41e). Defaults = off. */
data class AudioPrefs(
    /** Crossfade length between tracks in ms (0 = plain gapless transitions). */
    val crossfadeMs: Int = 0,
    /** Loudness normalisation from the server's EBU R128 measurement (TrackCard.loudnessLufs / truePeakDbfs). */
    val normalize: Boolean = false,
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
}
