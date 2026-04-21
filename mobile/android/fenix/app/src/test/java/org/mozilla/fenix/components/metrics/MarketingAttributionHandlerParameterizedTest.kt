/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.components.metrics

import io.mockk.mockk
import io.mockk.verify
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import mozilla.components.support.test.robolectric.testContext
import mozilla.components.support.utils.ext.packageManagerWrapper
import org.junit.Test
import org.junit.runner.RunWith
import org.mozilla.fenix.components.fake.FakeMetricController
import org.mozilla.fenix.distributions.DistributionBrowserStoreProvider
import org.mozilla.fenix.distributions.DistributionIdManager
import org.mozilla.fenix.distributions.DistributionProviderChecker
import org.mozilla.fenix.distributions.DistributionSettings
import org.mozilla.fenix.utils.Settings
import org.robolectric.ParameterizedRobolectricTestRunner
import org.mozilla.fenix.components.metrics.MarketingAttributionHandlerParameterizedTest.Companion.MarketingAttributionHandlerTestScenario as Scenario

@RunWith(ParameterizedRobolectricTestRunner::class)
class MarketingAttributionHandlerParameterizedTest(private val scenario: Scenario) {
    private var providerValue: String? = null
    private var storedId: String? = null
    private var savedId: String = ""

    private val testDistributionProviderChecker = object : DistributionProviderChecker {
        override suspend fun queryProvider(): String? = providerValue
    }

    private val testBrowserStoreProvider = object : DistributionBrowserStoreProvider {
        override fun getDistributionId(): String? = storedId

        override fun updateDistributionId(id: String) {
            storedId = id
        }
    }

    private val testDistributionSettings = object : DistributionSettings {
        override fun getDistributionId(): String = savedId

        override fun saveDistributionId(id: String) {
            savedId = id
        }

        override fun setMarketingTelemetryPreferences() = Unit
    }

    private val settings: Settings = mockk(relaxed = true)

    private val distributionIdManager = DistributionIdManager(
        packageManager = testContext.packageManagerWrapper,
        testBrowserStoreProvider,
        distributionProviderChecker = testDistributionProviderChecker,
        distributionSettings = testDistributionSettings,
        metricController = FakeMetricController(),
        appPreinstalledOnVivoDevice = { true },
    )

    @Test
    @OptIn(ExperimentalCoroutinesApi::class)
    fun test() = runTest {
        val handler = MarketingAttributionHandler(settings, distributionIdManager, scope = this)

        handler.handleReferrer(scenario.installReferrer)
        runCurrent()

        verify { settings.shouldShowMarketingOnboarding = scenario.shouldShowMarketingOnboarding }
        when (scenario.shouldAttributeInstallToMetaApp) {
            null -> verify(exactly = 0) { settings.isUserMetaAttributed }
            else -> verify { settings.isUserMetaAttributed = scenario.shouldAttributeInstallToMetaApp }
        }
    }

