package ro.mixai.music.downloads

import androidx.media3.exoplayer.offline.Download
import org.junit.Assert.assertEquals
import org.junit.Test
import ro.mixai.music.ui.OfflineState

// Limit / upcoming rules live with the engine in :core (ro.mixai.tv.offline.DownloadRulesTest).
class DownloadRulesTest {
    @Test fun media3StatesMapToOfflineStates() {
        assertEquals(OfflineState.Done, offlineState(Download.STATE_COMPLETED))
        assertEquals(OfflineState.Downloading, offlineState(Download.STATE_DOWNLOADING))
        assertEquals(OfflineState.Failed, offlineState(Download.STATE_FAILED))
        assertEquals(OfflineState.Waiting, offlineState(Download.STATE_STOPPED))
        assertEquals(OfflineState.Queued, offlineState(Download.STATE_QUEUED))
        assertEquals(OfflineState.Queued, offlineState(Download.STATE_RESTARTING))
    }
}
