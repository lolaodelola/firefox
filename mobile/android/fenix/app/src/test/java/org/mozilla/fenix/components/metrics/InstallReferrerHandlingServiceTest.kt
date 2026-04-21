/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.components.metrics

import com.android.installreferrer.api.InstallReferrerClient
import com.android.installreferrer.api.InstallReferrerStateListener
import mozilla.components.support.test.robolectric.testContext
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
internal class InstallReferrerHandlingServiceTest {

    private val handler = RecordingInstallReferrerHandler()

    @Before
    fun setUp() {
        InstallReferrerHandlingService.response = null
    }

    @Test
    fun `GIVEN a successful referrer response WHEN start is called THEN handlers receive the referrer`() {
        val referrer = "utm_source=google&utm_medium=cpc&utm_campaign=brand&utm_content=ad1&utm_term=firefox"
        val service = fakeInstallReferrerService(
            responseCode = InstallReferrerClient.InstallReferrerResponse.OK,
            referrerResponse = referrer,
        )

        service.start()

        assertEquals(referrer, handler.receivedResponse)
        assertEquals(referrer, InstallReferrerHandlingService.response)
    }

    @Test
    fun `GIVEN a successful response but with unknown referrer WHEN start is called THEN handlers receive null referrer data`() {
        val service = fakeInstallReferrerService(
            responseCode = InstallReferrerClient.InstallReferrerResponse.OK,
            referrerResponse = null,
        )

        service.start()

        assertNull(handler.receivedResponse)
        assertTrue(handler.wasCalled)
        assertNull(InstallReferrerHandlingService.response)
    }

    @Test
    fun `GIVEN FEATURE_NOT_SUPPORTED WHEN start is called THEN handlers receive null referrer data`() {
        val service = fakeInstallReferrerService(
            responseCode = InstallReferrerClient.InstallReferrerResponse.FEATURE_NOT_SUPPORTED,
        )

        service.start()

        assertNull(handler.receivedResponse)
        assertTrue(handler.wasCalled)
        assertNull(InstallReferrerHandlingService.response)
    }

    @Test
    fun `GIVEN DEVELOPER_ERROR WHEN start is called THEN handlers receive null referrer data`() {
        val service = fakeInstallReferrerService(
            responseCode = InstallReferrerClient.InstallReferrerResponse.DEVELOPER_ERROR,
        )

        service.start()

        assertNull(handler.receivedResponse)
        assertTrue(handler.wasCalled)
    }

    @Test
    fun `GIVEN SERVICE_UNAVAILABLE WHEN start is called THEN handlers receive null referrer data`() {
        val service = fakeInstallReferrerService(
            responseCode = InstallReferrerClient.InstallReferrerResponse.SERVICE_UNAVAILABLE,
        )

        service.start()

        assertNull(handler.receivedResponse)
        assertTrue(handler.wasCalled)
    }

    @Test
    fun `GIVEN a service disconnect WHEN start is called THEN handlers receive null referrer data`() {
        val service = fakeInstallReferrerService(simulateDisconnect = true)

        service.start()

        assertNull(handler.receivedResponse)
        assertTrue(handler.wasCalled)
    }

    @Test
    fun `GIVEN multiple handlers WHEN start is called THEN all handlers receive the response`() {
        val handler2 = RecordingInstallReferrerHandler()
        val referrer = "utm_source=addons.mozilla.org&utm_medium=referral&utm_campaign=amo-fx-cta-123"
        val service = fakeInstallReferrerService(
            handlers = listOf(handler, handler2),
            referrerResponse = referrer,
        )

        service.start()

        assertEquals(referrer, handler.receivedResponse)
        assertEquals(referrer, handler2.receivedResponse)
    }

    @Test
    fun `GIVEN no handlers WHEN start is called THEN service completes without error`() {
        val service = fakeInstallReferrerService(
            handlers = emptyList(),
            referrerResponse = "utm_source=test",
        )

        service.start()

        assertEquals("utm_source=test", InstallReferrerHandlingService.response)
    }

    @Test
    fun `WHEN stop is called THEN the install referrer service is stopped`() {
        val service = fakeInstallReferrerService(
            handlers = emptyList(),
            referrerResponse = "utm_source=test",
        )

        service.start()
        val referrerClient = service.referrerClient as FakeReferrerClient
        assertTrue(referrerClient.isActive)

        service.stop()
        assertFalse(referrerClient.isActive)
        assertNull(service.referrerClient)
    }

    private fun fakeInstallReferrerService(
        handlers: List<InstallReferrerHandler> = listOf(handler),
        responseCode: Int = InstallReferrerClient.InstallReferrerResponse.OK,
        referrerResponse: String? = null,
        simulateDisconnect: Boolean = false,
    ) = InstallReferrerHandlingService(
        context = testContext,
        handlers = handlers,
    ).apply {
        clientFactory = {
            FakeReferrerClient(
                responseCode = responseCode,
                referrerResponse = referrerResponse,
                simulateDisconnect = simulateDisconnect,
            )
        }
    }
}

private class RecordingInstallReferrerHandler : InstallReferrerHandler {
    var receivedResponse: String? = null
        private set
    var wasCalled = false
        private set

    override fun handleReferrer(installReferrerResponse: String?) {
        wasCalled = true
        receivedResponse = installReferrerResponse
    }
}

private class FakeReferrerClient(
    private val responseCode: Int = InstallReferrerClient.InstallReferrerResponse.OK,
    private val referrerResponse: String? = null,
    private val simulateDisconnect: Boolean = false,
) : InstallReferrerClientWrapper {
    var isActive = false
        private set

    override fun startConnection(listener: InstallReferrerStateListener) {
        isActive = true

        if (simulateDisconnect) {
            listener.onInstallReferrerServiceDisconnected()
        } else {
            listener.onInstallReferrerSetupFinished(responseCode)
        }
    }

    override fun getInstallReferrer(): String? = referrerResponse

    override fun endConnection() {
        isActive = false
    }
}
