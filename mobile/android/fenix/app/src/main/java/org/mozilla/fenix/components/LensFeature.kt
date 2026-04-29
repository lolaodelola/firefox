/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.components

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import androidx.activity.result.ActivityResultLauncher
import androidx.fragment.app.Fragment
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.distinctUntilChangedBy
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import mozilla.components.lib.state.ext.flowScoped
import mozilla.components.support.base.feature.LifecycleAwareFeature
import mozilla.components.support.base.feature.ViewBoundFeatureWrapper
import org.mozilla.fenix.components.appstate.AppAction.LensAction
import org.mozilla.fenix.components.lens.LensCameraActivity
import org.mozilla.fenix.ext.components
import org.mozilla.fenix.ext.settings
import java.io.IOException

/**
 * Handles Google Lens image search requests and results.
 * - Observes Lens requests from the AppStore.
 * - Launches the Lens camera screen and uploads the selected image.
 * - Dispatches the resulting Lens URL back to AppStore.
 */
class LensFeature(
    private val context: Context,
    private val appStore: AppStore,
    private val lensLauncher: ActivityResultLauncher<Intent>,
    private val uploader: LensImageUploader,
    private val mainDispatcher: CoroutineDispatcher = Dispatchers.Main,
) : LifecycleAwareFeature {

    private var scope: CoroutineScope? = null

    override fun start() {
        observeLensRequests()
    }

    override fun stop() {
        scope?.cancel()
        scope = null
    }

    private fun observeLensRequests() {
        scope = appStore.flowScoped(dispatcher = mainDispatcher) { flow ->
            flow.map { state -> state.lensState }
                .distinctUntilChangedBy { it.isRequesting }
                .collect { lensState ->
                    if (lensState.isRequesting) {
                        appStore.dispatch(LensAction.LensRequestConsumed)
                        launchCamera()
                    }
                }
        }
    }

    private fun launchCamera() {
        val intent = LensCameraActivity.newIntent(context)
        try {
            lensLauncher.launch(intent)
        } catch (e: ActivityNotFoundException) {
            appStore.dispatch(LensAction.LensDismissed)
        }
    }

    /**
     * Handles the result of the Lens camera activity.
     */
    fun handleImageResult(resultCode: Int, data: Intent?) {
        if (resultCode != Activity.RESULT_OK) {
            appStore.dispatch(LensAction.LensDismissed)
            return
        }

        val imageUri = data?.data
        if (imageUri == null) {
            appStore.dispatch(LensAction.LensDismissed)
            return
        }

        val currentScope = scope
        if (currentScope == null) {
            appStore.dispatch(LensAction.LensDismissed)
            return
        }

        currentScope.launch {
            try {
                val resultUrl = uploader.upload(imageUri)
                if (resultUrl != null) {
                    appStore.dispatch(LensAction.LensResultAvailable(resultUrl))
                } else {
                    appStore.dispatch(LensAction.LensDismissed)
                }
            } catch (e: IOException) {
                appStore.dispatch(LensAction.LensDismissed)
            }
        }
    }

    companion object {
        /**
         * Registers [LensFeature] with a [Fragment].
         * Returns null if the Google Lens integration is disabled.
         */
        fun register(
            fragment: Fragment,
            activityResultLauncher: ActivityResultLauncher<Intent>,
        ): ViewBoundFeatureWrapper<LensFeature>? {
            if (!fragment.requireContext().settings().googleLensIntegrationEnabled) {
                return null
            }

            val lensBinding = ViewBoundFeatureWrapper<LensFeature>()

            lensBinding.set(
                feature = LensFeature(
                    context = fragment.requireContext(),
                    appStore = fragment.requireContext().components.appStore,
                    lensLauncher = activityResultLauncher,
                    uploader = LensImageUploader(
                        context = fragment.requireContext(),
                        client = fragment.requireContext().components.core.client,
                        userAgent = fragment.requireContext().components.core.engine.settings.userAgentString ?: "",
                    ),
                ),
                owner = fragment.viewLifecycleOwner,
                view = fragment.requireView(),
            )

            return lensBinding
        }
    }
}
