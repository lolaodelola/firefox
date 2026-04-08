/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";

const lazy = {};
XPCOMUtils.defineLazyPreferenceGetter(
  lazy,
  "CONTENT_SHARING_ENABLED",
  "browser.contentsharing.enabled",
  false
);
XPCOMUtils.defineLazyPreferenceGetter(
  lazy,
  "CONTENT_SHARING_SERVER_URL",
  "browser.contentsharing.server.url",
  ""
);

/**
 * Class for interacting with Content Sharing features, such as sharing bookmarks, tab groups, and tabs.
 */
class ContentSharingUtilsClass {
  get isEnabled() {
    return lazy.CONTENT_SHARING_ENABLED;
  }

  get serverURL() {
    return lazy.CONTENT_SHARING_SERVER_URL;
  }
}

const ContentSharingUtils = new ContentSharingUtilsClass();
export { ContentSharingUtils };
