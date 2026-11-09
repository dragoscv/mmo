package ro.mixai.decks.ui.platform

import android.content.Context
import android.os.Handler
import android.os.HandlerThread
import android.util.Log
import android.view.Choreographer
import android.view.SurfaceHolder
import android.view.SurfaceView
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import java.util.concurrent.atomic.AtomicReference
import ro.mixai.decks.ffi.DecksRenderer
import ro.mixai.decks.ui.components.ComposeWaveforms
import ro.mixai.decks.ui.engine.FfiBackend
import ro.mixai.decks.ui.engine.WaveRenderer
import ro.mixai.decks.ui.model.PeaksData
import ro.mixai.decks.ui.model.WaveFrame

/**
 * Scrolling waveforms rendered by the Rust wgpu renderer (`decks-render`) straight into a
 * SurfaceView: `DecksRenderer.fromAndroidSurface(ANativeWindow*)` is created in surfaceChanged on
 * a dedicated render thread, driven by Choreographer at display rate, destroyed in
 * surfaceDestroyed. If the GPU path fails (no Vulkan/GLES adapter, e.g. some emulators) the
 * composable swaps to the Compose fallback.
 */
@Composable
fun GpuWaveforms(backend: FfiBackend, frame: WaveFrame, peaks: List<PeaksData?>, modifier: Modifier) {
    var failed by remember { mutableStateOf(false) }
    if (failed) {
        ComposeWaveforms(frame, peaks, modifier)
        return
    }
    val latest = remember { AtomicReference(frame) }
    latest.set(frame)
    AndroidView(
        modifier = modifier,
        factory = { ctx -> DecksSurfaceView(ctx, backend, latest) { failed = true } },
        onRelease = { it.shutdown() },
    )
}

private class DecksSurfaceView(
    context: Context,
    private val backend: FfiBackend,
    private val latest: AtomicReference<WaveFrame>,
    private val onFailure: () -> Unit,
) : SurfaceView(context), SurfaceHolder.Callback {
    private val thread = HandlerThread("decks-render").apply { start() }
    private val handler = Handler(thread.looper)
    private var renderer: WaveRenderer? = null
    private var window = 0L
    private var widthPx = 0
    private var heightPx = 0
    private val density = resources.displayMetrics.density
    @Volatile private var running = false

    private val frameCallback = object : Choreographer.FrameCallback {
        override fun doFrame(frameTimeNanos: Long) {
            if (!running) return
            val r = renderer
            if (r != null) {
                try {
                    r.draw(latest.get(), widthPx / density, heightPx / density)
                } catch (t: Throwable) {
                    Log.w(TAG, "render failed, falling back", t)
                    running = false
                    post(onFailure)
                    return
                }
            }
            Choreographer.getInstance().postFrameCallback(this)
        }
    }

    init {
        holder.addCallback(this)
    }

    override fun surfaceCreated(holder: SurfaceHolder) = Unit

    override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {
        val surface = holder.surface
        handler.post {
            widthPx = width
            heightPx = height
            val r = renderer
            if (r != null) {
                r.resize(width, height, density)
                return@post
            }
            try {
                window = AndroidNative.windowFor(surface)
                val native = DecksRenderer.fromAndroidSurface(window.toULong(), width.toUInt(), height.toUInt(), density)
                renderer = WaveRenderer(native, backend).also { Log.i(TAG, "decks-render: ${it.info}") }
                running = true
                Choreographer.getInstance().postFrameCallback(frameCallback)
            } catch (t: Throwable) {
                Log.w(TAG, "GPU waveform unavailable", t)
                releaseWindow()
                post(onFailure)
            }
        }
    }

    override fun surfaceDestroyed(holder: SurfaceHolder) {
        // Must finish before returning: the surface is invalid afterwards.
        val done = java.util.concurrent.CountDownLatch(1)
        handler.post {
            running = false
            renderer?.close()
            renderer = null
            releaseWindow()
            done.countDown()
        }
        done.await(2, java.util.concurrent.TimeUnit.SECONDS)
    }

    private fun releaseWindow() {
        if (window != 0L) {
            runCatching { AndroidNative.ANativeWindow_release(window) }
            window = 0L
        }
    }

    fun shutdown() {
        handler.post {
            running = false
            renderer?.close()
            renderer = null
            releaseWindow()
            thread.quitSafely()
        }
    }

    companion object {
        private const val TAG = "DecksRender"
    }
}
