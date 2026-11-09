package ro.mixai.keybpm.data

import org.junit.Assert.assertEquals
import org.junit.Test
import java.time.ZoneOffset

class SetLogCsvTest {
    @Test
    fun csvIsOldestFirstQuotedAndLocaleIndependent() {
        val a = LogEntry(1_700_000_000_000, "8A", "A minor", 124.04, 0.91, "mic", title = "Say \"hi\"", artist = "X, Y")
        val b = LogEntry(1_700_000_060_000, "9A", "E minor", 126.0, 0.8, "file")
        val csv = SetLog.toCsv(listOf(b, a), ZoneOffset.UTC)
        val lines = csv.trimEnd().split("\r\n")
        assertEquals("time,camelot,key,bpm,key_confidence,source,title,artist", lines[0])
        assertEquals("2023-11-14T22:13:20,8A,\"A minor\",124.0,0.91,mic,\"Say \"\"hi\"\"\",\"X, Y\"", lines[1])
        assertEquals("2023-11-14T22:14:20,9A,\"E minor\",126.0,0.80,file,,", lines[2])
    }
}
