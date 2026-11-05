package ro.mixai.app

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TelemetryTest {
    @Test
    fun emptyDsnDisabled() {
        assertFalse(Telemetry.enabledFor(""))
    }

    @Test
    fun blankDsnDisabled() {
        assertFalse(Telemetry.enabledFor("   "))
    }

    @Test
    fun plainHttpDsnDisabled() {
        assertFalse(Telemetry.enabledFor("http://x"))
    }

    @Test
    fun httpsSentryDsnEnabled() {
        assertTrue(Telemetry.enabledFor("https://abc@o1.ingest.sentry.io/1"))
    }
}
