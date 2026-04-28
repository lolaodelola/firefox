/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.search.toolbar

import android.content.Context
import android.graphics.Bitmap
import androidx.appcompat.view.ContextThemeWrapper
import androidx.core.graphics.createBitmap
import androidx.core.graphics.drawable.toBitmap
import io.mockk.MockKAnnotations
import io.mockk.every
import io.mockk.impl.annotations.RelaxedMockK
import io.mockk.mockk
import io.mockk.mockkConstructor
import io.mockk.spyk
import io.mockk.verify
import mozilla.components.browser.domains.autocomplete.BaseDomainAutocompleteProvider
import mozilla.components.browser.state.search.SearchEngine
import mozilla.components.browser.storage.sync.PlacesBookmarksStorage
import mozilla.components.browser.storage.sync.PlacesHistoryStorage
import mozilla.components.browser.toolbar.BrowserToolbar
import mozilla.components.concept.toolbar.Toolbar
import mozilla.components.feature.awesomebar.provider.SessionAutocompleteProvider
import mozilla.components.feature.syncedtabs.SyncedTabsAutocompleteProvider
import mozilla.components.feature.toolbar.ToolbarAutocompleteFeature
import mozilla.components.support.test.robolectric.testContext
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.mozilla.fenix.R
import org.mozilla.fenix.components.Components
import org.mozilla.fenix.ext.settings
import org.mozilla.fenix.search.SearchEngineSource
import org.mozilla.fenix.search.SearchFragmentState
import org.mozilla.fenix.search.fixtures.EMPTY_SEARCH_FRAGMENT_STATE
import org.mozilla.fenix.utils.Settings
import org.robolectric.RobolectricTestRunner
import mozilla.components.ui.icons.R as iconsR

@RunWith(RobolectricTestRunner::class)
class HomeToolbarViewTest {
    @RelaxedMockK
    private lateinit var interactor: ToolbarInteractor

    private lateinit var context: Context
    private lateinit var toolbar: BrowserToolbar
    private val defaultState: SearchFragmentState = EMPTY_SEARCH_FRAGMENT_STATE.copy(
        searchEngineSource = SearchEngineSource.Default(
            mockk {
                every { name } returns "Search Engine"
                every { icon } returns testContext.getDrawable(iconsR.drawable.mozac_ic_search_24)!!.toBitmap()
                every { type } returns SearchEngine.Type.BUNDLED
                every { isGeneral } returns true
            },
        ),
        showSearchTermHistory = true,
        showHistorySuggestionsForCurrentEngine = true,
        showQrButton = true,
    )

    @Before
    fun setup() {
        MockKAnnotations.init(this)
        context = ContextThemeWrapper(testContext, R.style.NormalTheme)
        every { context.settings() } returns mockk(relaxed = true)
        toolbar = spyk(BrowserToolbar(context))
    }

    @Test
    fun `sets toolbar to normal mode`() {
        buildToolbarView(isPrivate = false)
        assertFalse(toolbar.private)
    }

    @Test
    fun `sets toolbar to private mode`() {
        buildToolbarView(isPrivate = true)
        assertTrue(toolbar.private)
    }

    @Test
    fun `View gets initialized only once`() {
        val view = buildToolbarView(false)
        assertFalse(view.isInitialized)

        view.update(defaultState)
        view.update(defaultState)
        view.update(defaultState)

        verify(exactly = 1) { toolbar.setSearchTerms(any()) }

        assertTrue(view.isInitialized)
    }

    @Test
    fun `search term updates the url`() {
        val view = buildToolbarView(false)

        view.update(defaultState)
        view.update(defaultState)
        view.update(defaultState)

        // editMode gets called when the view is initialized.
        verify(exactly = 2) { toolbar.editMode() }
        // search term changes update the url and invoke the interactor.
        verify(exactly = 2) { toolbar.url = any() }
        verify(exactly = 2) { interactor.onTextChanged(any()) }
    }

    @Test
    fun `GIVEN search term is set WHEN switching to edit mode THEN the cursor is set at the end of the search term`() {
        every { context.settings().shouldShowHistorySuggestions } returns true
        every { context.settings().shouldShowBookmarkSuggestions } returns true
        every { context.settings().shouldAutocompleteInAwesomebar } returns false
        every { context.settings().isTabStripEnabled } returns false
        val view = buildToolbarView(false)

        view.update(defaultState.copy(searchTerms = "search terms"))

        // editMode gets called when the view is initialized.
        verify(exactly = 1) { toolbar.editMode(Toolbar.CursorPlacement.ALL) }
        verify(exactly = 1) { toolbar.editMode(Toolbar.CursorPlacement.END) }
    }

