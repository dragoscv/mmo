package ro.mixai.tv.player

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import ro.mixai.tv.data.generated.AlbumCard
import ro.mixai.tv.data.generated.AlbumDetail
import ro.mixai.tv.data.generated.ArtistCard
import ro.mixai.tv.data.generated.ArtistDetail
import ro.mixai.tv.data.generated.MusicHome
import ro.mixai.tv.data.generated.MusicSearch
import ro.mixai.tv.data.generated.TrackCard

class MusicResolverTest {
    private fun t(id: String) = TrackCard(id = id, title = id)

    private class Fake(
        val search: MusicSearch = MusicSearch(),
        val emptyLibrary: Boolean = false,
        val noRadio: Boolean = false,
    ) : MusicSource {
        val calls = mutableListOf<String>()
        override suspend fun home() = MusicHome(mostPlayed = listOf(TrackCard("tr_9"), TrackCard("tr_8"))).also { calls += "home" }
        override suspend fun album(id: String) = AlbumDetail(AlbumCard(id), listOf(TrackCard("tr_1"), TrackCard("tr_2"), TrackCard("tr_3"))).also { calls += "album:$id" }
        override suspend fun artist(id: String) = ArtistDetail(ArtistCard(id), topTracks = listOf(TrackCard("tr_5"), TrackCard("tr_6"))).also { calls += "artist:$id" }
        override suspend fun playlistTracks(id: String) = listOf(TrackCard("tr_7"), TrackCard("tr_2")).also { calls += "playlist:$id" }
        override suspend fun random(size: Int) = (if (emptyLibrary) emptyList() else List(3) { TrackCard("tr_r$it") }).also { calls += "random:$size" }
        override suspend fun radio(seed: String, size: Int): List<TrackCard> {
            calls += "radio:$seed"
            if (noRadio) throw ro.mixai.tv.data.ApiException(404, "not found")
            return listOf(TrackCard(seed), TrackCard("tr_x"))
        }
        override suspend fun search(q: String) = search.also { calls += "search:$q" }
    }

    @Test fun emptyVoiceQueryStartsAMixWithoutSearching() = runBlocking {
        val f = Fake()
        val r = MusicResolver(f).voice("  ")!!
        assertEquals(3, r.tracks.size)
        assertEquals(listOf("random:${MusicResolver.MIX_SIZE}"), f.calls)
        assertEquals(MusicResolver(f).voice(null)!!.tracks.size, 3)
    }

    @Test fun emptyLibraryVoiceQueryResolvesToNothing() = runBlocking {
        assertNull(MusicResolver(Fake(emptyLibrary = true)).voice(""))
    }

    @Test fun trackInsideItsAlbumStartsAtThatTrack() = runBlocking {
        val r = MusicResolver(Fake()).node(MusicNode.Track("tr_2", TrackContext.Album("al_1")))!!
        assertEquals(listOf("tr_1", "tr_2", "tr_3"), r.tracks.map { it.id })
        assertEquals(1, r.start)
    }

    @Test fun trackMissingFromItsListOrWithoutContextPlaysItsRadio() = runBlocking {
        val f = Fake()
        val gone = MusicResolver(f).node(MusicNode.Track("tr_404", TrackContext.Playlist("pl_1")))!!
        assertEquals("tr_404", gone.tracks.first().id)
        val single = MusicResolver(f).node(MusicNode.Track("tr_5", TrackContext.Single))!!
        assertEquals(listOf("tr_5", "tr_x"), single.tracks.map { it.id })
        assertEquals(listOf("playlist:pl_1", "radio:tr_404", "radio:tr_5"), f.calls)
    }

    @Test fun mostPlayedAndSearchContextsUseTheirLists() = runBlocking {
        val f = Fake(search = MusicSearch("q", tracks = listOf(TrackCard("tr_a"), TrackCard("tr_b"), TrackCard("tr_a"))))
        assertEquals(1, MusicResolver(f).node(MusicNode.Track("tr_8", TrackContext.MostPlayed))!!.start)
        val s = MusicResolver(f).node(MusicNode.Track("tr_b", TrackContext.Search("q")))!!
        assertEquals(listOf("tr_a", "tr_b"), s.tracks.map { it.id })
        assertEquals(1, s.start)
    }

    @Test fun browsableContainersAreNotPlayable() = runBlocking {
        listOf(MusicNode.Root, MusicNode.Home, MusicNode.Playlists, MusicNode.Artists).forEach { assertNull(MusicResolver(Fake()).node(it)) }
    }

    @Test fun voiceFocusPicksArtistRadioOrAlbum() = runBlocking {
        val s = MusicSearch("x", artists = listOf(ArtistCard("ar_1")), albums = listOf(AlbumCard("al_2")), tracks = listOf(TrackCard("tr_3")))
        assertEquals("ar_1", MusicResolver(Fake(s)).voice("x", VoiceFocus.Artist)!!.tracks.first().id)
        assertEquals(listOf("tr_1", "tr_2", "tr_3"), MusicResolver(Fake(s)).voice("x", VoiceFocus.Album)!!.tracks.map { it.id })
        assertEquals(listOf("tr_3"), MusicResolver(Fake(s)).voice("x")!!.tracks.map { it.id })
    }

    @Test fun voiceFallsBackFromTracksToAlbumToArtistToNothing() = runBlocking {
        assertEquals("tr_1", MusicResolver(Fake(MusicSearch("x", albums = listOf(AlbumCard("al_2"))))).voice("x")!!.tracks.first().id)
        assertEquals("ar_1", MusicResolver(Fake(MusicSearch("x", artists = listOf(ArtistCard("ar_1"))))).voice("x")!!.tracks.first().id)
        assertNull(MusicResolver(Fake(MusicSearch("x"))).voice("x"))
    }

    @Test fun radioOnAnOldServerFallsBackToAMix() = runBlocking {
        val f = Fake(noRadio = true)
        val r = MusicResolver(f).node(MusicNode.Radio("ar_1"))!!
        assertEquals(listOf("tr_r0", "tr_r1", "tr_r2"), r.tracks.map { it.id })
        assertEquals(listOf("radio:ar_1", "random:${MusicResolver.MIX_SIZE}"), f.calls)
    }

    @Test fun focusMapsMediaStoreContentTypes() {
        assertEquals(VoiceFocus.Artist, MusicResolver.focusOf("vnd.android.cursor.item/artist"))
        assertEquals(VoiceFocus.Album, MusicResolver.focusOf("vnd.android.cursor.item/album"))
        assertEquals(VoiceFocus.Any, MusicResolver.focusOf("vnd.android.cursor.item/audio"))
        assertEquals(VoiceFocus.Any, MusicResolver.focusOf(null))
    }
}
