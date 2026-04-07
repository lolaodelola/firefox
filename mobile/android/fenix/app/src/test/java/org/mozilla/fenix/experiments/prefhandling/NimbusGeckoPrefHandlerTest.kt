/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.experiments.prefhandling

import android.os.Looper
import androidx.test.ext.junit.runners.AndroidJUnit4
import io.mockk.every
import io.mockk.mockk
import io.mockk.slot
import io.mockk.verify
import junit.framework.TestCase.assertEquals
import junit.framework.TestCase.assertNotNull
import junit.framework.TestCase.assertNull
import junit.framework.TestCase.assertTrue
import kotlinx.coroutines.runBlocking
import mozilla.components.ExperimentalAndroidComponentsApi
import mozilla.components.concept.engine.Engine
import mozilla.components.concept.engine.preferences.BrowserPrefType
import mozilla.components.concept.engine.preferences.BrowserPreference
import mozilla.components.service.nimbus.NimbusApi
import org.junit.Assert
import org.junit.Test
import org.junit.runner.RunWith
import org.mozilla.experiments.nimbus.internal.GeckoPref
import org.mozilla.experiments.nimbus.internal.GeckoPrefState
import org.mozilla.experiments.nimbus.internal.OriginalGeckoPref
import org.mozilla.experiments.nimbus.internal.PrefBranch
import org.mozilla.experiments.nimbus.internal.PrefEnrollmentData
import org.mozilla.experiments.nimbus.internal.PrefUnenrollReason
import org.robolectric.Shadows.shadowOf

const val TEST_PREF = "gecko.nimbus.test"
const val SECOND_TEST_PREF = "gecko.nimbus.test.two"

@OptIn(ExperimentalAndroidComponentsApi::class)
@RunWith(AndroidJUnit4::class)
class NimbusGeckoPrefHandlerTest {

    private val mockNimbusApi = mockk<NimbusApi>(relaxed = true)
    private val mockEngine = mockk<Engine>(relaxed = true)

    private fun makeHandler(
        engine: Engine = mockEngine,
        nimbusApi: NimbusApi = mockNimbusApi,
    ) = NimbusGeckoPrefHandler(lazy { engine }, lazy { nimbusApi })

    @Test
    fun `test nimbusGeckoPreferences has appropriate values`() {
        val handler = makeHandler()
        assertNotNull(handler.nimbusGeckoPreferences["gecko-nimbus-validation"])
        assertNotNull(
            handler.nimbusGeckoPreferences["gecko-nimbus-validation"]?.get(
                "test-preference",
            ),
        )
        assertNotNull(
            handler.nimbusGeckoPreferences["gecko-nimbus-validation"]?.get(
                "test-preference-2",
            ),
        )
    }

    @Test
    fun `preferenceList has appropriate values`() {
        val handler = makeHandler()
        assertTrue(handler.preferenceList.containsAll(listOf(TEST_PREF, SECOND_TEST_PREF)))
    }

    @Test
    fun `WHEN getPreferenceStateFromGecko is successful THEN getBrowserPrefs is called AND it returns true`() {
        val mockPrefResult =
            listOf(
                BrowserPreference(
                pref = TEST_PREF,
                defaultValue = "testValue",
                hasUserChangedValue = false,
                prefType = BrowserPrefType.STRING,
            ),
            )
        mockEngine.apply {
            every { getBrowserPrefs(any(), any(), any()) } answers {
                val onSuccess = secondArg<(List<BrowserPreference<*>>) -> Unit>()
                onSuccess(mockPrefResult)
            }
        }
        val handler = makeHandler()
        assertEquals(null, handler.getPreferenceState(TEST_PREF)?.geckoValue)

        val result = handler.getPreferenceStateFromGecko()
        shadowOf(Looper.getMainLooper()).idle()
        verify { mockEngine.getBrowserPrefs(any(), any(), any()) }
        assertTrue(runBlocking { result.await() })

        assertEquals(mockPrefResult[0].defaultValue, handler.getPreferenceState(TEST_PREF)?.geckoValue)
        assertEquals(mockPrefResult[0].prefType, handler.preferenceTypes[TEST_PREF])
    }

