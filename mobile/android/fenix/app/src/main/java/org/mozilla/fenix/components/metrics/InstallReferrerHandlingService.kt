/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.components.metrics

import android.content.Context
import android.os.RemoteException
import androidx.annotation.VisibleForTesting
import com.android.installreferrer.api.InstallReferrerClient
import com.android.installreferrer.api.InstallReferrerStateListener
import mozilla.components.support.base.log.logger.Logger

/**
 * A service that fetches the install referrer information and delegates [handlers]
 * for acting upon this.
 *
 * This should be only used when user has not gone through the onboarding flow.
 *
 * @param context The application context.
 * @param handlers The list of handlers that will process the install referrer response.
 */
class InstallReferrerHandlingService(
    private val context: Context,
    private val handlers: List<InstallReferrerHandler> = emptyList(),
) {
    private val logger = Logger("InstallReferrerHandlingService")

    @VisibleForTesting
    internal var referrerClient: InstallReferrerClientWrapper? = null
        private set

    @VisibleForTesting
    internal var clientFactory: (Context) -> InstallReferrerClientWrapper = ::DefaultInstallReferrerClient

    /**
     * Starts the connection with the install referrer and dispatches the response to all handlers.
     */
    fun start() {
        val client = clientFactory(context)
        referrerClient = client

        client.startConnection(
            object : InstallReferrerStateListener {
                override fun onInstallReferrerSetupFinished(responseCode: Int) {
                    when (responseCode) {
                        InstallReferrerClient.InstallReferrerResponse.OK -> {
                            // Connection established.
                            val installReferrerResponse = try {
                                client.getInstallReferrer()
                            } catch (e: RemoteException) {
                                // We can't do anything about this.
                                logger.error("Failed to retrieve install referrer response", e)
                                null
                            } catch (e: SecurityException) {
                                // https://issuetracker.google.com/issues/72926755
                                logger.error("Failed to retrieve install referrer response", e)
                                null
                            }

                            response = installReferrerResponse
                            handlers.forEach { it.handleReferrer(installReferrerResponse) }

                            return
                        }

                        InstallReferrerClient.InstallReferrerResponse.FEATURE_NOT_SUPPORTED,
                        InstallReferrerClient.InstallReferrerResponse.DEVELOPER_ERROR,
                        InstallReferrerClient.InstallReferrerResponse.PERMISSION_ERROR,
                        InstallReferrerClient.InstallReferrerResponse.SERVICE_UNAVAILABLE,
                        -> {
                            handlers.forEach { it.handleReferrer(null) }
                            return
                        }
                    }

                    // End the connection, and null out the client.
                    stop()
                }

                override fun onInstallReferrerServiceDisconnected() {
                    handlers.forEach { it.handleReferrer(null) }
                    referrerClient = null
                }
            },
        )
    }

    /**
     * Stops the connection with the install referrer.
     */
    fun stop() {
        referrerClient?.endConnection()
        referrerClient = null
    }

    companion object {
        var response: String? = null
    }
}
