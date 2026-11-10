package ro.mixai.tv.data

import kotlinx.coroutines.runBlocking
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.net.URLDecoder
import java.util.concurrent.CopyOnWriteArrayList

// `/media/search` and `/media/library` must carry the active profile: without `profile=` the server
// answers for the unrestricted default profile, so a kid profile got titles above its age limit.
class MediaSearchProfileTest {
    private lateinit var server: MockWebServer
    private val targets = CopyOnWriteArrayList<String>()
    private val kid = "p_kid 1/ă"

    private fun queryParam(target: String, name: String): String? =
        Regex("[?&]$name=([^&]*)").find(target)?.groupValues?.get(1)?.let { URLDecoder.decode(it, "UTF-8") }

    @Before fun setUp() {
        server = MockWebServer()
        // Like MMO Server: no `profile` = the default (adult) profile; the kid profile does not get the 15+ title.
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val target = request.target
                targets += target
                if (target.startsWith("/media/library")) {
                    return MockResponse.Builder().code(200)
                        .body("""{"revision":1,"full":true,"items":[],"removed":[],"serverId":null,"serverName":"s"}""").build()
                }
                val profile = queryParam(target, "profile") ?: "default"
                val card = """{"kind":"movie","tmdbId":358332,"title":"Cosmos Laundromat","genreIds":[16],"age":15,"inLibrary":true}"""
                val results = if (profile == kid) "" else card
                return MockResponse.Builder().code(200).body("""{"page":1,"totalPages":1,"results":[$results]}""").build()
            }
        }
        server.start()
    }

    @After fun tearDown() {
        server.close()
    }

    private fun api() = MmoApi(server.url("/").toString().trimEnd('/'), "device-token")

    @Test fun searchIsScopedToTheActiveProfile() = runBlocking {
        val kidPage = MediaRepository(api(), kid).search("cosmos laundromat")
        assertEquals("a kid profile must not get titles above its age limit in search", emptyList<String>(), kidPage.results.map { it.title })

        val adultPage = MediaRepository(api(), "default").search("cosmos laundromat", page = 2)
        assertEquals(listOf("Cosmos Laundromat"), adultPage.results.map { it.title })

        assertEquals(2, targets.size)
        val first = targets[0]
        assertTrue(first, first.startsWith("/media/search?"))
        assertEquals(kid, queryParam(first, "profile"))
        assertEquals("cosmos laundromat", queryParam(first, "q"))
        assertEquals("1", queryParam(first, "page"))
        assertEquals("default", queryParam(targets[1], "profile"))
        assertEquals("2", queryParam(targets[1], "page"))
    }

    @Test fun libraryIsScopedToTheActiveProfile() = runBlocking {
        val repo = MediaRepository(api(), kid)
        repo.library()
        repo.library(since = 7)
        assertEquals(2, targets.size)
        assertTrue(targets[0], targets[0].startsWith("/media/library?"))
        assertEquals(kid, queryParam(targets[0], "profile"))
        assertEquals(null, queryParam(targets[0], "since"))
        assertEquals(kid, queryParam(targets[1], "profile"))
        assertEquals("7", queryParam(targets[1], "since"))
    }
}