    @Test
    fun `WHEN getPreferenceStateFromGecko is fails THEN getBrowserPrefs is called AND it returns false`() {
        every { mockEngine.getBrowserPrefs(any(), any(), any()) } answers {
            val onError = thirdArg<(Throwable) -> Unit>()
            onError(Throwable("error"))
        }

        val handler = makeHandler(engine = mockEngine)
        val result = handler.getPreferenceStateFromGecko()
        shadowOf(Looper.getMainLooper()).idle()

        Assert.assertFalse(runBlocking { result.await() })
        verify { mockEngine.getBrowserPrefs(any(), any(), any()) }
        assertEquals(null, handler.getPreferenceState(TEST_PREF)?.geckoValue)
    }

    @Test
    fun `WHEN setGeckoPrefsState is successful THEN setBrowserPrefs is called`() {
        val handler = makeHandler(engine = mockEngine)
        handler.start()
        handler.preferenceTypes[TEST_PREF] = BrowserPrefType.STRING

        val prefState = GeckoPrefState(
            geckoPref = GeckoPref(pref = TEST_PREF, branch = PrefBranch.USER),
            geckoValue = null,
            enrollmentValue = PrefEnrollmentData(
                experimentSlug = "test-experiment",
                prefValue = "test-value",
                featureId = "gecko-nimbus-validation",
                variable = "test-preference",
            ),
            isUserSet = false,
        )
        every { mockEngine.getBrowserPrefs(any(), any(), any()) } answers {
            val onSuccess = secondArg<(List<BrowserPreference<*>>) -> Unit>()
            onSuccess(listOf(BrowserPreference<String>(pref = TEST_PREF, defaultValue = "original-value", hasUserChangedValue = false, prefType = BrowserPrefType.STRING)))
        }
        every { mockEngine.setBrowserPrefs(any(), any(), any()) } answers {
            val onSuccess = secondArg<(Map<String, Boolean>) -> Unit>()
            onSuccess(mapOf(TEST_PREF to true))
        }

        handler.setGeckoPrefsState(listOf(prefState))
        shadowOf(Looper.getMainLooper()).idle()

        verify { mockEngine.setBrowserPrefs(any(), any(), any()) }
    }

    @Test
    fun `WHEN setGeckoPrefsState fails THEN the item is unenrolled`() {
        val handler = makeHandler(engine = mockEngine)
        handler.start()
        handler.preferenceTypes[TEST_PREF] = BrowserPrefType.STRING

        val prefState = GeckoPrefState(
            geckoPref = GeckoPref(pref = TEST_PREF, branch = PrefBranch.USER),
            geckoValue = null,
            enrollmentValue = PrefEnrollmentData(
                experimentSlug = "test-experiment",
                prefValue = "test-value",
                featureId = "gecko-nimbus-validation",
                variable = "test-preference",
            ),
            isUserSet = false,
        )
        every { mockEngine.getBrowserPrefs(any(), any(), any()) } answers {
            val onSuccess = secondArg<(List<BrowserPreference<*>>) -> Unit>()
            onSuccess(listOf(BrowserPreference<String>(pref = TEST_PREF, defaultValue = "original-value", hasUserChangedValue = false, prefType = BrowserPrefType.STRING)))
        }
        every { mockEngine.setBrowserPrefs(any(), any(), any()) } answers {
            val onSuccess = secondArg<(Map<String, Boolean>) -> Unit>()
            // Failed to set
            onSuccess(mapOf(TEST_PREF to false))
        }

        val capturedPrefState = slot<GeckoPrefState>()
        val capturedReason = slot<PrefUnenrollReason>()
        every { mockNimbusApi.unenrollForGeckoPref(capture(capturedPrefState), capture(capturedReason)) } returns emptyList()

        handler.setGeckoPrefsState(listOf(prefState))
        shadowOf(Looper.getMainLooper()).idle()

        verify { mockEngine.unregisterPrefsForObservation(match { it.containsAll(listOf(TEST_PREF, SECOND_TEST_PREF)) }, any(), any()) }
        verify { mockNimbusApi.unenrollForGeckoPref(any(), any()) }

        assertEquals(TEST_PREF, capturedPrefState.captured.prefString())
        assertEquals(PrefUnenrollReason.FAILED_TO_SET, capturedReason.captured)
    }

