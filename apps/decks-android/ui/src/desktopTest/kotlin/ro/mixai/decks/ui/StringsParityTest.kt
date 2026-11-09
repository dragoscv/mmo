package ro.mixai.decks.ui

import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import ro.mixai.decks.ui.i18n.DesktopStrings
import ro.mixai.decks.ui.i18n.Str

/** Android `res/values{,-ro}/strings_decks.xml` and the desktop tables carry the same keys and texts. */
class StringsParityTest {
    private fun read(dir: String): Map<String, String> {
        val res = System.getProperty("decks.appRes") ?: error("decks.appRes not set")
        val f = File(res, "$dir/strings_decks.xml")
        assertTrue(f.isFile, "missing $f")
        val doc = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(f)
        val nodes = doc.getElementsByTagName("string")
        return (0 until nodes.length).associate { i ->
            val e = nodes.item(i) as org.w3c.dom.Element
            e.getAttribute("name").removePrefix("decks_") to e.textContent.replace("\\'", "'").replace("\\\"", "\"")
        }
    }

    @Test fun androidAndDesktopMatchInBothLocales() {
        val en = read("values")
        val ro = read("values-ro")
        for (s in Str.entries) {
            assertTrue(en.containsKey(s.key), "values missing decks_${s.key}")
            assertTrue(ro.containsKey(s.key), "values-ro missing decks_${s.key}")
        }
        assertEquals(en.keys, ro.keys)
        for (k in en.keys) {
            assertEquals(DesktopStrings.en[k], en[k], "en text differs for $k")
            assertEquals(DesktopStrings.ro[k], ro[k], "ro text differs for $k")
        }
    }
}
