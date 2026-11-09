package ro.mixai.decks.ui.desktop

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.awt.SwingPanel
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.toComposeImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalDensity
import com.sun.jna.Native
import com.sun.jna.Pointer
import java.awt.Canvas
import java.awt.event.ComponentAdapter
import java.awt.event.ComponentEvent
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import org.jetbrains.skia.ColorAlphaType
import org.jetbrains.skia.ColorType
import org.jetbrains.skia.Image as SkImage
import org.jetbrains.skia.ImageInfo
import ro.mixai.decks.ffi.DecksRenderer
import ro.mixai.decks.ui.components.ComposeWaveforms
import ro.mixai.decks.ui.engine.FfiBackend
import ro.mixai.decks.ui.engine.WaveRenderer
import ro.mixai.decks.ui.model.PeaksData
import ro.mixai.decks.ui.model.WaveFrame

/** How the desktop waveform is drawn (system property `decks.waveform` = native | headless | compose). */
enum class WaveMode { NATIVE, HEADLESS, COMPOSE }

fun waveModeFromEnv(): WaveMode = when (System.getProperty("decks.waveform")?.lowercase()) {
    "headless" -> WaveMode.HEADLESS
    "compose" -> WaveMode.COMPOSE
    else -> WaveMode.NATIVE
}

/**
 * Desktop waveforms from the Rust wgpu renderer:
 *  - NATIVE: a heavyweight AWT [Canvas] inside a SwingPanel; its HWND (Windows) / X11 window id
 *    (Linux, `Native.getComponentID`) goes to `DecksRenderer.fromWin32` / `fromXlib`; rendered on a
 *    dedicated thread at 60 Hz. Wayland-only sessions have no XID → falls back.
 *  - HEADLESS: `DecksRenderer.newHeadless` + `read_pixels()` copied into a Compose [ImageBitmap] at
 *    60 Hz (CPU readback; robust everywhere wgpu finds an adapter, used for screenshots/tests).
 *  - COMPOSE: the pure Compose painter (no GPU adapter).
 * Each mode degrades to the next on failure.
 */
@Composable
fun DesktopWaveforms(backend: FfiBackend, initial: WaveMode, frame: WaveFrame, peaks: List<PeaksData?>, modifier: Modifier) {
    var mode by remember { mutableStateOf(initial) }
    val latest = remember { AtomicReference(frame) }
    latest.set(frame)
    when (mode) {
        WaveMode.NATIVE -> NativeCanvasWaveforms(backend, latest, modifier) { mode = WaveMode.HEADLESS }
        WaveMode.HEADLESS -> HeadlessWaveforms(backend, latest, modifier) { mode = WaveMode.COMPOSE }
        WaveMode.COMPOSE -> ComposeWaveforms(frame, peaks, modifier)
    }
}

private object X11 {
    private val lib: X11Lib? by lazy { runCatching { Native.load("X11", X11Lib::class.java) }.getOrNull() }
    val display: Long by lazy { lib?.XOpenDisplay(null)?.let { Pointer.nativeValue(it) } ?: 0L }
    val screen: Int by lazy { lib?.let { l -> l.XOpenDisplay(null)?.let { l.XDefaultScreen(it) } } ?: 0 }

    interface X11Lib : com.sun.jna.Library {
        fun XOpenDisplay(name: String?): Pointer?
        fun XDefaultScreen(display: Pointer): Int
    }
}

@Composable
private fun NativeCanvasWaveforms(
    backend: FfiBackend,
    latest: AtomicReference<WaveFrame>,
    modifier: Modifier,
    onFailure: () -> Unit,
) {
    val holder = remember { NativeHolder(backend, latest, onFailure) }
    DisposableEffect(holder) { onDispose { holder.close() } }
    SwingPanel(modifier = modifier, factory = { holder.canvas })
}

