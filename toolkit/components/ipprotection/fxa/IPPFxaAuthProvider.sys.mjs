/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  IPPEnrollAndEntitleManager:
    "moz-src:///toolkit/components/ipprotection/IPPEnrollAndEntitleManager.sys.mjs",
  IPPSignInWatcher:
    "moz-src:///toolkit/components/ipprotection/fxa/IPPSignInWatcher.sys.mjs",
});

/**
 *
 */
class IPPFxaAuthProviderSingleton {
  get helpers() {
    return [lazy.IPPSignInWatcher, lazy.IPPEnrollAndEntitleManager];
  }

  get isReady() {
    // For non authenticated users, we don't know yet their enroll state so the UI
    // is shown and they have to login.
    if (!lazy.IPPSignInWatcher.isSignedIn) {
      return false;
    }

    // If the current account is not enrolled and entitled, the UI is shown and
    // they have to opt-in.
    // If they are currently enrolling, they have already opted-in.
    if (
      !lazy.IPPEnrollAndEntitleManager.isEnrolledAndEntitled &&
      !lazy.IPPEnrollAndEntitleManager.isEnrolling
    ) {
      return false;
    }

    return true;
  }
}

const IPPFxaAuthProvider = new IPPFxaAuthProviderSingleton();

export { IPPFxaAuthProvider };
