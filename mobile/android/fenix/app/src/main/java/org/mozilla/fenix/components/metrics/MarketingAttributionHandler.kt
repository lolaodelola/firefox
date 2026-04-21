/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.components.metrics

import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import org.mozilla.fenix.distributions.DistributionIdManager
import org.mozilla.fenix.utils.Settings

private const val GCLID_PREFIX = "gclid="
private const val ADJUST_REFTAG_PREFIX = "adjust_reftag="

/**
 * Processes the install referrer response for marketing attribution purposes.
 * Determines whether to show the marketing onboarding card and tracks Meta attribution.
 *
 * @param settings [Settings] object used to persist marketing attribution details.
 * @param distributionIdManager [DistributionIdManager] updated based on marketing attribution details.
 * @param ioDispatcher Coroutine dispatcher for IO operations. Defaults to [Dispatchers.IO].
 * @param scope Coroutine scope to launch coroutines for IO work in. Defaults to a new one using [ioDispatcher].
 */
class MarketingAttributionHandler(
    private val settings: Settings,
    private val distributionIdManager: DistributionIdManager,
    private val ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
    private val scope: CoroutineScope = CoroutineScope(ioDispatcher),
) : InstallReferrerHandler {
    private val marketingPrefixes = listOf(GCLID_PREFIX, ADJUST_REFTAG_PREFIX)

    override fun handleReferrer(installReferrerResponse: String?) {
        scope.launch {
            if (!installReferrerResponse.isNullOrBlank()) {
                val utmParams = UTMParams.parseUTMParameters(installReferrerResponse)

                settings.isUserMetaAttributed = isMetaAttribution(installReferrerResponse)

                distributionIdManager.updateDistributionIdFromUtmParams(utmParams)
                distributionIdManager.startAdjustIfSkippingConsentScreen()
            }

            settings.shouldShowMarketingOnboarding = shouldShowMarketingOnboarding(
                installReferrerResponse,
                distributionIdManager,
            )
        }
    }

    private fun isMetaAttribution(installReferrerResponse: String?): Boolean {
        if (installReferrerResponse.isNullOrBlank()) {
            return false
        }

        val utmParams = UTMParams.parseUTMParameters(installReferrerResponse)
        return MetaParams.extractMetaAttribution(utmParams.content) != null
    }

    private suspend fun shouldShowMarketingOnboarding(
        installReferrerResponse: String?,
        distributionIdManager: DistributionIdManager,
    ): Boolean {
        if (installReferrerResponse.isNullOrBlank()) {
            return false
        }

        if (distributionIdManager.isPartnershipDistribution()) {
            return !distributionIdManager.shouldSkipMarketingConsentScreen()
        }

        return marketingPrefixes.any { installReferrerResponse.startsWith(it, ignoreCase = true) }
    }
}
