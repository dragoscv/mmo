package ro.mixai.tv.cast

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import ro.mixai.tv.data.generated.HubDevice

class MusicOutputsTest {
    @Test fun `common formats stream as is when the sink is unknown`() {
        assertNull(RemoteFormat.choose("mp3", emptySet()))
        assertNull(RemoteFormat.choose("flac", emptySet()))
        assertNull(RemoteFormat.choose("m4a", emptySet()))
    }

    @Test fun `exotic formats are converted even when the sink is unknown`() {
        assertEquals("flac", RemoteFormat.choose("ape", emptySet()))
        assertEquals("mp3", RemoteFormat.choose("wma", emptySet()))
        assertEquals("flac", RemoteFormat.choose("dsf", emptySet()))
    }

    @Test fun `renderer without flac gets mp3 for lossless files`() {
        val sink = setOf("audio/mpeg", "audio/mp4")
        assertEquals("mp3", RemoteFormat.choose("flac", sink))
        assertNull(RemoteFormat.choose("m4a", sink))
    }

    @Test fun `mime aliases match renderer protocol info`() {
        assertNull(RemoteFormat.choose("flac", setOf("audio/x-flac")))
        assertNull(RemoteFormat.choose("wav", setOf("audio/l16", "audio/wav")))
        assertTrue(RemoteFormat.accepts(setOf("*"), "audio/x-ape"))
    }

    @Test fun `cast receivers decode the common formats`() {
        assertNull(RemoteFormat.choose("flac", RemoteFormat.CAST_MIMES))
        assertEquals("mp3", RemoteFormat.choose("wma", RemoteFormat.CAST_MIMES))
        assertEquals("flac", RemoteFormat.choose("aiff", RemoteFormat.CAST_MIMES))
    }

    @Test fun `format parameter is added or replaced`() {
        assertEquals("http://h/rest/stream.view?id=1&format=mp3", RemoteFormat.withFormat("http://h/rest/stream.view?id=1", "mp3"))
        assertEquals("http://h/s?id=1&format=flac", RemoteFormat.withFormat("http://h/s?format=mp3&id=1", "flac"))
        assertEquals("http://h/s?id=1", RemoteFormat.withFormat("http://h/s?id=1", null))
        assertEquals("audio/mpeg", RemoteFormat.mimeAfter("flac", "mp3"))
        assertEquals("audio/flac", RemoteFormat.mimeAfter("flac", null))
    }

    @Test fun `memory entries round trip`() {
        val e = OutputMemory.Entry("dlna", "dlna:uuid-1", "Living room: Samsung")
        assertEquals(e, OutputMemory.decode(OutputMemory.encode(e)))
        assertNull(OutputMemory.decode("garbage"))
    }

    @Test fun `hub music targets need the music cap and exclude this device and guests`() {
        val devices = listOf(
            HubDevice(deviceId = "tv1", name = "Bedroom TV", platform = "android-tv", caps = listOf("play", "music")),
            HubDevice(deviceId = "tv2", name = "Old TV", platform = "tizen", caps = listOf("play")),
            HubDevice(deviceId = "me", name = "Phone", platform = "android-music", caps = listOf("music")),
            HubDevice(deviceId = "g", name = "Guest", platform = "web", caps = listOf("music"), guest = true),
            HubDevice(deviceId = "tv1", name = "Bedroom TV", platform = "android-tv", caps = listOf("music")),
        )
        val t = OutputDiscovery.hubTvs(devices, "me")
        assertEquals(listOf("hub:tv1"), t.map { it.id })
        assertEquals("Bedroom TV", t.single().name)
    }

    @Test fun `home assistant devices keep only ha ids`() {
        val body = """{"devices":[{"id":"dlna:x","kind":"dlna","name":"TV"},{"id":"ha:media_player.kitchen","kind":"google-cast-ha","name":"Kitchen"}],"haConfigured":true}"""
        val list = OutputDiscovery.parseHaDevices(Json { ignoreUnknownKeys = true }, body)
        assertEquals(listOf("ha:media_player.kitchen"), list.map { it.id })
        assertEquals("ha", list.single().kind)
    }

    @Test fun `target ids carry their kind`() {
        assertEquals("cast", OutputTarget.Cast("r1", "Nest").kind)
        assertEquals("hub", OutputTarget.HubTv("d", "TV").kind)
        assertEquals("local", OutputTarget.Local.kind)
    }
}
