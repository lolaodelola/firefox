/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.tabstray.redux.reducer

import org.mozilla.fenix.tabstray.data.TabsTrayItem
import org.mozilla.fenix.tabstray.navigation.TabManagerNavDestination
import org.mozilla.fenix.tabstray.navigation.TabManagerNavDestination.DeleteTabGroupConfirmationDialog
import org.mozilla.fenix.tabstray.navigation.TabManagerNavDestination.ExpandedTabGroup
import org.mozilla.fenix.tabstray.redux.action.TabGroupAction
import org.mozilla.fenix.tabstray.redux.state.TabsTrayState
import org.mozilla.fenix.tabstray.redux.state.initializeTabGroupForm

/**
 * Reducer for [TabGroupAction] dispatched from the Tabs Tray store.
 */
object TabGroupActionReducer {

    /**
     * Reduces [TabGroupAction] into a new [TabsTrayState].
     *
     * @param state The current [TabsTrayState].
     * @param action The [TabGroupAction] to reduce.
     */
    fun reduce(
        state: TabsTrayState,
        action: TabGroupAction,
    ): TabsTrayState {
        return when (action) {
            is TabGroupAction.AddToTabGroup -> if (state.tabGroups.isEmpty()) {
                state.navigateToEditTabGroup()
            } else {
                state.copy(backStack = state.backStack + TabManagerNavDestination.AddToTabGroup)
            }

            is TabGroupAction.AddToNewTabGroup -> state.navigateToEditTabGroup()

            is TabGroupAction.NameChanged -> {
                val form = requireNotNull(state.tabGroupFormState) {
                    "NameChanged dispatched with no TabGroupFormState"
                }
                state.copy(
                    tabGroupFormState = form.copy(
                        name = action.name,
                        edited = true,
                    ),
                )
            }

            is TabGroupAction.ThemeChanged -> {
                val form = requireNotNull(state.tabGroupFormState) {
                    "ThemeChanged dispatched with no TabGroupFormState"
                }
                state.copy(
                    tabGroupFormState = form.copy(
                        theme = action.theme,
                        edited = true,
                    ),
                )
            }

            TabGroupAction.FormDismissed -> state.copy(
                tabGroupFormState = null,
                backStack = state.backStack.popTabGroupFlow(),
            )

            is TabGroupAction.SaveClicked -> state.copy(
                mode = TabsTrayState.Mode.Normal,
                backStack = state.backStack.popTabGroupFlow(),
            )

            is TabGroupAction.TabGroupClicked -> when (state.mode) {
                is TabsTrayState.Mode.Normal -> state.copy(
                    backStack = state.backStack + ExpandedTabGroup(group = action.group),
                )

                is TabsTrayState.Mode.Select -> state
            }

            is TabGroupAction.TabAddedToGroup -> state

            is TabGroupAction.TabsAddedToGroup -> state.copy(
                mode = TabsTrayState.Mode.Normal,
                backStack = state.backStack.popTabGroupFlow(),
            )

            is TabGroupAction.DeleteClicked -> state.copy(
                backStack = state.backStack + DeleteTabGroupConfirmationDialog(group = action.group),
            )

            is TabGroupAction.DeleteConfirmed -> state.copy(
                backStack = state.backStack.popDeleteTabGroupFlow(action.group),
            )
        }
    }

    private fun TabsTrayState.navigateToEditTabGroup() = copy(
        tabGroupFormState = initializeTabGroupForm(),
        backStack = backStack + TabManagerNavDestination.EditTabGroup,
    )

    private fun List<TabManagerNavDestination>.popTabGroupFlow(): List<TabManagerNavDestination> {
        var stack = this

        // Return the back stack to the destination that originally invoked the below destinations
        while (stack.size > 1 && stack.last() in setOf(
                TabManagerNavDestination.EditTabGroup,
                TabManagerNavDestination.AddToTabGroup,
            )
        ) {
            stack = stack.dropLast(1)
        }
        return stack
    }

    private fun List<TabManagerNavDestination>.popDeleteTabGroupFlow(
        group: TabsTrayItem.TabGroup,
    ): List<TabManagerNavDestination> {
        var stack = this

        while (stack.size > 1 && stack.last() in setOf(
                DeleteTabGroupConfirmationDialog(group = group),
                ExpandedTabGroup(group = group),
            )
        ) {
            stack = stack.dropLast(1)
        }

        return stack
    }
}
