/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.components.lens

import mozilla.components.support.test.robolectric.testContext
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import java.io.File

@RunWith(RobolectricTestRunner::class)
class LensCameraActivityTest {

    @Test
    fun `GIVEN a context WHEN newIntent is called THEN the returned intent targets LensCameraActivity`() {
        val intent = LensCameraActivity.newIntent(testContext)
        assertEquals(
            LensCameraActivity::class.java.name,
            intent.component?.className,
        )
    }

    @Test
    fun `GIVEN cached lens images exist WHEN clearLensImageCache is called THEN cached files are deleted and the directory remains`() {
        val activity = Robolectric.buildActivity(LensCameraActivity::class.java).get()
        val imageDir = File(activity.cacheDir, "lens_images")
        imageDir.mkdirs()
        val testFile = File(imageDir, "test_image.jpg")
        testFile.writeText("test")
        assertTrue(testFile.exists())

        activity.clearLensImageCache()

        assertFalse(testFile.exists())
        assertTrue(imageDir.exists())
    }

    @Test
    fun `GIVEN the lens image cache directory does not exist WHEN clearLensImageCache is called THEN no exception is thrown`() {
        val activity = Robolectric.buildActivity(LensCameraActivity::class.java).get()
        val imageDir = File(activity.cacheDir, "lens_images")
        assertFalse(imageDir.exists())

        activity.clearLensImageCache()
    }
}
