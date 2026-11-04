package ro.mixai.tv.ui.search

import android.content.Context

/**
 * Last [MAX] search queries per viewer profile (newest first). Small and synchronous on purpose:
 * SharedPreferences, one key per profile, so it never touches the shared app DataStore.
 */
class RecentSearches(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("mixai_search", Context.MODE_PRIVATE)

    fun list(profileId: String): List<String> =
        prefs.getString(key(profileId), null)?.split('\n')?.map { it.trim() }?.filter { it.isNotEmpty() }.orEmpty()

    fun add(profileId: String, query: String): List<String> {
        val q = query.trim()
        if (q.length < 2) return list(profileId)
        val next = push(list(profileId), q)
        prefs.edit().putString(key(profileId), next.joinToString("\n")).apply()
        return next
    }

    fun clear(profileId: String) {
        prefs.edit().remove(key(profileId)).apply()
    }

    private fun key(profileId: String) = "recent_" + profileId.ifBlank { "default" }

    companion object {
        const val MAX = 10

        /** Newest first, case-insensitive de-duplication, capped at [MAX]. */
        fun push(list: List<String>, q: String): List<String> =
            (listOf(q) + list.filterNot { it.equals(q, ignoreCase = true) }).take(MAX)
    }
}
