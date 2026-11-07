package ro.mixai.music

import android.content.ComponentName
import android.util.Log
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.session.MediaBrowser
import androidx.media3.session.SessionToken
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import ro.mixai.tv.data.Settings
import ro.mixai.tv.player.MediaIds
import ro.mixai.tv.player.MusicNode
import ro.mixai.tv.player.MusicService
import java.util.concurrent.TimeUnit

/**
 * What Android Auto / Assistant see (WP17-41c): a MediaBrowser on [MusicService] browses the tree,
 * searches and plays. Needs a device where the app is already paired to a server with music
 * (skipped otherwise); run with `:music:connectedDebugAndroidTest`.
 */
@RunWith(AndroidJUnit4::class)
class BrowseTreeTest {
    private val ctx = InstrumentationRegistry.getInstrumentation().targetContext
    private lateinit var browser: MediaBrowser

    @Before fun connect() {
        val paired = runBlocking { Settings(ctx).connection.first().isComplete }
        assumeTrue("app not paired to a server on this device", paired)
        val token = SessionToken(ctx, ComponentName(ctx, MusicService::class.java))
        browser = MediaBrowser.Builder(ctx, token).buildAsync().get(15, TimeUnit.SECONDS)
    }

    @After fun release() {
        if (::browser.isInitialized) onMain { browser.stop(); browser.release() }
    }

    private fun <T> onMain(block: () -> T): T {
        var out: Result<T>? = null
        InstrumentationRegistry.getInstrumentation().runOnMainSync { out = runCatching(block) }
        return out!!.getOrThrow()
    }

    private fun children(id: String): List<MediaItem> {
        val r = onMain { browser.getChildren(id, 0, 100, null) }.get(30, TimeUnit.SECONDS)
        assertEquals("children of $id: ${r.sessionError?.message}", 0, r.resultCode)
        return r.value!!.toList()
    }

    private fun log(label: String, items: List<MediaItem>) =
        Log.i(TAG, "$label (${items.size}): " + items.take(12).joinToString(" | ") { "${it.mediaMetadata.title}${if (it.mediaMetadata.isPlayable == true) " ▶" else ""}" })

    @Test fun rootHomeAlbumArtistSearchAndMixPlay() {
        val root = onMain { browser.getLibraryRoot(null) }.get(15, TimeUnit.SECONDS).value!!
        assertEquals(MediaIds.encode(MusicNode.Root), root.mediaId)

        val top = children(root.mediaId)
        log("root", top)
        assertEquals(listOf("home", "playlists", "artists"), top.map { it.mediaId })

        val home = children("home")
        log("home", home)
        assertEquals("mix", home.first().mediaId)
        assertTrue(home.first().mediaMetadata.isPlayable == true)

        val album = home.first { it.mediaId.startsWith("album/") }
        val tracks = children(album.mediaId)
        log("album ${album.mediaMetadata.title}", tracks)
        assertTrue(tracks.isNotEmpty() && tracks.all { it.mediaMetadata.isPlayable == true && it.mediaId.startsWith("track/") })

        val artists = children("artists")
        log("artists", artists)
        assertTrue(artists.isNotEmpty())
        val artist = children(artists.first().mediaId)
        log("artist ${artists.first().mediaMetadata.title}", artist)
        assertTrue(artist.first().mediaId.startsWith("radio/"))

        val q = tracks.first().mediaMetadata.title.toString().split(' ').first { it.length >= 3 }
        val search = onMain { browser.search(q, null) }.get(30, TimeUnit.SECONDS)
        assertEquals(0, search.resultCode)
        val results = onMain { browser.getSearchResult(q, 0, 50, null) }.get(30, TimeUnit.SECONDS).value!!.toList()
        log("search '$q'", results)
        assertTrue(results.isNotEmpty())

        // Selecting the second album track plays the whole album from it (what Auto does on tap).
        onMain { browser.setMediaItem(tracks[minOf(1, tracks.lastIndex)]); browser.prepare(); browser.play() }
        waitFor { onMain { browser.mediaItemCount } == tracks.size && onMain { browser.playbackState } != Player.STATE_IDLE }
        assertEquals(minOf(1, tracks.lastIndex), onMain { browser.currentMediaItemIndex })
        Log.i(TAG, "album tap -> queue ${onMain { browser.mediaItemCount }}, index ${onMain { browser.currentMediaItemIndex }}")

        // The playable "Shuffle all" entry and an empty voice query both start a mix.
        onMain { browser.setMediaItem(MediaItem.Builder().setRequestMetadata(MediaItem.RequestMetadata.Builder().setSearchQuery("").build()).build()); browser.prepare(); browser.play() }
        waitFor { onMain { browser.isPlaying } && onMain { browser.mediaItemCount } > 1 }
        Log.i(TAG, "empty voice query -> playing ${onMain { browser.currentMediaItem?.mediaMetadata?.title }} of ${onMain { browser.mediaItemCount }}")
        onMain { browser.pause() }
    }

    private fun waitFor(timeoutMs: Long = 20_000, ok: () -> Boolean) {
        val end = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < end) { if (ok()) return; Thread.sleep(200) }
        throw AssertionError("condition not met in $timeoutMs ms")
    }

    private companion object { const val TAG = "BrowseTreeTest" }
}