    @Test
    fun `WHEN setGeckoPrefsState cannot make a setter THEN the item is unenrolled`() {
        val handler = makeHandler(engine = mockEngine)
        handler.start()
        handler.preferenceTypes[TEST_PREF] = BrowserPrefType.STRING
        // Cannot make a setter when there is no enrollmentValue
        val prefState = GeckoPrefState(
            geckoPref = GeckoPref(pref = TEST_PREF, branch = PrefBranch.USER),
            geckoValue = null,
            enrollmentValue = null,
            isUserSet = false,
        )

        every { mockEngine.getBrowserPrefs(any(), any(), any()) } answers {
            val onSuccess = secondArg<(List<BrowserPreference<*>>) -> Unit>()
            onSuccess(listOf(BrowserPreference<String>(pref = TEST_PREF, defaultValue = "original-value", hasUserChangedValue = false, prefType = BrowserPrefType.STRING)))
        }
        every { mockEngine.setBrowserPrefs(any(), any(), any()) } answers {
            val onSuccess = secondArg<(Map<String, Boolean>) -> Unit>()
            // No other valid items to set
            onSuccess(emptyMap())
        }

        val capturedPrefState = slot<GeckoPrefState>()
        val capturedReason = slot<PrefUnenrollReason>()
        every { mockNimbusApi.unenrollForGeckoPref(capture(capturedPrefState), capture(capturedReason)) } returns emptyList()

        handler.setGeckoPrefsState(listOf(prefState))
        shadowOf(Looper.getMainLooper()).idle()

        verify { mockEngine.unregisterPrefsForObservation(match { it.containsAll(listOf(TEST_PREF, SECOND_TEST_PREF)) }, any(), any()) }
        verify { mockNimbusApi.unenrollForGeckoPref(any(), any()) }

        assertEquals(TEST_PREF, capturedPrefState.captured.prefString())
        assertEquals(PrefUnenrollReason.FAILED_TO_SET, capturedReason.captured)
    }

    @Test
    fun `WHEN setGeckoPrefsOriginalValues is successful on a known value THEN setBrowserPrefs is called`() {
        val handler = makeHandler(engine = mockEngine)
        handler.preferenceTypes[TEST_PREF] = BrowserPrefType.STRING
        val originalPref = OriginalGeckoPref(
            pref = TEST_PREF,
            branch = PrefBranch.USER,
            value = "original-value",
        )
        every { mockEngine.setBrowserPrefs(any(), any(), any()) } answers {
            val onSuccess = secondArg<(Map<String, Boolean>) -> Unit>()
            onSuccess(mapOf(TEST_PREF to true))
        }

        handler.setGeckoPrefsOriginalValues(listOf(originalPref))
        shadowOf(Looper.getMainLooper()).idle()

        verify { mockEngine.setBrowserPrefs(any(), any(), any()) }
    }

    @Test
    fun `WHEN setGeckoPrefsOriginalValues is successful on an unknown value THEN clearBrowserUserPref is called`() {
        val handler = makeHandler(engine = mockEngine)
        val originalPref = OriginalGeckoPref(
            pref = TEST_PREF,
            branch = PrefBranch.USER,
            value = null,
        )
        handler.preferenceTypes[TEST_PREF] = BrowserPrefType.STRING

        every { mockEngine.setBrowserPrefs(any(), any(), any()) } answers {
            val onSuccess = secondArg<(Map<String, Boolean>) -> Unit>()
            onSuccess(emptyMap())
        }
        every { mockEngine.clearBrowserUserPref(any(), any(), any()) } answers {
            val onSuccess = secondArg<() -> Unit>()
            onSuccess()
        }

        handler.setGeckoPrefsOriginalValues(listOf(originalPref))
        shadowOf(Looper.getMainLooper()).idle()

        verify { mockEngine.clearBrowserUserPref(eq(TEST_PREF), any(), any()) }
    }