    @Test
    fun `GIVEN no search term is set WHEN switching to edit mode THEN the cursor is set at the end of the search term`() {
        every { context.settings().shouldShowHistorySuggestions } returns true
        every { context.settings().shouldShowBookmarkSuggestions } returns true
        every { context.settings().isTabStripEnabled } returns false
        val view = buildToolbarView(false)

        view.update(defaultState)

        // editMode gets called when the view is initialized.
        verify(exactly = 2) { toolbar.editMode(Toolbar.CursorPlacement.ALL) }
    }

    @Test
    fun `URL gets set to the states query`() {
        val toolbarView = buildToolbarView(false)
        toolbarView.update(defaultState.copy(query = "Query"))

        assertEquals("Query", toolbarView.view.url)
    }

    @Test
    fun `URL gets set to the states pastedText if exists`() {
        val toolbarView = buildToolbarView(false)
        toolbarView.update(defaultState.copy(query = "Query", pastedText = "Pasted"))

        assertEquals("Pasted", toolbarView.view.url)
    }

    @Test
    fun `searchTerms get set if pastedText is null or empty`() {
        val toolbarView = buildToolbarView(false)
        toolbarView.update(defaultState.copy(query = "Query", pastedText = "", searchTerms = "Search Terms"))

        verify { toolbar.setSearchTerms("Search Terms") }
    }

    @Test
    fun `searchTerms don't get set if pastedText has a value`() {
        val toolbarView = buildToolbarView(false)
        toolbarView.update(
            defaultState.copy(query = "Query", pastedText = "PastedText", searchTerms = "Search Terms"),
        )

        verify(exactly = 0) { toolbar.setSearchTerms("Search Terms") }
    }

    @Test
    fun `GIVEN normal browsing mode WHEN the toolbar view is initialized THEN create an autocomplete feature with valid engine`() {
        val toolbarView = buildToolbarView(false)

        val autocompleteFeature = toolbarView.autocompleteFeature

        assertNotNull(autocompleteFeature.engine)
    }

    @Test
    fun `GIVEN normal private mode WHEN the toolbar view is initialized THEN create an autocomplete feature with null engine`() {
        val toolbarView = buildToolbarView(true)

        val autocompleteFeature = toolbarView.autocompleteFeature

        assertNull(autocompleteFeature.engine)
    }

    @Test
    fun `GIVEN autocomplete disabled WHEN the toolbar view is initialized THEN create an autocomplete with disabled functionality`() {
        val settings: Settings = mockk {
            every { shouldAutocompleteInAwesomebar } returns false
            every { isTabStripEnabled } returns false
        }
        val toolbarView = buildToolbarView(true, settings)

        val autocompleteFeature = toolbarView.autocompleteFeature

        assertFalse(autocompleteFeature.shouldAutocomplete())
    }

    @Test
    fun `GIVEN autocomplete enabled WHEN the toolbar view is initialized THEN create an autocomplete with enabled functionality`() {
        val settings: Settings = mockk {
            every { shouldAutocompleteInAwesomebar } returns true
            every { isTabStripEnabled } returns false
        }
        val toolbarView = buildToolbarView(true, settings)

        val autocompleteFeature = toolbarView.autocompleteFeature

        assertTrue(autocompleteFeature.shouldAutocomplete())
    }

    @Test
    fun `GIVEN history suggestions enabled and a new search state with the default search engine source selected WHEN updating the toolbar THEN reconfigure autocomplete suggestions`() {
        mockkConstructor(ToolbarAutocompleteFeature::class) {
            val historyProvider: PlacesHistoryStorage = mockk(relaxed = true)
            val domainsProvider: BaseDomainAutocompleteProvider = mockk(relaxed = true)
            val components: Components = mockk(relaxed = true) {
                every { core.historyStorage } returns historyProvider
                every { core.domainsAutocompleteProvider } returns domainsProvider
            }

            val settings: Settings = mockk(relaxed = true) {
                every { shouldShowHistorySuggestions } returns true
            }
            val toolbarView = buildToolbarView(
                isPrivate = false,
                settings = settings,
                components = components,
            )

            toolbarView.update(defaultState)

            verify {
                toolbarView.autocompleteFeature.updateAutocompleteProviders(
                    providers = listOf(historyProvider, domainsProvider),
                    refreshAutocomplete = true,
                )
            }
        }
    }

