package ro.mixai.app.ui.library

import java.text.Normalizer

private val MARKS = Regex("""\p{M}+""")

/** Sort key for A–Z: diacritics folded, lower case, leading article "the " dropped. */
fun alphaSortKey(title: String): String =
    Normalizer.normalize(title.trim(), Normalizer.Form.NFD).replace(MARKS, "").lowercase().removePrefix("the ").trim()

/** Rail letter for a title: A–Z, '#' for anything else (digits, symbols, empty). */
fun alphaLetter(title: String): Char {
    val c = alphaSortKey(title).firstOrNull() ?: return '#'
    return if (c in 'a'..'z') c.uppercaseChar() else '#'
}

/**
 * Letter → index of the first title starting with it, for titles already sorted A–Z.
 * Keys keep first-appearance order; '#' collects non-letters.
 */
fun alphaIndex(titles: List<String>): Map<Char, Int> {
    val out = LinkedHashMap<Char, Int>()
    titles.forEachIndexed { i, t -> out.putIfAbsent(alphaLetter(t), i) }
    return out
}
