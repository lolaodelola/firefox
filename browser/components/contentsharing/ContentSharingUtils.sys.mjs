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
ChromeUtils.defineESModuleGetters(lazy, {
  JsonSchema: "resource://gre/modules/JsonSchema.sys.mjs",
});

const SCHEMA_MAP = new Map();
async function loadContentSharingSchema() {
  if (SCHEMA_MAP.has("CONTENT_SHARING_SCHEMA")) {
    return SCHEMA_MAP.get("CONTENT_SHARING_SCHEMA");
  }

  const url =
    "chrome://browser/content/contentsharing/contentsharing.schema.json";
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load schema: ${response.statusText}`);
  }

  const schema = await response.json();
  SCHEMA_MAP.set("CONTENT_SHARING_SCHEMA", schema);
  return schema;
}

/**
 * Class for interacting with Content Sharing features, such as sharing bookmarks, tab groups, and tabs.
 */
class ContentSharingUtilsClass {
  #validator = null;

  get isEnabled() {
    return lazy.CONTENT_SHARING_ENABLED;
  }

  get serverURL() {
    return lazy.CONTENT_SHARING_SERVER_URL;
  }

  async getValidator() {
    if (this.#validator) {
      return this.#validator;
    }

    const schema = await loadContentSharingSchema();
    this.#validator = new lazy.JsonSchema.Validator(schema);
    return this.#validator;
  }

  countItems(share) {
    let count = 0;
    for (let item of share.links) {
      if (item.links) {
        count += this.countItems(item);
      }
      // Alway count the current item
      count += 1;
    }

    return count;
  }

  async validateSchema(share) {
    const validator = await this.getValidator();
    const result = validator.validate(share);

    if (!result.valid) {
      throw new Error(
        `ContentSharing Schema Error: ${result.errors.map(e => e.error).join(", ")}`
      );
    }

    if (this.countItems(share) > 100) {
      throw new Error(
        "ContentSharing Schema Error: Share object contains over 100 links"
      );
    }

    return true;
  }
}

const ContentSharingUtils = new ContentSharingUtilsClass();
export { ContentSharingUtils };