    @Test
    fun `GIVEN history suggestions disabled and a new search state with the default search engine source selected WHEN updating the toolbar THEN reconfigure autocomplete suggestions`() {
        mockkConstructor(ToolbarAutocompleteFeature::class) {
            val historyProvider: PlacesHistoryStorage = mockk(relaxed = true)
            val domainsProvider: BaseDomainAutocompleteProvider = mockk(relaxed = true)
            val components: Components = mockk(relaxed = true) {
                every { core.historyStorage } returns historyProvider
                every { core.domainsAutocompleteProvider } returns domainsProvider
            }
            val settings: Settings = mockk(relaxed = true) {
                every { shouldShowHistorySuggestions } returns false
            }
            val toolbarView = buildToolbarView(
                isPrivate = false,
                settings = settings,
                components = components,
            )

            toolbarView.update(defaultState)

            verify {
                toolbarView.autocompleteFeature.updateAutocompleteProviders(
                    providers = listOf(domainsProvider),
                    refreshAutocomplete = true,
                )
            }
        }
    }

    @Test
    fun `GIVEN a new search state with the tabs engine source selected WHEN updating the toolbar THEN reconfigure autocomplete suggestions`() {
        mockkConstructor(ToolbarAutocompleteFeature::class) {
            val localSessionProvider: SessionAutocompleteProvider = mockk(relaxed = true)
            val syncedSessionsProvider: SyncedTabsAutocompleteProvider = mockk(relaxed = true)
            val components: Components = mockk(relaxed = true) {
                every { core.sessionAutocompleteProvider } returns localSessionProvider
                every { backgroundServices.syncedTabsAutocompleteProvider } returns syncedSessionsProvider
            }
            val settings: Settings = mockk(relaxed = true) {
            }
            val toolbarView = buildToolbarView(
                isPrivate = false,
                settings = settings,
                components = components,
            )

            toolbarView.update(defaultState.copy(searchEngineSource = SearchEngineSource.Tabs(fakeSearchEngine)))

            verify {
                toolbarView.autocompleteFeature.updateAutocompleteProviders(
                    providers = listOf(localSessionProvider, syncedSessionsProvider),
                    refreshAutocomplete = true,
                )
            }
        }
    }

    @Test
    fun `GIVEN a new search state with the bookmarks engine source selected WHEN updating the toolbar THEN reconfigure autocomplete suggestions`() {
        mockkConstructor(ToolbarAutocompleteFeature::class) {
            val bookmarksProvider: PlacesBookmarksStorage = mockk(relaxed = true)
            val components: Components = mockk(relaxed = true) {
                every { core.bookmarksStorage } returns bookmarksProvider
            }
            val settings: Settings = mockk(relaxed = true) {
            }
            val toolbarView = buildToolbarView(
                isPrivate = false,
                settings = settings,
                components = components,
            )

            toolbarView.update(defaultState.copy(searchEngineSource = SearchEngineSource.Bookmarks(fakeSearchEngine)))

            verify {
                toolbarView.autocompleteFeature.updateAutocompleteProviders(
                    providers = listOf(bookmarksProvider),
                    refreshAutocomplete = true,
                )
            }
        }
    }

    @Test
    fun `GIVEN a new search state with the history engine source selected WHEN updating the toolbar THEN reconfigure autocomplete suggestions`() {
        mockkConstructor(ToolbarAutocompleteFeature::class) {
            val historyProvider: PlacesHistoryStorage = mockk(relaxed = true)
            val components: Components = mockk(relaxed = true) {
                every { core.historyStorage } returns historyProvider
            }
            val settings: Settings = mockk(relaxed = true) {
            }
            val toolbarView = buildToolbarView(
                isPrivate = false,
                settings = settings,
                components = components,
            )

            toolbarView.update(defaultState.copy(searchEngineSource = SearchEngineSource.History(fakeSearchEngine)))

            verify {
                toolbarView.autocompleteFeature.updateAutocompleteProviders(
                    providers = listOf(historyProvider),
                    refreshAutocomplete = true,
                )
            }
        }
    }

