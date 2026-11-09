package ro.mixai.keybpm

/** Pure helpers for the "mix next" notification line and the booth display chip (JVM-tested, no FFI). */
object MixNext {
    /**
     * Key indices for the ongoing notification's "Next:" line: the first [max] candidates in the engine's order
     * (`compatibleKeys(idx)` as `relation to keyIndex`), without the same key and clashes, de-duplicated.
     */
    fun nextKeysForNotification(candidates: List<Pair<String, Int>>, max: Int = 3): List<Int> =
        candidates.asSequence()
            .filter { (relation, _) -> relation != "same" && relation != "clash" }
            .map { it.second }
            .distinct()
            .take(max)
            .toList()

    /** "9A · 7A · 8B" from already-formatted labels; null when there is nothing to suggest. */
    fun joinLabels(labels: List<String>): String? = labels.takeIf { it.isNotEmpty() }?.joinToString(" · ")

    /** Auto booth mode: the "Booth display" chip shows only while charging, in landscape and listening. */
    fun showBoothChip(charging: Boolean, landscape: Boolean, listening: Boolean): Boolean = charging && landscape && listening
}
