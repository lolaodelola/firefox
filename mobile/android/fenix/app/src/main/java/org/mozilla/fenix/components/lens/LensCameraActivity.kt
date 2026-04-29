/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.components.lens

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.annotation.VisibleForTesting
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.os.BundleCompat
import androidx.fragment.app.commit
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import org.mozilla.fenix.R

internal const val LENS_IMAGES_DIR = "lens_images"

/**
 * Activity that hosts [LensCameraFragment] for capturing images for Google Lens.
 * Handles camera permission and gallery picking, returning the selected image URI
 * as the activity result.
 */
class LensCameraActivity : AppCompatActivity() {

    private val requestPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { isGranted ->
        if (isGranted) {
            launchCameraFragment()
        } else {
            setResult(RESULT_CANCELED)
            finish()
        }
    }

    private val galleryLauncher = registerForActivityResult(
        ActivityResultContracts.PickVisualMedia(),
    ) { uri ->
        if (uri != null) {
            val resultIntent = Intent().apply { data = uri }
            setResult(RESULT_OK, resultIntent)
            finish()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_lens_camera)
        lifecycleScope.launch(Dispatchers.IO) { clearLensImageCache() }

        supportFragmentManager.setFragmentResultListener(
            LensCameraFragment.RESULT_REQUEST_KEY,
            this,
        ) { _, bundle ->
            if (bundle.getBoolean(LensCameraFragment.RESULT_GALLERY_REQUEST, false)) {
                launchGalleryPicker()
                return@setFragmentResultListener
            }

            val imageUri: Uri? = BundleCompat.getParcelable(
                bundle,
                LensCameraFragment.RESULT_IMAGE_URI,
                Uri::class.java,
            )
            if (imageUri != null) {
                val resultIntent = Intent().apply { data = imageUri }
                setResult(RESULT_OK, resultIntent)
            } else {
                setResult(RESULT_CANCELED)
            }
            finish()
        }

        if (savedInstanceState == null) {
            checkCameraPermission()
        }
    }

    private fun checkCameraPermission() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
            == PackageManager.PERMISSION_GRANTED
        ) {
            launchCameraFragment()
        } else {
            requestPermissionLauncher.launch(Manifest.permission.CAMERA)
        }
    }

    private fun launchCameraFragment() {
        if (supportFragmentManager.findFragmentById(R.id.lens_fragment_container_view) != null) {
            return
        }
        supportFragmentManager.commit {
            add(R.id.lens_fragment_container_view, LensCameraFragment::class.java, null)
        }
    }

    private fun launchGalleryPicker() {
        galleryLauncher.launch(
            PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly),
        )
    }

    @VisibleForTesting
    internal fun clearLensImageCache() {
        val imageDir = java.io.File(cacheDir, LENS_IMAGES_DIR)
        if (imageDir.exists()) {
            imageDir.listFiles()?.forEach { it.delete() }
        }
    }

    companion object {
        /**
         * Creates an intent to launch [LensCameraActivity].
         */
        fun newIntent(context: Context): Intent {
            return Intent(context, LensCameraActivity::class.java)
        }
    }
}
