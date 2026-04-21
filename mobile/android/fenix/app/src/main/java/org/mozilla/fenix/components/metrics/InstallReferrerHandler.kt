/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.components.metrics

/**
 * Handles an install referrer response.
 * Implementations process the raw referrer string to extract and act upon relevant attribution data.
 */
interface InstallReferrerHandler {
    /**
     * Called with the install referrer response when it becomes available, or null on failure.
     */
    fun handleReferrer(installReferrerResponse: String?)
}