    @Test
    fun `WHEN getSetterPairsFromOriginalGeckoPrefs is called THEN the correct list is formed`() {
        val handler = makeHandler(engine = mockEngine)
        handler.preferenceTypes[TEST_PREF] = BrowserPrefType.STRING
        val otherPref = "gecko.nimbus.other"
        val prefWithValue = OriginalGeckoPref(pref = TEST_PREF, branch = PrefBranch.USER, value = "original")
        val prefWithoutValue = OriginalGeckoPref(pref = otherPref, branch = PrefBranch.USER, value = null)
        handler.preferenceTypes[TEST_PREF] = BrowserPrefType.STRING
        handler.preferenceTypes[otherPref] = BrowserPrefType.STRING

        every { mockEngine.setBrowserPrefs(any(), any(), any()) } answers {
            val onSuccess = secondArg<(Map<String, Boolean>) -> Unit>()
            onSuccess(mapOf(TEST_PREF to true))
        }
        every { mockEngine.clearBrowserUserPref(any(), any(), any()) } answers {
            val onSuccess = secondArg<() -> Unit>()
            onSuccess()
        }

        handler.setGeckoPrefsOriginalValues(listOf(prefWithValue, prefWithoutValue))
        shadowOf(Looper.getMainLooper()).idle()

        verify { mockEngine.setBrowserPrefs(any(), any(), any()) }
        verify { mockEngine.clearBrowserUserPref(eq(otherPref), any(), any()) }
    }

    @Test
    fun `WHEN onPreferenceChange is called THEN unenrollForGeckoPref is called`() {
        val handler = makeHandler()
        handler.start()

        handler.onPreferenceChange(
            BrowserPreference<String>(pref = TEST_PREF, hasUserChangedValue = false, prefType = BrowserPrefType.STRING),
        )

        verify { mockEngine.unregisterPrefsForObservation(match { it.containsAll(listOf(TEST_PREF, SECOND_TEST_PREF)) }, any(), any()) }
        verify { mockNimbusApi.unenrollForGeckoPref(any(), eq(PrefUnenrollReason.CHANGED)) }
    }

        @Test
    fun `WHEN setGeckoPrefsState is called with prefs not in preferenceTypes THEN getBrowserPrefs is called and preferenceTypes is populated`() {
        val handler = makeHandler(engine = mockEngine)

        every { mockEngine.getBrowserPrefs(any(), any(), any()) } answers {
            val onSuccess = secondArg<(List<BrowserPreference<*>>) -> Unit>()
            onSuccess(listOf(BrowserPreference<String>(pref = TEST_PREF, hasUserChangedValue = false, prefType = BrowserPrefType.STRING)))
        }
        every { mockEngine.setBrowserPrefs(any(), any(), any()) } answers {
            val onSuccess = secondArg<(Map<String, Boolean>) -> Unit>()
            onSuccess(emptyMap())
        }

        val prefState = GeckoPrefState(
            geckoPref = GeckoPref(pref = TEST_PREF, branch = PrefBranch.USER),
            geckoValue = null,
            enrollmentValue = PrefEnrollmentData(
                experimentSlug = "test-experiment",
                prefValue = "test-value",
                featureId = "gecko-nimbus-validation",
                variable = "test-preference",
            ),
            isUserSet = false,
        )

        handler.setGeckoPrefsState(listOf(prefState))
        shadowOf(Looper.getMainLooper()).idle()

        verify { mockEngine.getBrowserPrefs(any(), any(), any()) }
        assertEquals(BrowserPrefType.STRING, handler.preferenceTypes[TEST_PREF])
    }

    @Test
    fun `WHEN handleErrors is called with errors from the same multi-pref experiment THEN unenrollForGeckoPref is only called once`() {
        val handler = makeHandler()
        handler.enrollmentErrors.add(
            Pair(
                GeckoPrefState(geckoPref = GeckoPref(pref = TEST_PREF, branch = PrefBranch.DEFAULT), geckoValue = null, enrollmentValue = null, isUserSet = false),
                null,
            ),
        )
        handler.enrollmentErrors.add(
            Pair(
                GeckoPrefState(geckoPref = GeckoPref(pref = SECOND_TEST_PREF, branch = PrefBranch.DEFAULT), geckoValue = null, enrollmentValue = null, isUserSet = false),
                null,
            ),
        )

        handler.handleErrors()

        verify(exactly = 1) { mockNimbusApi.unenrollForGeckoPref(any(), eq(PrefUnenrollReason.FAILED_TO_SET)) }
    }

