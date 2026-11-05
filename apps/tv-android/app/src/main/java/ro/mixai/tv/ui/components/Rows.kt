package ro.mixai.tv.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.focusRestorer
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Text
import ro.mixai.tv.ui.theme.MixaiFocus
import ro.mixai.tv.ui.theme.Tokens

/** Row header: title + optional trailing text (count, "See all"). */
@Composable
fun RowTitle(title: String, modifier: Modifier = Modifier, trailing: String? = null) {
    Row(modifier.fillMaxWidth().padding(horizontal = MixaiFocus.overscan), verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(title, style = MaterialTheme.typography.titleLarge, color = Tokens.foreground)
        if (!trailing.isNullOrBlank()) Text(trailing, style = MaterialTheme.typography.bodySmall, color = Tokens.mutedForeground)
    }
}

/**
 * Horizontal media row: title + LazyRow with `focusRestorer()` (re-entering the row lands on the
 * last focused card), horizontal padding = TV overscan. [itemContent] renders one card and gets
 * `onFocus` already wired to [onFocusItem].
 */
@Composable
fun <T> MediaRow(
    title: String,
    items: List<T>,
    key: (T) -> Any,
    onFocusItem: (T) -> Unit = {},
    onClick: (T) -> Unit,
    modifier: Modifier = Modifier,
    trailing: String? = null,
    state: LazyListState = rememberLazyListState(),
    spacing: Dp = 20.dp,
    itemContent: @Composable (item: T, index: Int, onFocus: () -> Unit, onClick: () -> Unit) -> Unit,
) {
    // Server rows can repeat a title (two files of one film) → duplicate LazyRow keys crash
    // ("Key ... was already used"); keep the first occurrence.
    val unique = remember(items) { items.distinctBy(key) }
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        if (title.isNotBlank()) RowTitle(title, trailing = trailing)
        LazyRow(
            state = state,
            modifier = Modifier.fillMaxWidth().focusRestorer(),
            contentPadding = PaddingValues(horizontal = MixaiFocus.overscan, vertical = 12.dp),
            horizontalArrangement = Arrangement.spacedBy(spacing),
        ) {
            itemsIndexed(unique, key = { _, it -> key(it) }) { i, item ->
                itemContent(item, i, { onFocusItem(item) }, { onClick(item) })
            }
        }
    }
}
