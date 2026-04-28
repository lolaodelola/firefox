/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.search.toolbar

import androidx.navigation.NavController
import androidx.navigation.NavDirections
import io.mockk.every
import io.mockk.mockk
import io.mockk.verify
import org.junit.Before
import org.junit.Test
import org.mozilla.fenix.R

class DefaultSearchSelectorControllerTest {

    private val navController: NavController = mockk(relaxed = true)

    private lateinit var controller: DefaultSearchSelectorController

    @Before
    fun setup() {
        controller = DefaultSearchSelectorController(
            navController = navController,
        )

        every { navController.currentDestination } returns mockk {
            every { id } returns R.id.homeFragment
        }
    }

    @Test
    fun `WHEN the search settings menu item is tapped THEN navigate to search engine settings fragment`() {
        controller.handleMenuItemTapped(SearchSelectorMenu.Item.SearchSettings)

        verify {
            navController.navigate(
                match<NavDirections> { it.actionId == R.id.action_global_searchEngineFragment },
                null,
            )
        }
    }
}
