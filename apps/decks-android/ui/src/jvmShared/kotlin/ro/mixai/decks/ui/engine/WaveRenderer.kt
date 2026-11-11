package ro.mixai.decks.ui.engine

import ro.mixai.decks.ffi.DeckFrameState
import ro.mixai.decks.ffi.DecksRenderer
import ro.mixai.decks.ffi.RenderFrameState
import ro.mixai.decks.ffi.RenderGrid
import ro.mixai.decks.ffi.RenderMarker
import ro.mixai.decks.ffi.RenderMarkerKind
import ro.mixai.decks.ffi.RenderTheme
import ro.mixai.decks.ffi.RenderView
import ro.mixai.decks.ffi.RenderViewKind
import ro.mixai.decks.ffi.RenderWaveStyle
import ro.mixai.decks.ui.model.WaveFrame
import ro.mixai.decks.ui.theme.DecksColors

/**
 * Drives one `decks-render` [DecksRenderer] (GPU waveforms through wgpu) from the UI's
 * [WaveFrame]: stacked scrolling waveform lanes, one per deck. Thread-confined: create, render and
 * close on the same thread (the SurfaceView render thread on Android, the render executor on Desktop).
 */
class WaveRenderer(
    private val renderer: DecksRenderer,
    private val backend: FfiBackend,
) : AutoCloseable {
    private val uploaded = IntArray(4) { -1 }
    private var viewsKey = ""

    val info: String get() = runCatching { renderer.info().let { "${it.backend} · ${it.adapter}" } }.getOrDefault("?")

    fun resize(width: Int, height: Int, scale: Float) {
        runCatching { renderer.resize(width.toUInt().coerceAtLeast(1u), height.toUInt().coerceAtLeast(1u), scale) }
        viewsKey = ""
    }

    /** Renders one frame; [logicalW]/[logicalH] = view size in logical pixels. */
    fun draw(frame: WaveFrame, logicalW: Float, logicalH: Float) {
        val n = frame.decks.size.coerceAtLeast(1)
        val key = "$n:$logicalW:$logicalH"
        if (key != viewsKey) {
            val laneH = logicalH / n
            renderer.setViews(frame.decks.mapIndexed { i, _ ->
                RenderView(RenderViewKind.Waveform(i.toUByte()), 0f, laneH * i, logicalW, laneH)
            })
            viewsKey = key
        }
        frame.decks.forEach { d ->
            if (d.peaksVersion != uploaded[d.index]) {
                backend.rawPeaks(d.index)?.let { renderer.setPeaks(d.index.toUByte(), it) }
                uploaded[d.index] = d.peaksVersion
            }
        }
        renderer.update(
            RenderFrameState(
                decks = frame.decks.map { d ->
                    val markers = buildList {
                        if (d.loaded) add(RenderMarker(RenderMarkerKind.Cue, d.cuePointSec, d.cuePointSec, DecksColors.rgb(DecksColors.cueButton)))
                        d.hotCues.forEachIndexed { i, h ->
                            if (h != null) add(RenderMarker(RenderMarkerKind.HotCue(i.toUByte()), h, h, DecksColors.rgb(DecksColors.cue(i))))
                        }
                        if (d.loopActive) {
                            add(RenderMarker(RenderMarkerKind.Loop, d.loopStartSec, d.loopEndSec, DecksColors.rgb(DecksColors.success)))
                        }
                    }
                    DeckFrameState(
                        loaded = d.loaded,
                        playheadSec = d.playheadSec,
                        slipPlayheadSec = null,
                        durationSec = d.durationSec,
                        grid = d.bpm?.takeIf { it > 0 }?.let { RenderGrid(it, d.firstBeatSec ?: 0.0, 4u) },
                        markers = markers,
                        platterRpm = 33.333f,
                        dvsScope = emptyList(),
                    )
                },
                zoomSeconds = frame.zoomSeconds,
                style = RenderWaveStyle.SPECTRAL,
                theme = RenderTheme.DARK,
                reducedMotion = frame.reducedMotion,
            ),
        )
        renderer.render()
    }

    /** Headless renderers only: tightly packed RGBA8. */
    fun readPixels(): ByteArray? = runCatching { renderer.readPixels() }.getOrNull()

    override fun close() {
        runCatching { renderer.close() }
    }
}
