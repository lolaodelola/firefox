/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.components.metrics

import io.mockk.coEvery
import io.mockk.mockk
import io.mockk.verify
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Test
import org.mozilla.fenix.distributions.DistributionIdManager
import org.mozilla.fenix.utils.Settings

@OptIn(ExperimentalCoroutinesApi::class)
class MarketingAttributionHandlerTest {
    private val settings: Settings = mockk(relaxed = true)

    @Test
    fun `GIVEN a partnership distribution for which onboarding should be shown WHEN the referrer is null THEN don't show marketing onboarding`() = runTest {
        val mockedDistributionIdManager = mockk<DistributionIdManager> {
            coEvery { isPartnershipDistribution() } returns true
            coEvery { shouldSkipMarketingConsentScreen() } returns false
        }
        val handler = MarketingAttributionHandler(settings, mockedDistributionIdManager, scope = this)

        handler.handleReferrer(null)
        runCurrent()

        verify { settings.shouldShowMarketingOnboarding = false }
    }

    @Test
    fun `GIVEN a partnership distribution for which onboarding should be shown WHEN the referrer is not null THEN show marketing onboarding`() = runTest {
        val mockedDistributionIdManager = mockk<DistributionIdManager>(relaxed = true) {
            coEvery { isPartnershipDistribution() } returns true
            coEvery { shouldSkipMarketingConsentScreen() } returns false
        }
        val handler = MarketingAttributionHandler(settings, mockedDistributionIdManager, scope = this)

        handler.handleReferrer("valid")
        runCurrent()

        verify { settings.shouldShowMarketingOnboarding = true }
    }
}