    companion object {
        @JvmStatic
        @ParameterizedRobolectricTestRunner.Parameters(name = "{0}")
        fun scenarios(): List<Scenario> = listOf(
            // Null / blank referrer.
            Scenario(
                installReferrer = null,
                shouldAttributeInstallToMetaApp = null,
                shouldShowMarketingOnboarding = false,
            ),
            Scenario(
                installReferrer = "",
                shouldAttributeInstallToMetaApp = null,
                shouldShowMarketingOnboarding = false,
            ),
            Scenario(
                installReferrer = " ",
                shouldAttributeInstallToMetaApp = null,
                shouldShowMarketingOnboarding = false,
            ),
            // Google Ads (gclid prefix) → marketing onboarding.
            Scenario(
                installReferrer = "gclid=CjwKCAjw&utm_source=google&utm_medium=cpc&utm_campaign=Search_Brand&utm_content=ad_variation_1&utm_term=firefox+browser",
                shouldAttributeInstallToMetaApp = false,
                shouldShowMarketingOnboarding = true,
            ),
            Scenario(
                installReferrer = "gclid=&utm_source=google&utm_medium=cpc&utm_campaign=&utm_content=&utm_term=",
                shouldAttributeInstallToMetaApp = false,
                shouldShowMarketingOnboarding = true,
            ),
            // Adjust (adjust_reftag prefix) → marketing onboarding.
            Scenario(
                installReferrer = "adjust_reftag=abc123&utm_source=adjust&utm_medium=paid&utm_campaign=winter_promo&utm_content=banner_1&utm_term=",
                shouldAttributeInstallToMetaApp = false,
                shouldShowMarketingOnboarding = true,
            ),
            // Organic installs → no marketing, no meta.
            Scenario(
                installReferrer = "utm_source=google-play&utm_medium=organic&utm_campaign=&utm_content=&utm_term=",
                shouldAttributeInstallToMetaApp = false,
                shouldShowMarketingOnboarding = false,
            ),
            Scenario(
                installReferrer = "utm_source=(not%20set)&utm_medium=(not%20set)&utm_campaign=&utm_content=&utm_term=",
                shouldAttributeInstallToMetaApp = false,
                shouldShowMarketingOnboarding = false,
            ),
            Scenario(
                installReferrer = "utm_source=eea-browser-choice&utm_medium=preload&utm_campaign=eea&utm_content=&utm_term=",
                shouldAttributeInstallToMetaApp = false,
                shouldShowMarketingOnboarding = false,
            ),
            // Near-miss prefixes → no marketing.
            Scenario(
                installReferrer = "utm_source=google&utm_medium=cpc&utm_campaign=brand&utm_content=gclid%3D12345&utm_term=",
                shouldAttributeInstallToMetaApp = false,
                shouldShowMarketingOnboarding = false,
            ),
            // Meta attribution (valid JSON in utm_content) → meta, no marketing.
            Scenario(
                installReferrer = """utm_source=apps.facebook.com&utm_medium=paid&utm_campaign=fb_install_campaign&utm_content={"app":12345,"t":1234567890,"source":{"data":"DATA","nonce":"NONCE"}}&utm_term=""",
                shouldAttributeInstallToMetaApp = true,
                shouldShowMarketingOnboarding = false,
            ),
            // Meta missing data → not meta.
            Scenario(
                installReferrer = """utm_source=apps.facebook.com&utm_medium=paid&utm_campaign=fb_campaign&utm_content={"app":12345,"t":1234567890,"source":{"nonce":"NONCE"}}&utm_term=""",
                shouldAttributeInstallToMetaApp = false,
                shouldShowMarketingOnboarding = false,
            ),
            // Meta missing nonce → not meta.
            Scenario(
                installReferrer = """utm_source=apps.facebook.com&utm_medium=paid&utm_campaign=fb_campaign&utm_content={"app":12345,"t":1234567890,"source":{"data":"DATA"}}&utm_term=""",
                shouldAttributeInstallToMetaApp = false,
                shouldShowMarketingOnboarding = false,
            ),
            // Malformed JSON in utm_content → not meta.
            Scenario(
                installReferrer = """utm_source=apps.facebook.com&utm_medium=paid&utm_campaign=fb_campaign&utm_content={"app":12345,"t":1234567890,"source":{"data":"DATA","nonce":"NONCE"}&utm_term=""",
                shouldAttributeInstallToMetaApp = false,
                shouldShowMarketingOnboarding = false,
            ),
            // Non-JSON utm_content → not meta.
            Scenario(
                installReferrer = "utm_source=google&utm_medium=cpc&utm_campaign=brand&utm_content=ad_variation_1&utm_term=firefox",
                shouldAttributeInstallToMetaApp = false,
                shouldShowMarketingOnboarding = false,
            ),
            // RTAMO referrer → not meta, not marketing.
            Scenario(
                installReferrer = "utm_source=addons.mozilla.org&utm_medium=referral&utm_campaign=amo-fx-cta-869140&utm_content=rta%3AezU4YzMyYWM0LTBkNmMtNGQ2Zi1hZTJjLTk2YWFmOGZmY2I2Nn0&utm_term=",
                shouldAttributeInstallToMetaApp = false,
                shouldShowMarketingOnboarding = false,
            ),
        )

        data class MarketingAttributionHandlerTestScenario(
            val installReferrer: String?,
            val shouldAttributeInstallToMetaApp: Boolean?,
            val shouldShowMarketingOnboarding: Boolean,
        )
    }
}
