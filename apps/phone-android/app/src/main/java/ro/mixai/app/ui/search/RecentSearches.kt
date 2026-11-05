package ro.mixai.app.ui.search

import android.content.Context
import org.json.JSONArray

/** Up to [MAX] recent queries, newest first, in SharedPreferences "phone_search". */
internal class RecentSearches(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("phone_search", Context.MODE_PRIVATE)

    fun load(): List<String> = runCatching {
        val arr = JSONArray(prefs.getString(KEY, "[]"))
        List(arr.length()) { arr.getString(it) }
    }.getOrDefault(emptyList())

    fun add(q: String): List<String> {
        val t = q.trim()
        if (t.length < 2) return load()
        val next = (listOf(t) + load().filterNot { it.equals(t, ignoreCase = true) }).take(MAX)
        save(next)
        return next
    }

    fun remove(q: String): List<String> = load().filterNot { it == q }.also(::save)

    fun clear(): List<String> = emptyList<String>().also(::save)

    private fun save(list: List<String>) {
        prefs.edit().putString(KEY, JSONArray(list).toString()).apply()
    }

    private companion object {
        const val KEY = "recent"
        const val MAX = 10
    }
}
