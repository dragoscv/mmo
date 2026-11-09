package ro.mixai.listen

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import uniffi.mixai_listen_ffi.EngineConfig
import uniffi.mixai_listen_ffi.KeyBpmEngine
import uniffi.mixai_listen_ffi.KeyNotation
import uniffi.mixai_listen_ffi.allKeys
import uniffi.mixai_listen_ffi.compatibleKeys
import uniffi.mixai_listen_ffi.keyLabel
import uniffi.mixai_listen_ffi.parseKey
import kotlin.math.PI
import kotlin.math.sin

/** Runs the generated bindings against the host cdylib (jna.library.path = crates/target/debug). */
class EngineTest {
    @Test
    fun keyHelpersCrossTheFfi() {
        assertEquals(24, allKeys().size)
        assertEquals("8A", parseKey("A minor")!!.camelot)
        assertEquals("1m", keyLabel(21u, KeyNotation.OPEN_KEY))
        assertEquals("relative", compatibleKeys(21u)[1].relation)
    }

    @Test
    fun engineReportsATunerPitchForASine() {
        val sr = 48_000
        KeyBpmEngine(EngineConfig(sr.toUInt(), 88.0, 440.0)).use { engine ->
            val block = FloatArray(sr / 2) { i -> (0.3 * sin(2 * PI * 440.0 * i / sr)).toFloat() }
            val bb = java.nio.ByteBuffer.allocate(block.size * 4).order(java.nio.ByteOrder.LITTLE_ENDIAN)
            bb.asFloatBuffer().put(block)
            engine.pushPcmBytes(bb.array())
            val s = engine.snapshot()
            assertEquals(0.5, s.elapsedSecs, 1e-9)
            assertEquals("A4", s.pitch!!.noteName)
            assertTrue(kotlin.math.abs(s.pitch!!.cents) < 3.0)
            assertNull(s.key)
            engine.reset()
            assertEquals(0.0, engine.snapshot().elapsedSecs, 0.0)
        }
    }
}