private class NativeHolder(
    private val backend: FfiBackend,
    private val latest: AtomicReference<WaveFrame>,
    private val onFailure: () -> Unit,
) : AutoCloseable {
    private val exec = Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "decks-render").apply { isDaemon = true } }
    private var renderer: WaveRenderer? = null
    @Volatile private var pxSize = 0 to 0
    @Volatile private var scale = 1f
    @Volatile private var failed = false

    val canvas: Canvas = object : Canvas() {
        override fun addNotify() {
            super.addNotify()
            exec.execute(::create)
        }
        override fun paint(g: java.awt.Graphics?) = Unit
        override fun update(g: java.awt.Graphics?) = Unit
    }.apply {
        background = null
        addComponentListener(object : ComponentAdapter() {
            override fun componentResized(e: ComponentEvent) {
                val s = graphicsConfiguration?.defaultTransform?.scaleX?.toFloat() ?: 1f
                scale = s
                pxSize = (width * s).toInt() to (height * s).toInt()
                exec.execute { renderer?.resize(pxSize.first, pxSize.second, scale) }
            }
        })
    }

    private fun create() {
        if (renderer != null || failed) return
        try {
            val id = Native.getComponentID(canvas)
            val s = canvas.graphicsConfiguration?.defaultTransform?.scaleX?.toFloat() ?: 1f
            scale = s
            val w = (canvas.width * s).toInt().coerceAtLeast(1)
            val h = (canvas.height * s).toInt().coerceAtLeast(1)
            pxSize = w to h
            val os = System.getProperty("os.name").lowercase()
            val native = when {
                os.contains("win") -> DecksRenderer.fromWin32(id.toULong(), 0u, w.toUInt(), h.toUInt(), s)
                X11.display != 0L -> DecksRenderer.fromXlib(X11.display.toULong(), id.toULong(), X11.screen, w.toUInt(), h.toUInt(), s)
                else -> error("no native window system")
            }
            renderer = WaveRenderer(native, backend)
            System.err.println("[decks] waveform: native surface ${renderer?.info}")
            exec.scheduleAtFixedRate(::draw, 0, 16_666, TimeUnit.MICROSECONDS)
        } catch (t: Throwable) {
            System.err.println("[decks] native waveform surface unavailable: $t")
            failed = true
            javax.swing.SwingUtilities.invokeLater(onFailure)
        }
    }

    private fun draw() {
        val r = renderer ?: return
        val (w, h) = pxSize
        if (w <= 0 || h <= 0) return
        try {
            r.draw(latest.get(), w / scale, h / scale)
        } catch (t: Throwable) {
            System.err.println("[decks] native waveform render failed: $t")
            r.close(); renderer = null; failed = true
            javax.swing.SwingUtilities.invokeLater(onFailure)
        }
    }

    override fun close() {
        exec.execute { renderer?.close(); renderer = null }
        exec.shutdown()
    }
}

@Composable
private fun HeadlessWaveforms(
    backend: FfiBackend,
    latest: AtomicReference<WaveFrame>,
    modifier: Modifier,
    onFailure: () -> Unit,
) {
    var image by remember { mutableStateOf<ImageBitmap?>(null) }
    val density = LocalDensity.current.density
    BoxWithConstraints(modifier) {
        val wPx = (constraints.maxWidth).coerceAtLeast(1)
        val hPx = (constraints.maxHeight).coerceAtLeast(1)
        DisposableEffect(wPx, hPx) {
            val exec = Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "decks-render-headless").apply { isDaemon = true } }
            var renderer: WaveRenderer? = null
            exec.execute {
                try {
                    renderer = WaveRenderer(DecksRenderer.newHeadless(wPx.toUInt(), hPx.toUInt()), backend).also {
                        it.resize(wPx, hPx, density)
                        System.err.println("[decks] waveform: headless ${it.info}")
                    }
                } catch (t: Throwable) {
                    System.err.println("[decks] headless renderer unavailable: $t")
                    javax.swing.SwingUtilities.invokeLater(onFailure)
                }
            }
            exec.scheduleAtFixedRate({
                val r = renderer ?: return@scheduleAtFixedRate
                try {
                    r.draw(latest.get(), wPx / density, hPx / density)
                    val px = r.readPixels() ?: return@scheduleAtFixedRate
                    val info = ImageInfo(wPx, hPx, ColorType.RGBA_8888, ColorAlphaType.PREMUL)
                    val bmp = SkImage.makeRaster(info, px, wPx * 4).toComposeImageBitmap()
                    javax.swing.SwingUtilities.invokeLater { image = bmp }
                } catch (t: Throwable) {
                    System.err.println("[decks] headless render failed: $t")
                    r.close(); renderer = null
                    javax.swing.SwingUtilities.invokeLater(onFailure)
                }
            }, 0, 16_666, TimeUnit.MICROSECONDS)
            onDispose {
                exec.execute { renderer?.close(); renderer = null }
                exec.shutdown()
            }
        }
        image?.let { Image(it, null, Modifier.fillMaxSize(), contentScale = ContentScale.FillBounds) }
    }
}