    @Test
    fun `WHEN getPreferenceStateFromGecko is called twice concurrently with different preferenceList THEN getBrowserPrefs is called twice`() {
        // getBrowserPrefs never calls onSuccess, leaving the first fetch in-flight
        val capturedPrefs = mutableListOf<List<String>>()
        every { mockEngine.getBrowserPrefs(any(), any(), any()) } answers { capturedPrefs.add(firstArg()) }

        val handler = makeHandler()
        handler.getPreferenceStateFromGecko()

        // First request is now in-flight
        shadowOf(Looper.getMainLooper()).idle()

        // Change the pref list to simulate a different set of prefs being requested
        handler.preferenceList = listOf("browser.some.other.pref")
        handler.getPreferenceStateFromGecko()

        shadowOf(Looper.getMainLooper()).idle()

        // Checking that the engine received two distinct requests
        verify(exactly = 2) { mockEngine.getBrowserPrefs(any(), any(), any()) }
        assertEquals(2, capturedPrefs[0].size)
        assertTrue(capturedPrefs[0].containsAll(listOf(TEST_PREF, SECOND_TEST_PREF)))
        assertEquals(listOf("browser.some.other.pref"), capturedPrefs[1])
    }

    @Test
    fun `WHEN getPreferenceStateFromGecko is called twice concurrently THEN getBrowserPrefs is only called once and both results are true`() {
        var pendingOnSuccess: ((List<BrowserPreference<*>>) -> Unit)? = null
        every { mockEngine.getBrowserPrefs(any(), any(), any()) } answers {
            pendingOnSuccess = secondArg()
        }

        val handler = makeHandler()
        val result1 = handler.getPreferenceStateFromGecko()
        val result2 = handler.getPreferenceStateFromGecko()

        shadowOf(Looper.getMainLooper()).idle()

        assertNotNull(handler.fetchingGeckoPrefState)

        // Both should have shared the same fetch request
        verify(exactly = 1) { mockEngine.getBrowserPrefs(any(), any(), any()) }
        assertEquals(handler.preferenceList, handler.fetchingGeckoPrefState!!.first)

        // Deliver the Gecko response
        pendingOnSuccess!!(
            listOf(
                BrowserPreference(
                    pref = TEST_PREF,
                    defaultValue = "value",
                    hasUserChangedValue = false,
                    prefType = BrowserPrefType.STRING,
                ),
            ),
        )
        shadowOf(Looper.getMainLooper()).idle()

        assertNull(handler.fetchingGeckoPrefState)
        assertTrue(runBlocking { result1.await() })
        assertTrue(runBlocking { result2.await() })
    }

    @Test
    fun `WHEN allExperimentPrefs is called with an unknown pref THEN only that pref is returned`() {
        val unknownPref = "some.unknown.pref"
        val handler = makeHandler()
        val prefState = GeckoPrefState(
            geckoPref = GeckoPref(pref = unknownPref, branch = PrefBranch.DEFAULT),
            geckoValue = null,
            enrollmentValue = null,
            isUserSet = false,
        )

        assertEquals(listOf(unknownPref), handler.allExperimentPrefs(prefState))
    }

    @Test
    fun `WHEN allExperimentPrefs is called with a pref in a multi-pref feature THEN all prefs in the feature are returned`() {
        val handler = makeHandler()
        val prefState = GeckoPrefState(
            geckoPref = GeckoPref(pref = TEST_PREF, branch = PrefBranch.DEFAULT),
            geckoValue = null,
            enrollmentValue = null,
            isUserSet = false,
        )

        val result = handler.allExperimentPrefs(prefState)

        assertEquals(2, result.size)
        assertTrue(result.containsAll(listOf(TEST_PREF, SECOND_TEST_PREF)))
    }
}
