/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.trackingprotection

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.tooling.preview.PreviewLightDark
import androidx.compose.ui.unit.dp
import org.mozilla.fenix.R
import org.mozilla.fenix.home.sessioncontrol.TrackingProtectionInteractor
import org.mozilla.fenix.theme.FirefoxTheme

/**
 * A card that displays the number of trackers blocked.
 *
 * @param trackersBlockedCount The number of trackers blocked to display.
 * @param interactor [TrackingProtectionInteractor] for handling interactions.
 * @param modifier Modifier to be applied to the card.
 */
@Composable
fun TrackersBlockedCard(
    trackersBlockedCount: Int,
    interactor: TrackingProtectionInteractor,
    modifier: Modifier = Modifier,
) {
    val shape = RoundedCornerShape(24.dp)
    Row(
        modifier = modifier
            .background(
                color = MaterialTheme.colorScheme.secondaryContainer,
                shape = shape,
            )
            .clip(shape)
            .clickable { interactor.onPrivacyReportTapped() }
            .padding(horizontal = 16.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Image(
            painter = painterResource(R.drawable.firefox_pictorgram_shield_rgb),
            contentDescription = null,
            modifier = Modifier.size(20.dp),
        )

        Text(
            text = if (trackersBlockedCount > 0) {
                pluralStringResource(
                    R.plurals.trackers_blocked_count,
                    trackersBlockedCount,
                    trackersBlockedCount,
                )
            } else {
                stringResource(R.string.trackers_blocked_empty)
            },
            style = FirefoxTheme.typography.body2,
            color = MaterialTheme.colorScheme.onSurface,
        )
    }
}

@PreviewLightDark
@Composable
private fun TrackersBlockedCardPreview() {
    FirefoxTheme {
        TrackersBlockedCard(
            trackersBlockedCount = 754,
            interactor = object : TrackingProtectionInteractor {
                override fun onPrivacyReportTapped() = Unit
            },
        )
    }
}

@PreviewLightDark
@Composable
private fun TrackersBlockedCardEmptyPreview() {
    FirefoxTheme {
        TrackersBlockedCard(
            trackersBlockedCount = 0,
            interactor = object : TrackingProtectionInteractor {
                override fun onPrivacyReportTapped() = Unit
            },
        )
    }
}
