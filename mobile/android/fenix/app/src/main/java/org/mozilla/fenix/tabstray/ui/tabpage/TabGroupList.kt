/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.tabstray.ui.tabpage

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.tooling.preview.Preview
import mozilla.components.browser.state.state.createTab
import org.mozilla.fenix.tabgroups.TabGroupRow
import org.mozilla.fenix.tabstray.data.TabGroupTheme
import org.mozilla.fenix.tabstray.data.TabsTrayItem
import org.mozilla.fenix.tabstray.ui.tabitems.TabGroupMenuButton
import org.mozilla.fenix.tabstray.ui.tabitems.TabListBorderMiddleItemShape
import org.mozilla.fenix.tabstray.ui.tabitems.TabListFirstItemShape
import org.mozilla.fenix.tabstray.ui.tabitems.TabListLastItemShape
import org.mozilla.fenix.tabstray.ui.tabitems.TabListSingleItemShape
import org.mozilla.fenix.theme.FirefoxTheme

/**
 * Top-level UI for displaying a list of tab groups.
 *
 * @param groups The list of tab groups to display.
 * @param modifier: The Modifier applied to the tab group list.
 * @param onDeleteTabGroup Invoked when the user clicks on delete tab group.
 * @param editTabGroupClick Invoked when the user clicks to edit the tab group.
 */
@Composable
fun TabGroupList(
    groups: List<TabsTrayItem.TabGroup>,
    modifier: Modifier = Modifier,
    onDeleteTabGroup: (TabsTrayItem.TabGroup) -> Unit,
    editTabGroupClick: (TabsTrayItem.TabGroup) -> Unit,
) {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.surface),
        contentAlignment = Alignment.TopCenter,
    ) {
        LazyColumn(
            modifier = modifier
                .width(FirefoxTheme.layout.size.containerMaxWidth)
                .padding(
                    start = FirefoxTheme.layout.space.dynamic200,
                    top = FirefoxTheme.layout.space.dynamic200,
                    end = FirefoxTheme.layout.space.dynamic200,
                ),
        ) {
            itemsIndexed(
                items = groups,
                key = { _, group -> group.id },
            ) { index, group ->
                val itemShape = when {
                    groups.size == 1 -> TabListSingleItemShape
                    index == 0 -> TabListFirstItemShape
                    index == groups.lastIndex -> TabListLastItemShape
                    else -> TabListBorderMiddleItemShape
                }

                TabGroupRow(
                    tabGroup = group,
                    onClick = {
                        // Bug 2033481
                    },
                    modifier = Modifier
                        .clip(itemShape)
                        .background(MaterialTheme.colorScheme.surfaceContainerLowest),
                    trailingContent = {
                        CompositionLocalProvider(
                            LocalContentColor provides MaterialTheme.colorScheme.secondary,
                        ) {
                            TabGroupMenuButton(
                                onDeleteTabGroup = { onDeleteTabGroup(group) },
                                editTabGroupClick = { editTabGroupClick(group) },
                            )
                        }
                    },
                )

                if (index != groups.lastIndex) {
                    HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                }
            }
        }
    }
}

@Preview(showBackground = true)
@Composable
private fun TabGroupListPreview() {
    val firstGroupTabs = mutableListOf(
        TabsTrayItem.Tab(createTab(url = "https://www.mozilla.org")),
        TabsTrayItem.Tab(createTab(url = "https://www.mozilla.org/en-US")),
        TabsTrayItem.Tab(createTab(url = "https://www.firefox.com")),
    )
    val secondGroupTabs = mutableListOf(
        TabsTrayItem.Tab(createTab(url = "https://www.google.com")),
    )

    FirefoxTheme {
        TabGroupList(
            groups = listOf(
                TabsTrayItem.TabGroup(
                    title = "Work",
                    theme = TabGroupTheme.Blue,
                    tabs = firstGroupTabs,
                ),
                TabsTrayItem.TabGroup(
                    title = "Search",
                    theme = TabGroupTheme.Purple,
                    tabs = secondGroupTabs,
                ),
            ),
            onDeleteTabGroup = {},
            editTabGroupClick = {},
        )
    }
}
