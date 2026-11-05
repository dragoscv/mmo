package ro.mixai.app.ui.playon

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import ro.mixai.tv.data.generated.HubDevice
import ro.mixai.tv.data.generated.HubMedia
import ro.mixai.tv.data.generated.HubNowPlaying

class PlayOnTargetsTest {
    private val me = "me"

    private fun dev(
        id: String,
        formFactor: String? = null,
        platform: String = "",
        target: Boolean? = null,
        caps: List<String> = emptyList(),
        guest: Boolean = false,
        playingFile: String? = null,
    ) = HubDevice(
        deviceId = id,
        name = id,
        platform = platform,
        formFactor = formFactor,
        playbackTarget = target,
        caps = caps,
        guest = guest,
        nowPlaying = playingFile?.let { HubNowPlaying(playing = true, positionSec = 12.0, media = HubMedia(fileId = it)) },
    )

    private fun ids(list: List<HubDevice>) = list.map { it.deviceId }

    @Test
    fun excludesSelfAndGuests() {
        val devices = listOf(dev(me, formFactor = "tv"), dev("guest-tv", formFactor = "tv", guest = true), dev("tv"))
        assertEquals(emptyList<String>(), ids(playbackTargets(devices, me)))
        val devices2 = devices + dev("tv2", formFactor = "tv")
        assertEquals(listOf("tv2"), ids(playbackTargets(devices2, me)))
    }

    @Test
    fun serverPlaybackTargetWinsOverHeuristics() {
        val devices = listOf(
            dev("tv-off", formFactor = "tv", target = false),
            dev("phone-on", formFactor = "phone", target = true),
        )
        assertEquals(listOf("phone-on"), ids(playbackTargets(devices, me)))
    }

    @Test
    fun nullTargetTvFormFactorIncluded() {
        assertEquals(listOf("tv"), ids(playbackTargets(listOf(dev("tv", formFactor = "tv")), me)))
    }

    @Test
    fun nullTargetTvPlatformsIncluded() {
        val devices = listOf(dev("atv", platform = "android-tv"), dev("tz", platform = "tizen"), dev("web", platform = "web"))
        assertEquals(listOf("atv", "tz"), ids(playbackTargets(devices, me)))
    }

    @Test
    fun phoneWithPlayCapAndNullTargetExcluded() {
        val devices = listOf(dev("phone", formFactor = "phone", caps = listOf("play")), dev("desk", formFactor = "desktop", caps = listOf("play")))
        assertEquals(listOf("desk"), ids(playbackTargets(devices, me)))
    }

    @Test
    fun dedupesByDeviceId() {
        val devices = listOf(dev("tv", formFactor = "tv"), dev("tv", formFactor = "tv"))
        assertEquals(listOf("tv"), ids(playbackTargets(devices, me)))
        assertEquals(listOf("tv"), ids(remoteTargets(devices, me)))
    }

    @Test
    fun nullMyDeviceIdKeepsAll() {
        assertEquals(listOf("me"), ids(playbackTargets(listOf(dev(me, formFactor = "tv")), null)))
    }

    @Test
    fun remoteTargetsIncludesTvAndNavigateNonPhone() {
        val devices = listOf(
            dev("tv", formFactor = "tv"),
            dev("box", formFactor = "desktop", caps = listOf("navigate")),
            dev("phone", formFactor = "phone", caps = listOf("navigate")),
            dev("guest", formFactor = "tv", guest = true),
            dev(me, formFactor = "tv"),
        )
        assertEquals(listOf("tv", "box"), ids(remoteTargets(devices, me)))
    }

    @Test
    fun deviceSessionForFindsTvPlayingFileAndIgnoresSelf() {
        val devices = listOf(dev(me, formFactor = "phone", playingFile = "f1"), dev("tv-other", formFactor = "tv", playingFile = "f2"), dev("tv", formFactor = "tv", playingFile = "f1"))
        assertEquals("tv", deviceSessionFor(devices, "f1", me)?.deviceId)
    }

    @Test
    fun deviceSessionForNullWhenNobodyPlays() {
        val devices = listOf(dev(me, playingFile = "f1"), dev("tv", formFactor = "tv"))
        assertNull(deviceSessionFor(devices, "f1", me))
        assertNull(deviceSessionFor(emptyList(), "f1", me))
    }
}