    @Test
    fun `GIVEN a new search state with no engine source selected WHEN updating the toolbar THEN reconfigure autocomplete suggestions`() {
        mockkConstructor(ToolbarAutocompleteFeature::class) {
            val settings: Settings = mockk(relaxed = true) {
            }
            val toolbarView = buildToolbarView(
                false,
                settings = settings,
            )

            toolbarView.update(defaultState.copy(searchEngineSource = SearchEngineSource.None))

            verify {
                toolbarView.autocompleteFeature.updateAutocompleteProviders(
                    providers = emptyList(),
                    refreshAutocomplete = true,
                )
            }
        }
    }

    @Test
    fun `GIVEN a new search state with a shortcut engine source selected WHEN updating the toolbar THEN reconfigure autocomplete suggestions`() {
        mockkConstructor(ToolbarAutocompleteFeature::class) {
            val settings: Settings = mockk(relaxed = true) {
            }
            val toolbarView = buildToolbarView(
                isPrivate = false,
                settings = settings,
            )

            toolbarView.update(defaultState.copy(searchEngineSource = SearchEngineSource.Shortcut(fakeSearchEngine)))

            verify {
                toolbarView.autocompleteFeature.updateAutocompleteProviders(
                    providers = emptyList(),
                    refreshAutocomplete = true,
                )
            }
        }
    }

    @Test
    fun `GIVEN show bookmark suggestions is enabled WHEN the toolbar view is initialized THEN add bookmark storage to autocomplete providers`() {
        mockkConstructor(ToolbarAutocompleteFeature::class) {
            val historyProvider: PlacesHistoryStorage = mockk(relaxed = true)
            val bookmarksStorage: PlacesBookmarksStorage = mockk(relaxed = true)
            val domainsProvider: BaseDomainAutocompleteProvider = mockk(relaxed = true)
            val components: Components = mockk(relaxed = true) {
                every { core.historyStorage } returns historyProvider
                every { core.domainsAutocompleteProvider } returns domainsProvider
                every { core.bookmarksStorage } returns bookmarksStorage
            }

            val settings: Settings = mockk(relaxed = true) {
                every { shouldShowHistorySuggestions } returns true
                every { shouldShowBookmarkSuggestions } returns true
            }
            val toolbarView = buildToolbarView(
                isPrivate = false,
                settings = settings,
                components = components,
            )

            toolbarView.update(defaultState)

            verify {
                toolbarView.autocompleteFeature.updateAutocompleteProviders(
                    providers = listOf(historyProvider, bookmarksStorage, domainsProvider),
                    refreshAutocomplete = true,
                )
            }
        }
    }

    @Test
    fun `GIVEN show bookmark suggestions is disabled WHEN the toolbar view is initialized THEN don't add bookmark storage to autocomplete providers`() {
        mockkConstructor(ToolbarAutocompleteFeature::class) {
            val historyProvider: PlacesHistoryStorage = mockk(relaxed = true)
            val bookmarksStorage: PlacesBookmarksStorage = mockk(relaxed = true)
            val domainsProvider: BaseDomainAutocompleteProvider = mockk(relaxed = true)
            val components: Components = mockk(relaxed = true) {
                every { core.historyStorage } returns historyProvider
                every { core.domainsAutocompleteProvider } returns domainsProvider
                every { core.bookmarksStorage } returns bookmarksStorage
            }

            val settings: Settings = mockk(relaxed = true) {
                every { shouldShowHistorySuggestions } returns true
                every { shouldShowBookmarkSuggestions } returns false
            }
            val toolbarView = buildToolbarView(
                isPrivate = false,
                settings = settings,
                components = components,
            )

            toolbarView.update(defaultState)

            verify {
                toolbarView.autocompleteFeature.updateAutocompleteProviders(
                    providers = listOf(historyProvider, domainsProvider),
                    refreshAutocomplete = true,
                )
            }
        }
    }

    private fun buildToolbarView(
        isPrivate: Boolean,
        settings: Settings = context.settings(),
        components: Components = mockk(relaxed = true),
    ) = ToolbarView(
        settings = settings,
        components = components,
        interactor = interactor,
        isPrivate = isPrivate,
        view = toolbar,
        fromHomeFragment = false,
    )
}

/**
 * Get a fake [SearchEngine] to use where a simple mock won't suffice.
 */
private val fakeSearchEngine = SearchEngine(
    id = "fakeId",
    name = "fakeName",
    icon = createBitmap(1, 1, Bitmap.Config.ALPHA_8),
    type = SearchEngine.Type.CUSTOM,
    resultUrls = emptyList(),
)
