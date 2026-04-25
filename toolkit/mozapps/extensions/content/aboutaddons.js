/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
/* eslint max-len: ["error", 80] */
/* import-globals-from aboutaddonsCommon.js */
/* import-globals-from abuse-reports.js */
/* import-globals-from view-controller.js */
/* global windowRoot */
// openAmoInTab is used as a window global by colorway-removal-notice.mjs,
// recommended-footer.mjs, and recommended-themes-footer.mjs.
// isAbuseReportSupported is used as a window global by addon-options.mjs.
/* exported openAmoInTab, isAbuseReportSupported */

"use strict";

ChromeUtils.defineESModuleGetters(this, {
  AMBrowserExtensionsImport: "resource://gre/modules/AddonManager.sys.mjs",
  AddonManager: "resource://gre/modules/AddonManager.sys.mjs",
  AddonRepository: "resource://gre/modules/addons/AddonRepository.sys.mjs",
  AppConstants: "resource://gre/modules/AppConstants.sys.mjs",
  BuiltInThemes: "resource:///modules/BuiltInThemes.sys.mjs",
  ClientID: "resource://gre/modules/ClientID.sys.mjs",
  ColorwayThemeMigration:
    "resource://gre/modules/ColorwayThemeMigration.sys.mjs",
  DeferredTask: "resource://gre/modules/DeferredTask.sys.mjs",
  E10SUtils: "resource://gre/modules/E10SUtils.sys.mjs",
  ExtensionCommon: "resource://gre/modules/ExtensionCommon.sys.mjs",
  ExtensionParent: "resource://gre/modules/ExtensionParent.sys.mjs",
  ExtensionPermissions: "resource://gre/modules/ExtensionPermissions.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  recordListViewTelemetry: "chrome://global/content/ml/Utils.sys.mjs",
  recordDetailsViewTelemetry: "chrome://global/content/ml/Utils.sys.mjs",
  recordRemoveInitiatedTelemetry: "chrome://global/content/ml/Utils.sys.mjs",
  recordRemoveConfirmationTelemetry: "chrome://global/content/ml/Utils.sys.mjs",
  recordListItemManageTelemetry: "chrome://global/content/ml/Utils.sys.mjs",
});

const UPDATES_RECENT_TIMESPAN = 2 * 24 * 3600000; // 2 days (in milliseconds)

XPCOMUtils.defineLazyPreferenceGetter(
  this,
  "ABUSE_REPORT_ENABLED",
  "extensions.abuseReport.enabled",
  false
);
XPCOMUtils.defineLazyPreferenceGetter(
  this,
  "LIST_RECOMMENDATIONS_ENABLED",
  "extensions.htmlaboutaddons.recommendations.enabled",
  false
);
XPCOMUtils.defineLazyPreferenceGetter(
  this,
  "DATA_COLLECTION_PERMISSIONS_ENABLED",
  "extensions.dataCollectionPermissions.enabled",
  false
);
XPCOMUtils.defineLazyPreferenceGetter(
  this,
  "FORCED_COLORS_OVERRIDE_ENABLED",
  "browser.theme.forced-colors-override.enabled",
  true
);

const PLUGIN_ICON_URL = "chrome://global/skin/icons/plugin.svg";
const EXTENSION_ICON_URL =
  "chrome://mozapps/skin/extensions/extensionGeneric.svg";

const PERMISSION_MASKS = {
  enable: AddonManager.PERM_CAN_ENABLE,
  "always-activate": AddonManager.PERM_CAN_ENABLE,
  disable: AddonManager.PERM_CAN_DISABLE,
  "never-activate": AddonManager.PERM_CAN_DISABLE,
  uninstall: AddonManager.PERM_CAN_UNINSTALL,
  upgrade: AddonManager.PERM_CAN_UPGRADE,
  "change-privatebrowsing": AddonManager.PERM_CAN_CHANGE_PRIVATEBROWSING_ACCESS,
};

const PREF_DISCOVERY_API_URL = "extensions.getAddons.discovery.api_url";
const PREF_RECOMMENDATION_ENABLED = "browser.discovery.enabled";
const PREF_TELEMETRY_ENABLED = "datareporting.healthreport.uploadEnabled";
const PRIVATE_BROWSING_PERM_NAME = "internal:privateBrowsingAllowed";
const PRIVATE_BROWSING_PERMS = {
  permissions: [PRIVATE_BROWSING_PERM_NAME],
  origins: [],
};

const L10N_ID_MAPPING = {
  "theme-disabled-heading": "theme-disabled-heading2",
};

function getL10nIdMapping(id) {
  return L10N_ID_MAPPING[id] || id;
}

function shouldSkipAnimations() {
  return (
    document.body.hasAttribute("skip-animations") ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function callListeners(name, args, listeners) {
  for (let listener of listeners) {
    try {
      if (name in listener) {
        listener[name](...args);
      }
    } catch (e) {
      Cu.reportError(e);
    }
  }
}

function getUpdateInstall(addon) {
  return (
    // Install object for a pending update.
    addon.updateInstall ||
    // Install object for a postponed upgrade (only for extensions,
    // because is the only addon type that can postpone their own
    // updates).
    (addon.type === "extension" &&
      addon.pendingUpgrade &&
      addon.pendingUpgrade.install)
  );
}

function isManualUpdate(install) {
  const isExistingHidden = install.existingAddon?.hidden;
  // install.addon can be missing if the install was retrieved from an update
  // check, without having downloaded and parsed the linked xpi yet.
  const isNewHidden = install.addon?.hidden;
  // Not a manual update installation if both the existing and old
  // addon are hidden (which also ensures we are going to hide pending
  // installations for hidden add-ons from both the category button
  // badge counter and from the available updates view when the new
  // addon is also hidden).
  if (isExistingHidden && isNewHidden) {
    return false;
  }
  let isManual =
    install.existingAddon &&
    !AddonManager.shouldAutoUpdate(install.existingAddon);
  let isExtension = install.existingAddon?.type == "extension";
  return (
    (isManual && isInState(install, "available")) ||
    (isExtension && isInState(install, "postponed"))
  );
}

const AddonManagerListenerHandler = {
  listeners: new Set(),

  addListener(listener) {
    this.listeners.add(listener);
  },

  removeListener(listener) {
    this.listeners.delete(listener);
  },

  delegateEvent(name, args) {
    callListeners(name, args, this.listeners);
  },

  startup() {
    this._listener = new Proxy(
      {},
      {
        has: () => true,
        get:
          (_, name) =>
          (...args) =>
            this.delegateEvent(name, args),
      }
    );
    AddonManager.addAddonListener(this._listener);
    AddonManager.addInstallListener(this._listener);
    AddonManager.addManagerListener(this._listener);
    this._permissionHandler = (type, data) => {
      if (type == "change-permissions") {
        this.delegateEvent("onChangePermissions", [data]);
      }
    };
    ExtensionPermissions.addListener(this._permissionHandler);
  },

  shutdown() {
    AddonManager.removeAddonListener(this._listener);
    AddonManager.removeInstallListener(this._listener);
    AddonManager.removeManagerListener(this._listener);
    ExtensionPermissions.removeListener(this._permissionHandler);
  },
};

/**
 * This object wires the AddonManager event listeners into addon-card and
 * addon-details elements rather than needing to add/remove listeners all the
 * time as the view changes.
 */
const AddonCardListenerHandler = new Proxy(
  {},
  {
    has: () => true,
    get(_, name) {
      return (...args) => {
        let elements = [];
        let addonId;

        // We expect args[0] to be of type:
        // - AddonInstall, on AddonManager install events
        // - AddonWrapper, on AddonManager addon events
        // - undefined, on AddonManager manage events
        if (args[0]) {
          addonId =
            args[0].addon?.id ||
            args[0].existingAddon?.id ||
            args[0].extensionId ||
            args[0].id;
        }

        if (addonId) {
          let cardSelector = `addon-card[addon-id="${addonId}"]`;
          elements = document.querySelectorAll(
            `${cardSelector}, ${cardSelector} addon-details`
          );
        } else if (name == "onUpdateModeChanged") {
          elements = document.querySelectorAll("addon-card");
        }

        callListeners(name, args, elements);
      };
    },
  }
);
AddonManagerListenerHandler.addListener(AddonCardListenerHandler);

function isAbuseReportSupported(addon) {
  return (
    ABUSE_REPORT_ENABLED &&
    AbuseReporter.isSupportedAddonType(addon.type) &&
    !(addon.isBuiltin || addon.isSystem)
  );
}

async function isAllowedInPrivateBrowsing(addon) {
  // Use the Promise directly so this function stays sync for the other case.
  let perms = await ExtensionPermissions.get(addon.id);
  return perms.permissions.includes(PRIVATE_BROWSING_PERM_NAME);
}

function hasPermission(addon, permission) {
  return !!(addon.permissions & PERMISSION_MASKS[permission]);
}

function isInState(install, state) {
  return install.state == AddonManager["STATE_" + state.toUpperCase()];
}

async function getAddonMessageInfo(
  addon,
  { isCardExpanded, isInDisabledSection }
) {
  const { name } = addon;
  const { STATE_BLOCKED, STATE_SOFTBLOCKED } = Ci.nsIBlocklistService;

  if (addon.blocklistState === STATE_BLOCKED) {
    let typeSuffix = addon.type === "extension" ? "extension" : "other";
    return {
      linkUrl: await addon.getBlocklistURL(),
      linkId: "details-notification-blocked-link2",
      messageId: `details-notification-hard-blocked-${typeSuffix}`,
      type: "error",
    };
  } else if (isDisabledUnsigned(addon)) {
    return {
      linkSumoPage: "unsigned-addons",
      messageId: "details-notification-unsigned-and-disabled2",
      messageArgs: { name },
      type: "error",
    };
  } else if (
    !addon.isCompatible &&
    (AddonManager.checkCompatibility ||
      addon.blocklistState !== STATE_SOFTBLOCKED)
  ) {
    return {
      // TODO: (Bug 1921870) consider adding a SUMO page.
      // NOTE: this messagebar is customized by Thunderbird to include
      // a non-SUMO link (see Bug 1921870 comment 0).
      messageId: "details-notification-incompatible2",
      messageArgs: { name, version: Services.appinfo.version },
      type: "error",
    };
  } else if (
    (Cu.isInAutomation || !AppConstants.MOZILLA_OFFICIAL) &&
    Services.prefs.getBoolPref("extensions.ui.disableUnsignedWarnings", false)
  ) {
    // In local builds, when this pref is set, pretend the file is correctly
    // signed even if it isn't so that the UI looks like what users would
    // normally see.
    return {};
  } else if (!isCorrectlySigned(addon)) {
    return {
      linkSumoPage: "unsigned-addons",
      messageId: "details-notification-unsigned2",
      messageArgs: { name },
      type: "warning",
    };
  } else if (addon.blocklistState === STATE_SOFTBLOCKED) {
    const softBlockFluentIdsMap = {
      extension: {
        enabled: "details-notification-soft-blocked-extension-enabled2",
        disabled: "details-notification-soft-blocked-extension-disabled2",
      },
      other: {
        enabled: "details-notification-soft-blocked-other-enabled2",
        disabled: "details-notification-soft-blocked-other-disabled2",
      },
    };
    let typeSuffix = addon.type === "extension" ? "extension" : "other";
    let stateSuffix;
    // If the Addon Card is not expanded, delay changing the messagebar
    // string to when the Addon card is refreshed as part of moving
    // it between the enabled and disabled sections.
    if (isCardExpanded) {
      stateSuffix = addon.isActive ? "enabled" : "disabled";
    } else {
      stateSuffix = !isInDisabledSection ? "enabled" : "disabled";
    }
    let messageId = softBlockFluentIdsMap[typeSuffix][stateSuffix];

    return {
      linkUrl: await addon.getBlocklistURL(),
      linkId: "details-notification-softblocked-link2",
      messageId,
      type: "warning",
    };
  } else if (addon.isGMPlugin && !addon.isInstalled && addon.isActive) {
    return {
      messageId: "details-notification-gmp-pending2",
      messageArgs: { name },
      type: "warning",
    };
  }
  return {};
}

function checkForUpdate(addon) {
  return new Promise(resolve => {
    let listener = {
      onUpdateAvailable(addon, install) {
        if (AddonManager.shouldAutoUpdate(addon)) {
          // Make sure that an update handler is attached to all the install
          // objects when updated xpis are going to be installed automatically.
          attachUpdateHandler(install);

          let failed = () => {
            detachUpdateHandler(install);
            install.removeListener(updateListener);
            resolve({ installed: false, pending: false, found: true });
          };
          let updateListener = {
            onDownloadFailed: failed,
            onInstallCancelled: failed,
            onInstallFailed: failed,
            onInstallEnded: () => {
              detachUpdateHandler(install);
              install.removeListener(updateListener);
              resolve({ installed: true, pending: false, found: true });
            },
            onInstallPostponed: () => {
              detachUpdateHandler(install);
              install.removeListener(updateListener);
              resolve({ installed: false, pending: true, found: true });
            },
          };
          install.addListener(updateListener);
          install.install();
        } else {
          resolve({ installed: false, pending: true, found: true });
        }
      },
      onNoUpdateAvailable() {
        resolve({ found: false });
      },
    };
    addon.findUpdates(listener, AddonManager.UPDATE_WHEN_USER_REQUESTED);
  });
}

async function checkForUpdates() {
  let addons = await AddonManager.getAddonsByTypes(null);
  addons = addons.filter(addon => hasPermission(addon, "upgrade"));
  let updates = await Promise.all(addons.map(addon => checkForUpdate(addon)));
  gViewController.notifyEMUpdateCheckFinished();
  return updates.reduce(
    (counts, update) => ({
      installed: counts.installed + (update.installed ? 1 : 0),
      pending: counts.pending + (update.pending ? 1 : 0),
      found: counts.found + (update.found ? 1 : 0),
    }),
    { installed: 0, pending: 0, found: 0 }
  );
}

// Don't change how we handle this while the page is open.
const INLINE_OPTIONS_ENABLED = Services.prefs.getBoolPref(
  "extensions.htmlaboutaddons.inline-options.enabled"
);
const OPTIONS_TYPE_MAP = {
  [AddonManager.OPTIONS_TYPE_TAB]: "tab",
  [AddonManager.OPTIONS_TYPE_INLINE_BROWSER]: INLINE_OPTIONS_ENABLED
    ? "inline"
    : "tab",
};

// Check if an add-on has the provided options type, accounting for the pref
// to disable inline options.
function getOptionsType(addon) {
  return OPTIONS_TYPE_MAP[addon.optionsType];
}

// Check whether the options page can be loaded in the current browser window.
async function isAddonOptionsUIAllowed(addon) {
  if (addon.type !== "extension" || !getOptionsType(addon)) {
    // Themes never have options pages.
    // Some plugins have preference pages, and they can always be shown.
    // Extensions do not need to be checked if they do not have options pages.
    return true;
  }
  if (!PrivateBrowsingUtils.isContentWindowPrivate(window)) {
    return true;
  }
  if (addon.incognito === "not_allowed") {
    return false;
  }
  // The current page is in a private browsing window, and the add-on does not
  // have the permission to access private browsing windows. Block access.
  return (
    // Note: This function is async because isAllowedInPrivateBrowsing is async.
    isAllowedInPrivateBrowsing(addon)
  );
}

let _templates = {};

/**
 * Import a template from the main document.
 */
function importTemplate(name) {
  if (!_templates.hasOwnProperty(name)) {
    _templates[name] = document.querySelector(`template[name="${name}"]`);
  }
  let template = _templates[name];
  if (template) {
    return document.importNode(template.content, true);
  }
  throw new Error(`Unknown template: ${name}`);
}

function nl2br(text) {
  let frag = document.createDocumentFragment();
  let hasAppended = false;
  for (let part of text.split("\n")) {
    if (hasAppended) {
      frag.appendChild(document.createElement("br"));
    }
    frag.appendChild(new Text(part));
    hasAppended = true;
  }
  return frag;
}

/**
 * Select the screeenshot to display above an add-on card.
 *
 * @param {AddonWrapper|DiscoAddonWrapper} addon
 * @returns {string|null}
 *          The URL of the best fitting screenshot, if any.
 */
function getScreenshotUrlForAddon(addon) {
  if (addon.id == "default-theme@mozilla.org") {
    return "chrome://mozapps/content/extensions/default-theme/preview.svg";
  }
  const builtInThemePreview = BuiltInThemes.previewForBuiltInThemeId(addon.id);
  if (builtInThemePreview) {
    return builtInThemePreview;
  }

  let { screenshots } = addon;
  if (!screenshots || !screenshots.length) {
    return null;
  }

  // The image size is defined at .card-heading-image in aboutaddons.css, and
  // is based on the aspect ratio for a 680x92 image. Use the image if possible,
  // and otherwise fall back to the first image and hope for the best.
  let screenshot = screenshots.find(s => s.width === 680 && s.height === 92);
  if (!screenshot) {
    console.warn(`Did not find screenshot with desired size for ${addon.id}.`);
    screenshot = screenshots[0];
  }
  return screenshot.url;
}

/**
 * Adds UTM parameters to a given URL, if it is an AMO URL.
 *
 * @param {string} contentAttribute
 *        Identifies the part of the UI with which the link is associated.
 * @param {string} url
 * @returns {string}
 *          The url with UTM parameters if it is an AMO URL.
 *          Otherwise the url in unmodified form.
 */
function formatUTMParams(contentAttribute, url) {
  let parsedUrl = new URL(url);
  let domain = `.${parsedUrl.hostname}`;
  if (
    !domain.endsWith(".mozilla.org") &&
    // For testing: addons-dev.allizom.org and addons.allizom.org
    !domain.endsWith(".allizom.org")
  ) {
    return url;
  }

  parsedUrl.searchParams.set("utm_source", "firefox-browser");
  parsedUrl.searchParams.set("utm_medium", "firefox-browser");
  parsedUrl.searchParams.set("utm_content", contentAttribute);
  return parsedUrl.href;
}

// A wrapper around an item from the "results" array from AMO's discovery API.
// See https://addons-server.readthedocs.io/en/latest/topics/api/discovery.html
class DiscoAddonWrapper {
  /**
   * @param {object} details
   *        An item in the "results" array from AMO's discovery API.
   */
  constructor(details) {
    // Reuse AddonRepository._parseAddon to have the AMO response parsing logic
    // in one place.
    let repositoryAddon = AddonRepository._parseAddon(details.addon);

    // Note: Any property used by RecommendedAddonCard should appear here.
    // The property names and values should have the same semantics as
    // AddonWrapper, to ease the reuse of helper functions in this file.
    this.id = repositoryAddon.id;
    this.type = repositoryAddon.type;
    this.name = repositoryAddon.name;
    this.screenshots = repositoryAddon.screenshots;
    this.sourceURI = repositoryAddon.sourceURI;
    this.creator = repositoryAddon.creator;
    this.averageRating = repositoryAddon.averageRating;

    this.dailyUsers = details.addon.average_daily_users;

    this.editorialDescription = details.description_text;
    this.iconURL = details.addon.icon_url;
    this.amoListingUrl = details.addon.url;

    this.taarRecommended = details.is_recommendation;
  }
}

/**
 * A helper to retrieve the list of recommended add-ons via AMO's discovery API.
 */
var DiscoveryAPI = {
  // Map<boolean, Promise> Promises from fetching the API results with or
  // without a client ID. The `false` (no client ID) case could actually
  // have been fetched with a client ID. See getResults() for more info.
  _resultPromises: new Map(),

  /**
   * Fetch the list of recommended add-ons. The results are cached.
   *
   * Pending requests are coalesced, so there is only one request at any given
   * time. If a request fails, the pending promises are rejected, but a new
   * call will result in a new request. A succesful response is cached for the
   * lifetime of the document.
   *
   * @param {boolean} preferClientId
   *                  A boolean indicating a preference for using a client ID.
   *                  This will not overwrite the user preference but will
   *                  avoid sending a client ID if no request has been made yet.
   * @returns {Promise<DiscoAddonWrapper[]>}
   */
  async getResults(preferClientId = true) {
    // Allow a caller to set preferClientId to false, but not true if discovery
    // is disabled.
    preferClientId = preferClientId && this.clientIdDiscoveryEnabled;

    // Reuse a request for this preference first.
    let resultPromise =
      this._resultPromises.get(preferClientId) ||
      // If the client ID isn't preferred, we can still reuse a request with the
      // client ID.
      (!preferClientId && this._resultPromises.get(true));

    if (resultPromise) {
      return resultPromise;
    }

    // Nothing is prepared for this preference, make a new request.
    resultPromise = this._fetchRecommendedAddons(preferClientId).catch(e => {
      // Delete the pending promise, so _fetchRecommendedAddons can be
      // called again at the next property access.
      this._resultPromises.delete(preferClientId);
      Cu.reportError(e);
      throw e;
    });

    // Store the new result for the preference.
    this._resultPromises.set(preferClientId, resultPromise);

    return resultPromise;
  },

  get clientIdDiscoveryEnabled() {
    // These prefs match Discovery.sys.mjs for enabling clientId cookies.
    return (
      Services.prefs.getBoolPref(PREF_RECOMMENDATION_ENABLED, false) &&
      Services.prefs.getBoolPref(PREF_TELEMETRY_ENABLED, false) &&
      !PrivateBrowsingUtils.isContentWindowPrivate(window)
    );
  },

  async _fetchRecommendedAddons(useClientId) {
    let discoveryApiUrl = new URL(
      Services.urlFormatter.formatURLPref(PREF_DISCOVERY_API_URL)
    );

    if (useClientId) {
      let clientId = await ClientID.getClientIdHash();
      discoveryApiUrl.searchParams.set("telemetry-client-id", clientId);
    }
    let res = await fetch(discoveryApiUrl.href, {
      credentials: "omit",
    });
    if (!res.ok) {
      throw new Error(`Failed to fetch recommended add-ons, ${res.status}`);
    }
    let { results } = await res.json();
    return results.map(details => new DiscoAddonWrapper(details));
  },
};

class AddonPageHeader extends HTMLElement {
  connectedCallback() {
    if (this.childElementCount === 0) {
      this.appendChild(importTemplate("addon-page-header"));
      this.heading = this.querySelector(".header-name");
      this.backButton = this.querySelector(".back-button");
      this.pageOptionsMenuButton = this.querySelector(
        '[action="page-options"]'
      );
      // The addon-page-options element is outside of this element since this is
      // position: sticky and that would break the positioning of the menu.
      this.pageOptionsMenu = document.getElementById(
        this.getAttribute("page-options-id")
      );
    }
    document.addEventListener("view-selected", this);
    this.addEventListener("click", this);
    this.addEventListener("mousedown", this);
    // Use capture since the event is actually triggered on the internal
    // panel-list and it doesn't bubble.
    this.pageOptionsMenu.addEventListener("shown", this, true);
    this.pageOptionsMenu.addEventListener("hidden", this, true);
  }

  disconnectedCallback() {
    document.removeEventListener("view-selected", this);
    this.removeEventListener("click", this);
    this.removeEventListener("mousedown", this);
    this.pageOptionsMenu.removeEventListener("shown", this, true);
    this.pageOptionsMenu.removeEventListener("hidden", this, true);
  }

  setViewInfo({ type, param }) {
    this.setAttribute("current-view", type);
    this.setAttribute("current-param", param);
    let viewType = type === "list" ? param : type;
    this.setAttribute("type", viewType);

    this.heading.hidden = viewType === "detail";
    this.backButton.hidden = viewType !== "detail" && viewType !== "shortcuts";

    this.backButton.disabled = !history.state?.previousView;

    if (viewType !== "detail") {
      document.l10n.setAttributes(this.heading, `${viewType}-heading`);
    }
  }

  handleEvent(e) {
    let { backButton, pageOptionsMenu, pageOptionsMenuButton } = this;
    if (e.type === "click") {
      switch (e.target) {
        case backButton:
          window.history.back();
          break;
        case pageOptionsMenuButton:
          if (e.inputSource == MouseEvent.MOZ_SOURCE_KEYBOARD) {
            this.pageOptionsMenu.toggle(e);
          }
          break;
      }
    } else if (
      e.type == "mousedown" &&
      e.target == pageOptionsMenuButton &&
      e.button == 0
    ) {
      this.pageOptionsMenu.toggle(e);
    } else if (
      e.target == pageOptionsMenu.panel &&
      (e.type == "shown" || e.type == "hidden")
    ) {
      this.pageOptionsMenuButton.setAttribute(
        "aria-expanded",
        this.pageOptionsMenu.open
      );
    } else if (e.target == document && e.type == "view-selected") {
      const { type, param } = e.detail;
      this.setViewInfo({ type, param });
    }
  }
}
customElements.define("addon-page-header", AddonPageHeader);

class AddonPageOptions extends HTMLElement {
  connectedCallback() {
    if (this.childElementCount === 0) {
      this.render();
    }
    this.addEventListener("click", this);
    this.panel.addEventListener("showing", this);
    AddonManagerListenerHandler.addListener(this);
  }

  disconnectedCallback() {
    this.removeEventListener("click", this);
    this.panel.removeEventListener("showing", this);
    AddonManagerListenerHandler.removeListener(this);
  }

  toggle(...args) {
    return this.panel.toggle(...args);
  }

  get open() {
    return this.panel.open;
  }

  render() {
    this.appendChild(importTemplate("addon-page-options"));
    this.panel = this.querySelector("panel-list");
    this.installFromFile = this.querySelector('[action="install-from-file"]');
    this.toggleUpdatesEl = this.querySelector(
      '[action="set-update-automatically"]'
    );
    this.resetUpdatesEl = this.querySelector('[action="reset-update-states"]');
    this.onUpdateModeChanged();
  }

  async handleEvent(e) {
    if (e.type === "click") {
      e.target.disabled = true;
      try {
        await this.onClick(e);
      } finally {
        e.target.disabled = false;
      }
    } else if (e.type === "showing") {
      this.installFromFile.setAttribute(
        "data-l10n-id",
        PREFER_UPDATE_OVER_INSTALL_FOR_EXISTING_ADDON
          ? "addon-install-or-update-from-file"
          : "addon-install-from-file"
      );
      this.installFromFile.hidden = !XPINSTALL_ENABLED;
    }
  }

  async onClick(e) {
    switch (e.target.getAttribute("action")) {
      case "check-for-updates":
        await this.checkForUpdates();
        break;
      case "view-recent-updates":
        gViewController.loadView("updates/recent");
        break;
      case "install-from-file":
        if (XPINSTALL_ENABLED) {
          installAddonsFromFilePicker();
        }
        break;
      case "debug-addons":
        this.openAboutDebugging();
        break;
      case "set-update-automatically":
        await this.toggleAutomaticUpdates();
        break;
      case "reset-update-states":
        await this.resetAutomaticUpdates();
        break;
      case "manage-shortcuts":
        gViewController.loadView("shortcuts/shortcuts");
        break;
    }
  }

  async checkForUpdates() {
    let message = document.getElementById("updates-message");
    message.state = "updating";
    message.hidden = false;
    let { installed, pending } = await checkForUpdates();
    if (pending > 0) {
      message.state = "manual-updates-found";
    } else if (installed > 0) {
      message.state = "installed";
    } else {
      message.state = "none-found";
    }
  }

  openAboutDebugging() {
    let mainWindow = window.windowRoot.ownerGlobal;
    if ("switchToTabHavingURI" in mainWindow) {
      let principal = Services.scriptSecurityManager.getSystemPrincipal();
      mainWindow.switchToTabHavingURI(
        `about:debugging#/runtime/this-firefox`,
        true,
        {
          ignoreFragment: "whenComparing",
          triggeringPrincipal: principal,
        }
      );
    }
  }

  automaticUpdatesEnabled() {
    return AddonManager.updateEnabled && AddonManager.autoUpdateDefault;
  }

  toggleAutomaticUpdates() {
    if (!this.automaticUpdatesEnabled()) {
      // One or both of the prefs is false, i.e. the checkbox is not
      // checked. Now toggle both to true. If the user wants us to
      // auto-update add-ons, we also need to auto-check for updates.
      AddonManager.updateEnabled = true;
      AddonManager.autoUpdateDefault = true;
    } else {
      // Both prefs are true, i.e. the checkbox is checked.
      // Toggle the auto pref to false, but don't touch the enabled check.
      AddonManager.autoUpdateDefault = false;
    }
  }

  async resetAutomaticUpdates() {
    let addons = await AddonManager.getAllAddons();
    for (let addon of addons) {
      if ("applyBackgroundUpdates" in addon) {
        addon.applyBackgroundUpdates = AddonManager.AUTOUPDATE_DEFAULT;
      }
    }
  }

  /**
   * AddonManager listener events.
   */

  onUpdateModeChanged() {
    let updatesEnabled = this.automaticUpdatesEnabled();
    this.toggleUpdatesEl.checked = updatesEnabled;
    let resetType = updatesEnabled ? "automatic" : "manual";
    let resetStringId = `addon-updates-reset-updates-to-${resetType}`;
    document.l10n.setAttributes(this.resetUpdatesEl, resetStringId);
  }
}
customElements.define("addon-page-options", AddonPageOptions);

class InlineOptionsBrowser extends HTMLElement {
  constructor() {
    super();
    // Force the options_ui remote browser to recompute window.mozInnerScreenX
    // and window.mozInnerScreenY when the "addon details" page has been
    // scrolled (See Bug 1390445 for rationale).
    // Also force a repaint to fix an issue where the click location was
    // getting out of sync (see bug 1548687).
    this.updatePositionTask = new DeferredTask(() => {
      if (this.browser && this.browser.isRemoteBrowser) {
        // Select boxes can appear in the wrong spot after scrolling, this will
        // clear that up. Bug 1390445.
        this.browser.frameLoader.requestUpdatePosition();
      }
    }, 100);

    this._embedderElement = null;
    this._promiseDisconnected = new Promise(
      resolve => (this._resolveDisconnected = resolve)
    );
  }

  connectedCallback() {
    window.addEventListener("scroll", this, true);
    const { embedderElement } = top.browsingContext;
    this._embedderElement = embedderElement;
    embedderElement.addEventListener("FullZoomChange", this);
    embedderElement.addEventListener("TextZoomChange", this);
  }

  disconnectedCallback() {
    this._resolveDisconnected();
    window.removeEventListener("scroll", this, true);
    this._embedderElement?.removeEventListener("FullZoomChange", this);
    this._embedderElement?.removeEventListener("TextZoomChange", this);
    this._embedderElement = null;
  }

  handleEvent(e) {
    switch (e.type) {
      case "scroll":
        return this.updatePositionTask.arm();
      case "FullZoomChange":
      case "TextZoomChange":
        return this.maybeUpdateZoom();
    }
    return undefined;
  }

  maybeUpdateZoom() {
    let bc = this.browser?.browsingContext;
    let topBc = top.browsingContext;
    if (!bc || !topBc) {
      return;
    }
    // Use the same full-zoom as our top window.
    bc.fullZoom = topBc.fullZoom;
    bc.textZoom = topBc.textZoom;
  }

  setAddon(addon) {
    this.addon = addon;
  }

  destroyBrowser() {
    this.textContent = "";
  }

  ensureBrowserCreated() {
    if (this.childElementCount === 0) {
      this.render();
    }
  }

  async render() {
    let { addon } = this;
    if (!addon) {
      throw new Error("addon required to create inline options");
    }

    let browser = document.createXULElement("browser");
    browser.setAttribute("type", "content");
    browser.setAttribute("disableglobalhistory", "true");
    browser.setAttribute("messagemanagergroup", "webext-browsers");
    browser.setAttribute("id", "addon-inline-options");
    browser.setAttribute("class", "addon-inline-options");
    browser.setAttribute("transparent", "true");
    browser.setAttribute("forcemessagemanager", "true");
    browser.setAttribute("autocompletepopup", "PopupAutoComplete");

    let { optionsURL, optionsBrowserStyle } = addon;
    if (addon.isWebExtension) {
      let policy = ExtensionParent.WebExtensionPolicy.getByID(addon.id);
      browser.setAttribute(
        "initialBrowsingContextGroupId",
        policy.browsingContextGroupId
      );
    }

    let readyPromise;
    let remoteSubframes = window.docShell.QueryInterface(
      Ci.nsILoadContext
    ).useRemoteSubframes;
    // For now originAttributes have no effect, which will change if the
    // optionsURL becomes anything but moz-extension* or we start considering
    // OA for extensions.
    var oa = E10SUtils.predictOriginAttributes({ browser });
    let loadRemote = E10SUtils.canLoadURIInRemoteType(
      optionsURL,
      remoteSubframes,
      E10SUtils.EXTENSION_REMOTE_TYPE,
      oa
    );
    if (loadRemote) {
      browser.setAttribute("remote", "true");
      browser.setAttribute("remoteType", E10SUtils.EXTENSION_REMOTE_TYPE);

      readyPromise = promiseEvent("XULFrameLoaderCreated", browser);
    } else {
      readyPromise = promiseEvent("load", browser, true);
    }

    this.appendChild(browser);
    this.browser = browser;

    // Force bindings to apply synchronously.
    browser.clientTop;

    await readyPromise;

    this.maybeUpdateZoom();

    if (!browser.messageManager) {
      // If the browser.messageManager is undefined, the browser element has
      // been removed from the document in the meantime (e.g. due to a rapid
      // sequence of addon reload), return null.
      return;
    }

    ExtensionParent.apiManager.emit("extension-browser-inserted", browser);

    await new Promise(resolve => {
      let messageListener = {
        receiveMessage({ name, data }) {
          if (name === "Extension:BrowserResized") {
            browser.style.height = `${data.height}px`;
          } else if (name === "Extension:BrowserContentLoaded") {
            resolve();
          }
        },
      };

      let mm = browser.messageManager;

      if (!mm) {
        // If the browser.messageManager is undefined, the browser element has
        // been removed from the document in the meantime (e.g. due to a rapid
        // sequence of addon reload), return null.
        resolve();
        return;
      }

      mm.loadFrameScript(
        "chrome://extensions/content/ext-browser-content.js",
        false,
        true
      );
      mm.addMessageListener("Extension:BrowserContentLoaded", messageListener);
      mm.addMessageListener("Extension:BrowserResized", messageListener);

      let browserOptions = {
        fixedWidth: true,
        isInline: true,
      };

      if (optionsBrowserStyle) {
        // aboutaddons.js is not used on Android. extension.css is included in
        // Firefox desktop and Thunderbird.
        // eslint-disable-next-line mozilla/no-browser-refs-in-toolkit
        browserOptions.stylesheets = ["chrome://browser/content/extension.css"];
      }

      mm.sendAsyncMessage("Extension:InitBrowser", browserOptions);

      if (browser.isConnectedAndReady) {
        this.fixupAndLoadURIString(optionsURL);
      } else {
        // browser custom element does opt-in the delayConnectedCallback
        // behavior (see connectedCallback in the custom element definition
        // from browser-custom-element.mjs) and so calling browser.loadURI
        // would fail if the about:addons document is not yet fully loaded.
        Promise.race([
          promiseEvent("DOMContentLoaded", document),
          this._promiseDisconnected,
        ]).then(() => {
          this.fixupAndLoadURIString(optionsURL);
        });
      }
    });
  }

  fixupAndLoadURIString(uriString) {
    if (!this.browser || !this.browser.isConnectedAndReady) {
      throw new Error("Fail to loadURI");
    }

    this.browser.fixupAndLoadURIString(uriString, {
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
    });
  }
}
customElements.define("inline-options-browser", InlineOptionsBrowser);

class AddonDetails extends HTMLElement {
  connectedCallback() {
    if (!this.children.length) {
      this.render();
    }
    this.deck.addEventListener("view-changed", this);
    this.descriptionShowMoreButton.addEventListener("click", this);
  }

  disconnectedCallback() {
    this.inlineOptions.destroyBrowser();
    this.deck.removeEventListener("view-changed", this);
    this.descriptionShowMoreButton.removeEventListener("click", this);
  }

  handleEvent(e) {
    if (e.type == "view-changed" && e.target == this.deck) {
      switch (this.deck.selectedViewName) {
        case "release-notes": {
          let releaseNotes = this.querySelector("update-release-notes");
          let uri = this.releaseNotesUri;
          if (uri) {
            releaseNotes.loadForUri(uri);
          }
          break;
        }
        case "preferences":
          if (getOptionsType(this.addon) == "inline") {
            this.inlineOptions.ensureBrowserCreated();
          }
          break;
      }

      // When a details view is rendered again, the default details view is
      // unconditionally shown. So if any other tab is selected, do not save
      // the current scroll offset, but start at the top of the page instead.
      ScrollOffsets.canRestore = this.deck.selectedViewName === "details";
    } else if (
      e.type == "click" &&
      e.target == this.descriptionShowMoreButton
    ) {
      this.toggleDescription();
    }
  }

  onInstalled() {
    let policy = WebExtensionPolicy.getByID(this.addon.id);
    let extension = policy && policy.extension;
    if (extension && extension.startupReason === "ADDON_UPGRADE") {
      // Ensure the options browser is recreated when a new version starts.
      this.extensionShutdown();
      this.extensionStartup();
    }
  }

  onDisabled() {
    this.extensionShutdown();
  }

  onEnabled() {
    this.extensionStartup();
  }

  extensionShutdown() {
    this.inlineOptions.destroyBrowser();
  }

  extensionStartup() {
    if (this.deck.selectedViewName === "preferences") {
      this.inlineOptions.ensureBrowserCreated();
    }
  }

  toggleDescription() {
    this.descriptionCollapsed = !this.descriptionCollapsed;

    this.descriptionWrapper.classList.toggle(
      "addon-detail-description-collapse",
      this.descriptionCollapsed
    );

    this.descriptionShowMoreButton.hidden = false;
    document.l10n.setAttributes(
      this.descriptionShowMoreButton,
      this.descriptionCollapsed
        ? "addon-detail-description-expand"
        : "addon-detail-description-collapse"
    );
  }

  get releaseNotesUri() {
    let { releaseNotesURI } = getUpdateInstall(this.addon) || this.addon;
    return releaseNotesURI;
  }

  setAddon(addon) {
    this.addon = addon;
  }

  update() {
    let { addon } = this;

    // Hide tab buttons that won't have any content.
    let getButtonByName = name =>
      this.tabGroup.querySelector(`[name="${name}"]`);
    let permsBtn = getButtonByName("permissions");
    permsBtn.hidden = addon.type != "extension";
    let notesBtn = getButtonByName("release-notes");
    notesBtn.hidden = !this.releaseNotesUri;
    let prefsBtn = getButtonByName("preferences");
    prefsBtn.hidden = getOptionsType(addon) !== "inline";
    if (prefsBtn.hidden) {
      if (this.deck.selectedViewName === "preferences") {
        this.deck.selectedViewName = "details";
      }
    } else {
      isAddonOptionsUIAllowed(addon).then(allowed => {
        prefsBtn.hidden = !allowed;
      });
    }

    // Override the deck button string when the feature is enabled, which isn't
    // the case by default for now.
    if (DATA_COLLECTION_PERMISSIONS_ENABLED) {
      permsBtn.setAttribute("data-l10n-id", "permissions-data-addon-button");
    }

    // Hide the tab group if "details" is the only visible button.
    let tabGroupButtons = this.tabGroup.querySelectorAll(".tab-button");
    this.tabGroup.hidden = Array.from(tabGroupButtons).every(button => {
      return button.name == "details" || button.hidden;
    });

    // Show the update check button if necessary. The button might not exist if
    // the add-on doesn't support updates.
    let updateButton = this.querySelector('[action="update-check"]');
    if (updateButton) {
      updateButton.hidden =
        this.addon.updateInstall || AddonManager.shouldAutoUpdate(this.addon);
    }

    // Set the value for auto updates.
    let inputs = this.querySelectorAll(".addon-detail-row-updates input");
    for (let input of inputs) {
      input.checked = input.value == addon.applyBackgroundUpdates;
    }
  }

  renderDescription(addon) {
    this.descriptionWrapper = this.querySelector(
      ".addon-detail-description-wrapper"
    );
    this.descriptionContents = this.querySelector(".addon-detail-description");
    this.descriptionShowMoreButton = this.querySelector(
      ".addon-detail-description-toggle"
    );

    if (addon.getFullDescription) {
      this.descriptionContents.appendChild(addon.getFullDescription(document));
    } else if (addon.fullDescription) {
      this.descriptionContents.appendChild(nl2br(addon.fullDescription));
    }

    this.descriptionCollapsed = false;

    requestAnimationFrame(() => {
      const remSize = parseFloat(
        getComputedStyle(document.documentElement).fontSize
      );
      const { height } = this.descriptionContents.getBoundingClientRect();

      // collapse description if there are too many lines,i.e. height > (20 rem)
      if (height > 20 * remSize) {
        this.toggleDescription();
      }
    });
  }

  updateQuarantinedDomainsUserAllowed() {
    const { addon } = this;
    let quarantinedDomainsUserAllowedRow = this.querySelector(
      ".addon-detail-row-quarantined-domains"
    );
    if (addon.canChangeQuarantineIgnored) {
      quarantinedDomainsUserAllowedRow.hidden = false;
      quarantinedDomainsUserAllowedRow.nextElementSibling.hidden = false;
      quarantinedDomainsUserAllowedRow.querySelector(
        `[value="${addon.quarantineIgnoredByUser ? 1 : 0}"]`
      ).checked = true;
    } else {
      quarantinedDomainsUserAllowedRow.hidden = true;
      quarantinedDomainsUserAllowedRow.nextElementSibling.hidden = true;
    }
  }

  async render() {
    let { addon } = this;
    if (!addon) {
      throw new Error("addon-details must be initialized by setAddon");
    }

    this.textContent = "";
    this.appendChild(importTemplate("addon-details"));

    this.deck = this.querySelector("named-deck");
    this.tabGroup = this.querySelector(".tab-group");

    // Set the add-on for the permissions section.
    this.permissionsList = this.querySelector("addon-permissions-list");
    this.permissionsList.setAddon(addon);

    // Set the add-on for the sitepermissions section.
    this.sitePermissionsList = this.querySelector("addon-sitepermissions-list");
    if (addon.type == "sitepermission") {
      this.sitePermissionsList.setAddon(addon);
    }
    this.querySelector(".addon-detail-sitepermissions").hidden =
      addon.type !== "sitepermission";

    // Set the add-on for the mlmodel details.
    if (addon.type == "mlmodel") {
      this.mlModelDetails = this.querySelector("addon-mlmodel-details");
      this.mlModelDetails.setAddon(addon);
      this.querySelector(".addon-detail-mlmodel").hidden = false;
    }

    // Set the add-on for the preferences section.
    this.inlineOptions = this.querySelector("inline-options-browser");
    this.inlineOptions.setAddon(addon);

    // Full description.
    this.renderDescription(addon);
    this.querySelector(".addon-detail-contribute").hidden =
      !addon.contributionURL;
    this.querySelector(".addon-detail-row-updates").hidden = !hasPermission(
      addon,
      "upgrade"
    );

    if (addon.type != "extension") {
      // Don't show any private browsing related section for non-extension
      // addon types, because not relevant or they are either always allowed
      // (e.g. static themes).
      //
      // TODO(Bug 1799090): introduce ad-hoc UI for "sitepermission" addon type.
    } else if (addon.incognito == "not_allowed") {
      let pbRowNotAllowed = this.querySelector(
        ".addon-detail-row-private-browsing-disallowed"
      );
      pbRowNotAllowed.hidden = false;
      pbRowNotAllowed.nextElementSibling.hidden = false;
    } else if (!hasPermission(addon, "change-privatebrowsing")) {
      let pbRowRequired = this.querySelector(
        ".addon-detail-row-private-browsing-required"
      );
      pbRowRequired.hidden = false;
      pbRowRequired.nextElementSibling.hidden = false;
    } else {
      let pbRow = this.querySelector(".addon-detail-row-private-browsing");
      pbRow.hidden = false;
      pbRow.nextElementSibling.hidden = false;
      let isAllowed = await isAllowedInPrivateBrowsing(addon);
      pbRow.querySelector(`[value="${isAllowed ? 1 : 0}"]`).checked = true;
    }

    this.updateQuarantinedDomainsUserAllowed();

    // Author.
    let creatorRow = this.querySelector(".addon-detail-row-author");
    if (addon.creator) {
      let link = creatorRow.querySelector("a");
      link.hidden = !addon.creator.url;
      if (link.hidden) {
        creatorRow.appendChild(new Text(addon.creator.name));
      } else {
        link.href = formatUTMParams(
          "addons-manager-user-profile-link",
          addon.creator.url
        );
        link.target = "_blank";
        link.textContent = addon.creator.name;
      }
    } else {
      creatorRow.hidden = true;
    }

    // Version. Don't show a version for LWTs.
    let version = this.querySelector(".addon-detail-row-version");
    if (addon.version && !/@personas\.mozilla\.org/.test(addon.id)) {
      version.appendChild(new Text(addon.version));
    } else {
      version.hidden = true;
    }

    // Last updated.
    let updateDate = this.querySelector(".addon-detail-row-lastUpdated");
    if (addon.updateDate) {
      let lastUpdated = addon.updateDate.toLocaleDateString(undefined, {
        year: "numeric",
        month: "long",
        day: "numeric",
      });
      updateDate.appendChild(new Text(lastUpdated));
    } else {
      updateDate.hidden = true;
    }

    // Homepage.
    let homepageRow = this.querySelector(".addon-detail-row-homepage");
    if (addon.homepageURL) {
      let homepageURL = homepageRow.querySelector("a");
      homepageURL.href = addon.homepageURL;
      homepageURL.textContent = addon.homepageURL;
    } else {
      homepageRow.hidden = true;
    }

    // Rating.
    let ratingRow = this.querySelector(".addon-detail-row-rating");
    if (addon.reviewURL) {
      ratingRow.querySelector("moz-five-star").rating = addon.averageRating;
      let reviews = ratingRow.querySelector("a");
      reviews.href = formatUTMParams(
        "addons-manager-reviews-link",
        addon.reviewURL
      );
      document.l10n.setAttributes(reviews, "addon-detail-reviews-link", {
        numberOfReviews: addon.reviewCount,
      });
    } else {
      ratingRow.hidden = true;
    }

    this.update();
  }

  showPrefs() {
    if (getOptionsType(this.addon) == "inline") {
      this.deck.selectedViewName = "preferences";
      this.inlineOptions.ensureBrowserCreated();
    }
  }
}
customElements.define("addon-details", AddonDetails);

/**
 * A card component for managing an add-on. It should be initialized by setting
 * the add-on with `setAddon()` before being connected to the document.
 *
 *    let card = document.createElement("addon-card");
 *    card.setAddon(addon);
 *    document.body.appendChild(card);
 */
class AddonCard extends HTMLElement {
  connectedCallback() {
    // If we've already rendered we can just update, otherwise render.
    if (this.children.length) {
      this.update();
    } else {
      this.render();
    }
    this.registerListeners();
  }

  disconnectedCallback() {
    this.removeListeners();
  }

  get expanded() {
    return this.hasAttribute("expanded");
  }

  set expanded(val) {
    if (val) {
      this.setAttribute("expanded", "true");
    } else {
      this.removeAttribute("expanded");
    }
  }

  get updateInstall() {
    return this._updateInstall;
  }

  set updateInstall(install) {
    this._updateInstall = install;
    if (this.children.length) {
      this.update();
    }
  }

  get reloading() {
    return this.hasAttribute("reloading");
  }

  set reloading(val) {
    this.toggleAttribute("reloading", val);
  }

  /**
   * Set the add-on for this card. The card will be populated based on the
   * add-on when it is connected to the DOM.
   *
   * @param {AddonWrapper} addon The add-on to use.
   */
  setAddon(addon) {
    this.addon = addon;
    let install = getUpdateInstall(addon);
    if (
      install &&
      (isInState(install, "available") || isInState(install, "postponed"))
    ) {
      this.updateInstall = install;
    } else {
      this.updateInstall = null;
    }
    if (this.children.length) {
      this.render();
    }
  }

  async setAddonPermission(permission, type, action) {
    let { addon } = this;
    let perms = { origins: [], permissions: [] };

    if (!["add", "remove"].includes(action)) {
      throw new Error("invalid action for permission change");
    }

    if (type === "permission") {
      perms.permissions = [permission];
    } else if (type === "origin") {
      perms.origins = [permission];
    } else if (type === "data_collection") {
      perms.data_collection = [permission];
    } else {
      throw new Error("unknown permission type changed");
    }

    let normalized = ExtensionPermissions.normalizeOptional(
      perms,
      addon.optionalPermissions
    );

    let policy = WebExtensionPolicy.getByID(addon.id);
    ExtensionPermissions[action](addon.id, normalized, policy?.extension);
  }

  async handleEvent(e) {
    let { addon } = this;
    let action = e.target.getAttribute("action");

    if (e.type == "click") {
      switch (action) {
        case "toggle-disabled":
          // Keep the checked state the same until the add-on's state changes.
          e.target.checked = !addon.userDisabled;
          if (addon.userDisabled) {
            if (shouldShowPermissionsPrompt(addon)) {
              await showPermissionsPrompt(addon);
            } else {
              await addon.enable();
            }
          } else {
            await addon.disable();
          }
          break;
        case "always-activate":
          addon.userDisabled = false;
          break;
        case "never-activate":
          addon.userDisabled = true;
          break;
        case "update-check": {
          let { found } = await checkForUpdate(addon);
          if (!found) {
            this.sendEvent("no-update");
          }
          break;
        }
        case "install-postponed": {
          const { updateInstall } = this;
          if (updateInstall && isInState(updateInstall, "postponed")) {
            updateInstall.continuePostponedInstall();
          }
          break;
        }
        case "install-update":
          // Make sure that an update handler is attached to the install object
          // before starting the update installation (otherwise the user would
          // not be prompted for the new permissions requested if necessary),
          // and also make sure that a prompt handler attached from a closed
          // about:addons tab is replaced by the one attached by the currently
          // active about:addons tab.
          attachUpdateHandler(this.updateInstall);
          this.updateInstall.install().then(
            () => {
              detachUpdateHandler(this.updateInstall);
              // The card will update with the new add-on when it gets
              // installed.
              this.sendEvent("update-installed");
            },
            () => {
              detachUpdateHandler(this.updateInstall);
              // Update our state if the install is cancelled.
              this.update();
              this.sendEvent("update-cancelled");
            }
          );
          // Clear the install since it will be removed from the global list of
          // available updates (whether it succeeds or fails).
          this.updateInstall = null;
          break;
        case "contribute":
          windowRoot.ownerGlobal.openWebLinkIn(addon.contributionURL, "tab");
          break;
        case "preferences":
          if (getOptionsType(addon) == "tab") {
            openOptionsInTab(addon.optionsURL);
          } else if (getOptionsType(addon) == "inline") {
            gViewController.loadView(`detail/${this.addon.id}/preferences`);
          }
          break;
        case "remove":
          {
            this.panel.hide();
            if (!hasPermission(addon, "uninstall")) {
              this.sendEvent("remove-disabled");
              return;
            }
            if (addon.type == "mlmodel") {
              const source = e.target.nodeName == "BUTTON" ? "details" : "list";
              recordRemoveInitiatedTelemetry(addon, source);
            }
            let { BrowserAddonUI } = windowRoot.ownerGlobal;
            let { remove, report } =
              await BrowserAddonUI.promptRemoveExtension(addon);
            if (addon.type == "mlmodel") {
              recordRemoveConfirmationTelemetry(addon, remove);
            }
            if (remove) {
              await addon.uninstall(true);
              this.sendEvent("remove");
              if (report) {
                openAbuseReport({
                  addonId: addon.id,
                  reportEntryPoint: "uninstall",
                });
              }
            } else {
              this.sendEvent("remove-cancelled");
            }
          }
          break;
        case "expand":
          if (addon.type == "mlmodel") {
            recordListItemManageTelemetry(addon);
          }
          gViewController.loadView(`detail/${this.addon.id}`);
          break;
        case "more-options":
          // Open panel on click from the keyboard.
          if (e.inputSource == MouseEvent.MOZ_SOURCE_KEYBOARD) {
            this.panel.toggle(e);
          }
          break;
        case "report":
          this.panel.hide();
          openAbuseReport({ addonId: addon.id, reportEntryPoint: "menu" });
          break;
        case "link":
          if (e.target.getAttribute("url")) {
            windowRoot.ownerGlobal.openWebLinkIn(
              e.target.getAttribute("url"),
              "tab"
            );
          }
          break;
        default:
          // Handle a click on the card itself.
          if (
            !this.expanded &&
            (e.target === this.addonNameEl || !e.target.closest("a"))
          ) {
            e.preventDefault();
            gViewController.loadView(`detail/${this.addon.id}`);
          }
          break;
      }
    } else if (e.type == "toggle" && action == "toggle-permission") {
      let permission = e.target.getAttribute("permission-key");
      let type = e.target.getAttribute("permission-type");
      let fname = e.target.pressed ? "add" : "remove";
      this.setAddonPermission(permission, type, fname);
    } else if (e.type == "change") {
      let { name } = e.target;
      switch (name) {
        case "autoupdate": {
          addon.applyBackgroundUpdates = e.target.value;
          break;
        }
        case "private-browsing": {
          let policy = WebExtensionPolicy.getByID(addon.id);
          let extension = policy && policy.extension;

          if (e.target.value == "1") {
            await ExtensionPermissions.add(
              addon.id,
              PRIVATE_BROWSING_PERMS,
              extension
            );
          } else {
            await ExtensionPermissions.remove(
              addon.id,
              PRIVATE_BROWSING_PERMS,
              extension
            );
          }
          // Reload the extension if it is already enabled. This ensures any
          // change on the private browsing permission is properly handled.
          if (addon.isActive) {
            this.reloading = true;
            // Reloading will trigger an enable and update the card.
            addon.reload();
          } else {
            // Update the card if the add-on isn't active.
            this.update();
          }
          break;
        }
        case "quarantined-domains-user-allowed": {
          addon.quarantineIgnoredByUser = e.target.value == "1";
          break;
        }
      }
    } else if (e.type == "mousedown") {
      // Open panel on mousedown when the mouse is used.
      if (action == "more-options" && e.button == 0) {
        this.panel.toggle(e);
      }
    } else if (e.type === "shown" || e.type === "hidden") {
      let panelOpen = e.type === "shown";
      // The card will be dimmed if it's disabled, but when the panel is open
      // that should be reverted so the menu items can be easily read.
      this.toggleAttribute("panelopen", panelOpen);
      this.optionsButton.setAttribute("aria-expanded", panelOpen);
    }
  }

  get panel() {
    return this.card.querySelector("panel-list");
  }

  get postponedMessageBar() {
    return this.card.querySelector(".update-postponed-bar");
  }

  registerListeners() {
    this.addEventListener("change", this);
    this.addEventListener("click", this);
    this.addEventListener("mousedown", this);
    this.addEventListener("toggle", this);
    this.panel.addEventListener("shown", this);
    this.panel.addEventListener("hidden", this);
  }

  removeListeners() {
    this.removeEventListener("change", this);
    this.removeEventListener("click", this);
    this.removeEventListener("mousedown", this);
    this.removeEventListener("toggle", this);
    this.panel.removeEventListener("shown", this);
    this.panel.removeEventListener("hidden", this);
  }

  /**
   * Update the card's contents based on the previously set add-on. This should
   * be called if there has been a change to the add-on.
   */
  update() {
    let { addon, card } = this;

    card.setAttribute("active", addon.isActive);

    // Set the icon or theme preview.
    let iconEl = card.querySelector(".addon-icon");
    let preview = card.querySelector(".card-heading-image");
    if (addon.type == "theme") {
      iconEl.hidden = true;
      let screenshotUrl = getScreenshotUrlForAddon(addon);
      if (screenshotUrl) {
        preview.src = screenshotUrl;
      }
      preview.hidden = !screenshotUrl;
    } else {
      preview.hidden = true;
      iconEl.hidden = false;
      if (addon.type == "plugin") {
        iconEl.src = PLUGIN_ICON_URL;
      } else {
        iconEl.src =
          AddonManager.getPreferredIconURL(addon, 32, window) ||
          EXTENSION_ICON_URL;
      }
    }

    // Update the name.
    let name = this.addonNameEl;
    let setDisabledStyle = !(addon.isActive || addon.type === "theme");
    if (!setDisabledStyle) {
      name.textContent = addon.name;
      name.removeAttribute("data-l10n-id");
    } else {
      document.l10n.setAttributes(name, "addon-name-disabled", {
        name: addon.name,
      });
    }
    name.title = `${addon.name} ${addon.version}`;

    let toggleDisabledButton = card.querySelector('[action="toggle-disabled"]');
    if (toggleDisabledButton) {
      let toggleDisabledAction = addon.userDisabled ? "enable" : "disable";
      toggleDisabledButton.hidden = !hasPermission(addon, toggleDisabledAction);
      if (addon.type === "theme") {
        document.l10n.setAttributes(
          toggleDisabledButton,
          `${toggleDisabledAction}-addon-button`
        );
      } else if (
        addon.type === "extension" ||
        addon.type === "sitepermission"
      ) {
        toggleDisabledButton.pressed = !addon.userDisabled;
      }
    }

    // Set the items in the more options menu.
    this.options.update(this, addon, this.updateInstall);

    // Badge the more options button if there's an update.
    let moreOptionsButton = card.querySelector(".more-options-button");
    moreOptionsButton.classList.toggle(
      "more-options-button-badged",
      !!(this.updateInstall && isInState(this.updateInstall, "available"))
    );

    // Postponed update addon card message bar.
    const hasPostponedInstall =
      this.updateInstall && isInState(this.updateInstall, "postponed");
    this.postponedMessageBar.hidden = !hasPostponedInstall;

    // Hide the more options button if it's empty.
    moreOptionsButton.hidden = this.options.visibleItems.length === 0;

    // Ensure all badges are initially hidden.
    for (let node of card.querySelectorAll(".addon-badge")) {
      node.hidden = true;
    }

    // Set the private browsing badge visibility.
    // TODO: We don't show the badge for SitePermsAddon for now, but this should
    // be handled in Bug 1799090.
    if (addon.incognito != "not_allowed" && addon.type == "extension") {
      // Keep update synchronous, the badge can appear later.
      isAllowedInPrivateBrowsing(addon).then(isAllowed => {
        card.querySelector(".addon-badge-private-browsing-allowed").hidden =
          !isAllowed;
      });
    }

    // Show the recommended badges if needed.
    // Plugins don't have recommendationStates, so ensure a default.
    let states = addon.recommendationStates || [];
    for (let badgeName of states) {
      let badge = card.querySelector(`.addon-badge-${badgeName}`);
      if (badge) {
        badge.hidden = false;
      }
    }

    // Update description.
    card.querySelector(".addon-description").textContent = addon.description;

    this.updateMessage();

    // Update the details if they're shown.
    if (this.details) {
      this.details.update();
    }

    if (addon.type == "mlmodel") {
      this.optionsButton.hidden = this.expanded;
      const mlmodelHeaderAdditions = this.card.querySelector(
        "mlmodel-card-header-additions"
      );
      mlmodelHeaderAdditions.setAddon(addon);
      mlmodelHeaderAdditions.expanded = this.expanded;

      const mlmodelListAdditions = this.card.querySelector(
        "mlmodel-card-list-additions"
      );
      mlmodelListAdditions.setAddon(addon);
      mlmodelListAdditions.expanded = this.expanded;
    }

    this.sendEvent("update");
  }

  async updateMessage() {
    const messageBar = this.card.querySelector(".addon-card-message");

    const {
      linkUrl,
      linkId,
      linkSumoPage,
      messageId,
      messageArgs,
      type = "",
    } = await getAddonMessageInfo(this.addon, {
      isCardExpanded: this.expanded,
      isInDisabledSection:
        !this.expanded &&
        !!this.closest(`section.${this.addon.type}-disabled-section`),
    });

    if (messageId) {
      document.l10n.pauseObserving();
      document.l10n.setAttributes(messageBar, messageId, messageArgs);
      messageBar.setAttribute("data-l10n-attrs", "message");

      messageBar.innerHTML = "";
      if (linkUrl) {
        const linkButton = document.createElement("button");
        document.l10n.setAttributes(linkButton, linkId);
        linkButton.setAttribute("action", "link");
        linkButton.setAttribute("url", linkUrl);
        linkButton.setAttribute("slot", "actions");
        messageBar.append(linkButton);
      }

      if (linkSumoPage) {
        const sumoLinkEl = document.createElement("a", {
          is: "moz-support-link",
        });
        sumoLinkEl.setAttribute("support-page", linkSumoPage);
        sumoLinkEl.setAttribute("slot", "support-link");
        // Set a custom fluent id for the learn more if there
        // is one (otherwise moz-support-link custom element
        // will use the default "Learn more" localized string).
        if (linkId) {
          document.l10n.setAttributes(sumoLinkEl, linkId);
        }
        messageBar.append(sumoLinkEl);
      }

      document.l10n.resumeObserving();
      await document.l10n.translateFragment(messageBar);
      messageBar.setAttribute("type", type);
      messageBar.hidden = false;
    } else {
      messageBar.hidden = true;
    }
  }

  showPrefs() {
    this.details.showPrefs();
  }

  expand() {
    if (!this.children.length) {
      this.expanded = true;
    } else {
      throw new Error("expand() is only supported before render()");
    }
  }

  render() {
    this.textContent = "";

    let { addon } = this;
    if (!addon) {
      throw new Error("addon-card must be initialized with setAddon()");
    }

    this.setAttribute("addon-id", addon.id);

    this.card = importTemplate("card").firstElementChild;
    let headingId = ExtensionCommon.makeWidgetId(`${addon.id}-heading`);
    this.card.setAttribute("aria-labelledby", headingId);

    // Remove the toggle-disabled button(s) based on type.
    if (addon.type != "theme") {
      this.card.querySelector(".theme-enable-button").remove();
    }
    if (addon.type != "extension" && addon.type != "sitepermission") {
      this.card.querySelector(".extension-enable-button").remove();
    }
    let nameContainer = this.card.querySelector(".addon-name-container");
    let headingLevel = this.expanded ? "h1" : "h3";
    let nameHeading = document.createElement(headingLevel);
    nameHeading.classList.add("addon-name");
    nameHeading.id = headingId;
    if (!this.expanded) {
      let name = document.createElement("a");
      name.classList.add("addon-name-link");
      name.href = `addons://detail/${addon.id}`;
      nameHeading.appendChild(name);
      this.addonNameEl = name;
    } else {
      this.addonNameEl = nameHeading;
    }
    nameContainer.prepend(nameHeading);

    let panelType = addon.type == "plugin" ? "plugin-options" : "addon-options";
    this.options = document.createElement(panelType);
    this.options.render();
    this.card.appendChild(this.options);
    this.optionsButton = this.card.querySelector(".more-options-button");

    // Set the contents.
    this.update();

    let doneRenderPromise = Promise.resolve();
    if (this.expanded) {
      if (!this.details) {
        this.details = document.createElement("addon-details");
      }
      this.details.setAddon(this.addon);
      doneRenderPromise = this.details.render();

      // If we're re-rendering we still need to append the details since the
      // entire card was emptied at the beginning of the render.
      this.card.appendChild(this.details);
    }

    this.appendChild(this.card);

    if (this.expanded) {
      requestAnimationFrame(() => this.optionsButton.focus());
    }

    // Return the promise of details rendering to wait on in DetailView.
    return doneRenderPromise;
  }

  sendEvent(name, detail) {
    this.dispatchEvent(new CustomEvent(name, { detail }));
  }

  /**
   * AddonManager listener events.
   */

  onNewInstall(install) {
    this.updateInstall = install;
    this.sendEvent("update-found");
  }

  onInstallEnded(install) {
    this.setAddon(install.addon);
  }

  onInstallPostponed(install) {
    this.updateInstall = install;
    this.sendEvent("update-postponed");
  }

  onDisabled() {
    if (!this.reloading) {
      this.update();
    }
  }

  onEnabled() {
    this.reloading = false;
    this.update();
  }

  onInstalled() {
    // When a temporary addon is reloaded, onInstalled is triggered instead of
    // onEnabled.
    this.reloading = false;
    this.update();
  }

  onUninstalling() {
    // Dispatch a remove event, the DetailView is listening for this to get us
    // back to the list view when the current add-on is removed.
    this.sendEvent("remove");
  }

  onUpdateModeChanged() {
    this.update();
  }

  onPropertyChanged(addon, changed) {
    if (this.details && changed.includes("applyBackgroundUpdates")) {
      this.details.update();
    } else if (addon.type == "plugin" && changed.includes("userDisabled")) {
      this.update();
    }

    if (this.details && changed.includes("quarantineIgnoredByUser")) {
      this.details.updateQuarantinedDomainsUserAllowed();
    }

    if (changed.includes("blocklistState")) {
      this.update();
    }
  }

  /* Extension Permission change listener */
  async onChangePermissions(data) {
    let perms = data.added || data.removed;
    let hasAllSites = false;
    for (let permission of perms.permissions.concat(perms.origins)) {
      if (Extension.isAllSitesPermission(permission)) {
        hasAllSites = true;
        continue;
      }
      let target = document.querySelector(`[permission-key="${permission}"]`);
      let checked = !data.removed;
      if (target) {
        target.pressed = checked;
      }
    }
    if (hasAllSites) {
      // special-case for finding the all-sites target by attribute.
      let target = document.querySelector("[permission-all-sites]");
      let checked = await AddonCard.optionalAllSitesGranted(this.addon.id);
      target.pressed = checked;
    }
  }

  // Only covers optional_permissions in MV2 and all host permissions in MV3.
  static async optionalAllSitesGranted(addonId) {
    let granted = await ExtensionPermissions.get(addonId);
    return granted.origins.some(perm => Extension.isAllSitesPermission(perm));
  }
}
customElements.define("addon-card", AddonCard);

/**
 * A child element of `<recommended-addon-list>`. It should be initialized
 * by calling `setDiscoAddon()` first. Call `setAddon(addon)` if it has been
 * installed, and call `setAddon(null)` upon uninstall.
 *
 *    let discoAddon = new DiscoAddonWrapper({ ... });
 *    let card = document.createElement("recommended-addon-card");
 *    card.setDiscoAddon(discoAddon);
 *    document.body.appendChild(card);
 *
 *    AddonManager.getAddonsByID(discoAddon.id)
 *      .then(addon => card.setAddon(addon));
 */
class RecommendedAddonCard extends HTMLElement {
  /**
   * @param {DiscoAddonWrapper} addon
   *        The details of the add-on that should be rendered in the card.
   */
  setDiscoAddon(addon) {
    this.addonId = addon.id;

    // Save the information so we can install.
    this.discoAddon = addon;

    let card = importTemplate("card").firstElementChild;
    let heading = card.querySelector(".addon-name-container");
    heading.textContent = "";
    heading.append(importTemplate("addon-name-container-in-disco-card"));

    this.setCardContent(card, addon);
    if (addon.type != "theme") {
      card
        .querySelector(".addon-description")
        .append(importTemplate("addon-description-in-disco-card"));
      this.setCardDescription(card, addon);
    }
    this.registerButtons(card, addon);

    this.textContent = "";
    this.append(card);

    // We initially assume that the add-on is not installed.
    this.setAddon(null);
  }

  /**
   * Fills in all static parts of the card.
   *
   * @param {HTMLElement} card
   *        The primary content of this card.
   * @param {DiscoAddonWrapper} addon
   */
  setCardContent(card, addon) {
    // Set the icon.
    if (addon.type == "theme") {
      card.querySelector(".addon-icon").hidden = true;
    } else {
      card.querySelector(".addon-icon").src = AddonManager.getPreferredIconURL(
        addon,
        32,
        window
      );
    }

    // Set the theme preview.
    let preview = card.querySelector(".card-heading-image");
    if (addon.type == "theme") {
      let screenshotUrl = getScreenshotUrlForAddon(addon);
      if (screenshotUrl) {
        preview.src = screenshotUrl;
        preview.hidden = false;
      }
    } else {
      preview.hidden = true;
    }

    // Set the name.
    card.querySelector(".disco-addon-name").textContent = addon.name;

    // Set the author name and link to AMO.
    if (addon.creator) {
      let authorInfo = card.querySelector(".disco-addon-author");
      document.l10n.setAttributes(authorInfo, "created-by-author", {
        author: addon.creator.name,
      });
      // This is intentionally a link to the add-on listing instead of the
      // author page, because the add-on listing provides more relevant info.
      authorInfo.querySelector("a").href = formatUTMParams(
        "discopane-entry-link",
        addon.amoListingUrl
      );
      authorInfo.hidden = false;
    }
  }

  setCardDescription(card, addon) {
    // Set the description. Note that this is the editorial description, not
    // the add-on's original description that would normally appear on a card.
    card.querySelector(".disco-description-main").textContent =
      addon.editorialDescription;

    let hasStats = false;
    if (addon.averageRating) {
      hasStats = true;
      card.querySelector("moz-five-star").rating = addon.averageRating;
    } else {
      card.querySelector("moz-five-star").hidden = true;
    }

    if (addon.dailyUsers) {
      hasStats = true;
      let userCountElem = card.querySelector(".disco-user-count");
      document.l10n.setAttributes(userCountElem, "user-count", {
        dailyUsers: addon.dailyUsers,
      });
    }

    card.querySelector(".disco-description-statistics").hidden = !hasStats;
  }

  registerButtons(card, addon) {
    let installButton = card.querySelector("[action='install-addon']");
    if (addon.type == "theme") {
      document.l10n.setAttributes(installButton, "install-theme-button");
    } else {
      document.l10n.setAttributes(installButton, "install-extension-button");
    }

    this.addEventListener("click", this);
  }

  handleEvent(event) {
    let action = event.target.getAttribute("action");
    switch (action) {
      case "install-addon":
        this.installDiscoAddon();
        break;
      case "manage-addon":
        gViewController.loadView(`detail/${this.addonId}`);
        break;
    }
  }

  async installDiscoAddon() {
    let addon = this.discoAddon;
    let url = addon.sourceURI.spec;
    let install = await AddonManager.getInstallForURL(url, {
      name: addon.name,
      telemetryInfo: {
        source: "disco",
        taarRecommended: addon.taarRecommended,
      },
    });
    // We are hosted in a <browser> in about:addons, but we can just use the
    // main tab's browser since all of it is using the system principal.
    let browser = window.docShell.chromeEventHandler;
    AddonManager.installAddonFromWebpage(
      "application/x-xpinstall",
      browser,
      Services.scriptSecurityManager.getSystemPrincipal(),
      install
    );
  }

  /**
   * @param {AddonWrapper|null} addon
   *        The add-on that has been installed; null if it has been removed.
   */
  setAddon(addon) {
    let card = this.firstElementChild;
    card.querySelector("[action='install-addon']").hidden = !!addon;
    card.querySelector("[action='manage-addon']").hidden = !addon;

    this.dispatchEvent(new CustomEvent("disco-card-updated")); // For testing.
  }
}
customElements.define("recommended-addon-card", RecommendedAddonCard);

/**
 * A list view for add-ons of a certain type. It should be initialized with the
 * type of add-on to render and have section data set before being connected to
 * the document.
 *
 *    let list = document.createElement("addon-list");
 *    list.type = "plugin";
 *    list.setSections([{
 *      headingId: "plugin-section-heading",
 *      filterFn: addon => !addon.isSystem,
 *    }]);
 *    document.body.appendChild(list);
 */
class AddonList extends HTMLElement {
  constructor() {
    super();
    this.sections = [];
    this.pendingUninstallAddons = new Set();
    this._addonsToUpdate = new Set();
    this._userFocusListenersAdded = false;
    this._listeningForInstallUpdates = false;
  }

  async connectedCallback() {
    // Register the listener and get the add-ons, these operations should
    // happpen as close to each other as possible.
    this.registerListener();
    // Don't render again if we were rendered prior to being inserted.
    if (!this.children.length) {
      // Render the initial view.
      this.render();
    }
  }

  disconnectedCallback() {
    // Remove content and stop listening until this is connected again.
    this.textContent = "";
    this.removeListener();

    // Process any pending uninstall related to this list.
    for (const addon of this.pendingUninstallAddons) {
      if (isPending(addon, "uninstall")) {
        addon.uninstall();
      }
    }
    this.pendingUninstallAddons.clear();
  }

  /**
   * Configure the sections in the list.
   *
   * Warning: if filterFn uses criteria that are not tied to add-on events,
   * make sure to add an implementation that calls updateAddon(addon) as
   * needed. Not doing so can result in missing or out-of-date add-on cards!
   *
   * @param {object[]} sections
   *        The options for the section. Each entry in the array should have:
   *          headingId: The fluent id for the section's heading.
   *          filterFn: A function that determines if an add-on belongs in
   *                    the section.
   */
  setSections(sections) {
    this.sections = sections.map(section => Object.assign({}, section));
  }

  /**
   * Set the add-on type for this list. This will be used to filter the add-ons
   * that are displayed.
   *
   * @param {string} val The type to filter on.
   */
  set type(val) {
    this.setAttribute("type", val);
  }

  get type() {
    return this.getAttribute("type");
  }

  getSection(index) {
    return this.sections[index].node;
  }

  getCards(section) {
    return section.querySelectorAll("addon-card");
  }

  getCard(addon) {
    return this.querySelector(`addon-card[addon-id="${addon.id}"]`);
  }

  getPendingUninstallBar(addon) {
    return this.querySelector(`moz-message-bar[addon-id="${addon.id}"]`);
  }

  sortByFn(aAddon, bAddon) {
    return aAddon.name.localeCompare(bAddon.name);
  }

  async getAddons() {
    if (!this.type) {
      throw new Error(`type must be set to find add-ons`);
    }

    // Find everything matching our type, null will find all types.
    let type = this.type == "all" ? null : [this.type];
    let addons = await AddonManager.getAddonsByTypes(type);

    if (type == "theme") {
      await BuiltInThemes.ensureBuiltInThemes();
    }

    if (type == "mlmodel") {
      recordListViewTelemetry(addons.length);
    }

    // Put the add-ons into the sections, an add-on goes in the first section
    // that it matches the filterFn for. It might not go in any section.
    let sectionedAddons = this.sections.map(() => []);
    for (let addon of addons) {
      let index = this.sections.findIndex(({ filterFn }) => filterFn(addon));
      if (index != -1) {
        sectionedAddons[index].push(addon);
      } else if (isPending(addon, "uninstall")) {
        // A second tab may be opened on "about:addons" (or Firefox may
        // have crashed) while there are still "pending uninstall" add-ons.
        // Ensure to list them in the pendingUninstall message-bar-stack
        // when the AddonList is initially rendered.
        this.pendingUninstallAddons.add(addon);
      }
    }

    // Sort the add-ons in each section.
    for (let [index, section] of sectionedAddons.entries()) {
      let sortByFn = this.sections[index].sortByFn || this.sortByFn;
      section.sort(sortByFn);
    }

    return sectionedAddons;
  }

  createPendingUninstallStack() {
    const stack = document.createElement("message-bar-stack");
    stack.setAttribute("class", "pending-uninstall");
    stack.setAttribute("reverse", "");
    return stack;
  }

  addPendingUninstallBar(addon) {
    const stack = this.pendingUninstallStack;
    const mb = document.createElement("moz-message-bar");
    mb.setAttribute("addon-id", addon.id);
    mb.setAttribute("type", "info");

    const undo = document.createElement("button");
    undo.setAttribute("action", "undo");
    undo.addEventListener("click", () => {
      addon.cancelUninstall();
    });
    undo.setAttribute("slot", "actions");

    document.l10n.setAttributes(mb, "pending-uninstall-description2", {
      addon: addon.name,
    });
    mb.setAttribute("data-l10n-attrs", "message");
    document.l10n.setAttributes(undo, "pending-uninstall-undo-button");

    mb.appendChild(undo);
    stack.append(mb);
  }

  removePendingUninstallBar(addon) {
    const messagebar = this.getPendingUninstallBar(addon);
    if (messagebar) {
      messagebar.remove();
    }
  }

  createSectionHeading(headingIndex) {
    let { headingId, subheadingId } = this.sections[headingIndex];
    let frag = document.createDocumentFragment();
    let heading = document.createElement("h2");
    heading.classList.add("list-section-heading");
    document.l10n.setAttributes(heading, headingId);
    frag.append(heading);

    if (subheadingId) {
      heading.className = "header-name";
      let subheading = document.createElement("h3");
      subheading.classList.add("list-section-subheading");
      document.l10n.setAttributes(subheading, subheadingId);
      frag.append(subheading);
    }

    return frag;
  }

  createEmptyListMessage() {
    let emptyMessage = "list-empty-get-extensions-message";
    let linkPref = "extensions.getAddons.link.url";

    if (this.sections && this.sections.length) {
      if (this.sections[0].headingId == "locale-enabled-heading") {
        emptyMessage = "list-empty-get-language-packs-message";
        linkPref = "browser.dictionaries.download.url";
      } else if (this.sections[0].headingId == "dictionary-enabled-heading") {
        emptyMessage = "list-empty-get-dictionaries-message";
        linkPref = "browser.dictionaries.download.url";
      }
    }

    let messageContainer = document.createElement("p");
    messageContainer.id = "empty-addons-message";
    let a = document.createElement("a");
    a.href = Services.urlFormatter.formatURLPref(linkPref);
    a.setAttribute("target", "_blank");
    a.setAttribute("data-l10n-name", "get-extensions");
    document.l10n.setAttributes(messageContainer, emptyMessage, {
      domain: a.hostname,
    });
    messageContainer.appendChild(a);
    return messageContainer;
  }

  updateSectionIfEmpty(section) {
    // Clear the entire list if there are no `addon-card` childrens.
    if (!section.querySelectorAll("addon-card").length) {
      section.textContent = "";
    }
  }

  insertCardInto(card, sectionIndex) {
    let section = this.getSection(sectionIndex);
    let sectionCards = this.getCards(section);

    // If this is the first card in the section, create the heading.
    if (!sectionCards.length) {
      section.appendChild(this.createSectionHeading(sectionIndex));
    }

    // Find where to insert the card.
    let insertBefore = Array.from(sectionCards).find(
      otherCard => this.sortByFn(card.addon, otherCard.addon) < 0
    );
    // This will append if insertBefore is null.
    section.insertBefore(card, insertBefore || null);
  }

  addAddon(addon) {
    // Only insert add-ons of the right type.
    if (addon.type != this.type && this.type != "all") {
      this.sendEvent("skip-add", "type-mismatch");
      return;
    }

    let insertSection = this._addonSectionIndex(addon);

    // Don't add the add-on if it doesn't go in a section.
    if (insertSection == -1) {
      return;
    }

    // Create and insert the card.
    let card = document.createElement("addon-card");
    card.setAddon(addon);
    this.insertCardInto(card, insertSection);
    this.sendEvent("add", { id: addon.id });
  }

  sendEvent(name, detail) {
    this.dispatchEvent(new CustomEvent(name, { detail }));
  }

  removeAddon(addon) {
    let card = this.getCard(addon);
    if (card) {
      let section = card.parentNode;
      card.remove();
      this.updateSectionIfEmpty(section);
      this.sendEvent("remove", { id: addon.id });
    }
  }

  updateAddon(addon) {
    if (!this.getCard(addon)) {
      // Try to add the add-on right away.
      this.addAddon(addon);
    } else if (this._addonSectionIndex(addon) == -1) {
      // Try to remove the add-on right away.
      this._updateAddon(addon);
    } else if (this.isUserFocused) {
      // Queue up a change for when the focus is cleared.
      this.updateLater(addon);
    } else {
      // Not currently focused, make the change now.
      this.withCardAnimation(() => this._updateAddon(addon));
    }
  }

  updateLater(addon) {
    this._addonsToUpdate.add(addon);
    this._addUserFocusListeners();
  }

  _addUserFocusListeners() {
    if (this._userFocusListenersAdded) {
      return;
    }

    this._userFocusListenersAdded = true;
    this.addEventListener("mouseleave", this);
    this.addEventListener("hidden", this, true);
    this.addEventListener("focusout", this);
  }

  _removeUserFocusListeners() {
    if (!this._userFocusListenersAdded) {
      return;
    }

    this.removeEventListener("mouseleave", this);
    this.removeEventListener("hidden", this, true);
    this.removeEventListener("focusout", this);
    this._userFocusListenersAdded = false;
  }

  get hasMenuOpen() {
    return !!this.querySelector("panel-list[open]");
  }

  get isUserFocused() {
    return this.matches(":hover, :focus-within") || this.hasMenuOpen;
  }

  update() {
    if (this._addonsToUpdate.size) {
      this.withCardAnimation(() => {
        for (let addon of this._addonsToUpdate) {
          this._updateAddon(addon);
        }
        this._addonsToUpdate = new Set();
      });
    }
  }

  _getChildCoords() {
    let results = new Map();
    for (let child of this.querySelectorAll("addon-card")) {
      results.set(child, child.getBoundingClientRect());
    }
    return results;
  }

  withCardAnimation(changeFn) {
    if (shouldSkipAnimations()) {
      changeFn();
      return;
    }

    let origChildCoords = this._getChildCoords();

    changeFn();

    let newChildCoords = this._getChildCoords();
    let cards = this.querySelectorAll("addon-card");
    let transitionCards = [];
    for (let card of cards) {
      let orig = origChildCoords.get(card);
      let moved = newChildCoords.get(card);
      let changeY = moved.y - (orig || moved).y;
      let cardEl = card.firstElementChild;

      if (changeY != 0) {
        cardEl.style.transform = `translateY(${changeY * -1}px)`;
        transitionCards.push(card);
      }
    }
    requestAnimationFrame(() => {
      for (let card of transitionCards) {
        card.firstElementChild.style.transition = "transform 125ms";
      }

      requestAnimationFrame(() => {
        for (let card of transitionCards) {
          let cardEl = card.firstElementChild;
          cardEl.style.transform = "";
          cardEl.addEventListener("transitionend", function handler(e) {
            if (e.target == cardEl && e.propertyName == "transform") {
              cardEl.style.transition = "";
              cardEl.removeEventListener("transitionend", handler);
            }
          });
        }
      });
    });
  }

  _addonSectionIndex(addon) {
    return this.sections.findIndex(s => s.filterFn(addon));
  }

  _updateAddon(addon) {
    if (this._listeningForInstallUpdates) {
      // For stability of the UI, do not remove the card from the updates view
      // when it is already there, even when an update is installed.
      return;
    }
    let card = this.getCard(addon);
    if (card) {
      let sectionIndex = this._addonSectionIndex(addon);
      if (sectionIndex != -1) {
        // Move the card, if needed. This will allow an animation between
        // page sections and provides clearer events for testing.
        if (card.parentNode.getAttribute("section") != sectionIndex) {
          let { activeElement } = document;
          let refocus = card.contains(activeElement);
          let oldSection = card.parentNode;
          this.insertCardInto(card, sectionIndex);
          this.updateSectionIfEmpty(oldSection);
          if (refocus) {
            activeElement.focus();
          }
          this.sendEvent("move", { id: addon.id });
        }
      } else {
        this.removeAddon(addon);
      }
    }
  }

  renderSection(addons, index) {
    const { sectionClass } = this.sections[index];

    let section = document.createElement("section");
    section.setAttribute("section", index);
    if (sectionClass) {
      section.setAttribute("class", sectionClass);
    }

    // Render the heading and add-ons if there are any, except for mlmodel list
    // view which only shows installed models.
    if (this.type != "mlmodel" && addons.length) {
      section.appendChild(this.createSectionHeading(index));
    }

    for (let addon of addons) {
      let card = document.createElement("addon-card");
      card.setAddon(addon);
      card.render();
      section.appendChild(card);
    }

    return section;
  }

  async render() {
    this.textContent = "";

    let sectionedAddons = await this.getAddons();

    let frag = document.createDocumentFragment();

    // Render the pending uninstall message-bar-stack.
    this.pendingUninstallStack = this.createPendingUninstallStack();
    for (let addon of this.pendingUninstallAddons) {
      this.addPendingUninstallBar(addon);
    }
    frag.appendChild(this.pendingUninstallStack);

    if (this.type == "mlmodel") {
      frag.appendChild(document.createElement("mlmodel-list-intro"));
    }

    // Render the sections.
    for (let i = 0; i < sectionedAddons.length; i++) {
      this.sections[i].node = this.renderSection(sectionedAddons[i], i);
      frag.appendChild(this.sections[i].node);
    }

    // Add the "empty list message" elements (but omit it in the list view
    // related to the "mlmodel" type).
    if (this.type != "mlmodel") {
      // Render the placeholder that is shown when all sections are empty.
      // This call is after rendering the sections, because its visibility
      // is controlled through the general sibling combinator relative to
      // the sections (section ~).
      let message = this.createEmptyListMessage();
      frag.appendChild(message);
    }

    // Make sure fluent has set all the strings before we render. This will
    // avoid the height changing as strings go from 0 height to having text.
    await document.l10n.translateFragment(frag);
    this.appendChild(frag);
  }

  registerListener() {
    AddonManagerListenerHandler.addListener(this);
  }

  removeListener() {
    AddonManagerListenerHandler.removeListener(this);
  }

  handleEvent(e) {
    if (!this.isUserFocused || (e.type == "mouseleave" && !this.hasMenuOpen)) {
      this._removeUserFocusListeners();
      this.update();
    }
  }

  /**
   * AddonManager listener events.
   */

  onOperationCancelled(addon) {
    if (
      this.pendingUninstallAddons.has(addon) &&
      !isPending(addon, "uninstall")
    ) {
      this.pendingUninstallAddons.delete(addon);
      this.removePendingUninstallBar(addon);
    }
    this.updateAddon(addon);
  }

  onEnabled(addon) {
    this.updateAddon(addon);
  }

  onDisabled(addon) {
    this.updateAddon(addon);
  }

  onUninstalling(addon) {
    if (
      isPending(addon, "uninstall") &&
      (this.type === "all" || addon.type === this.type)
    ) {
      this.pendingUninstallAddons.add(addon);
      this.addPendingUninstallBar(addon);
      this.updateAddon(addon);
    }
  }

  onInstalled(addon) {
    this.updateAddon(addon);
  }

  onUninstalled(addon) {
    this.pendingUninstallAddons.delete(addon);
    this.removePendingUninstallBar(addon);
    this.removeAddon(addon);
  }

  onNewInstall(install) {
    if (this._listeningForInstallUpdates) {
      this._updateOnNewInstall(install);
    }
  }

  onInstallPostponed(install) {
    if (this._listeningForInstallUpdates) {
      this._updateOnNewInstall(install);
    }
  }

  listenForUpdates() {
    this._listeningForInstallUpdates = true;
  }

  async _updateOnNewInstall(install) {
    if (!install.existingAddon) {
      // Not from an update check.
      return;
    }
    // install.existingAddon can differ from the actual add-on (bug 2007749).
    // To make sure that we use the real, live add-on state, look it up again.
    const addon = await AddonManager.getAddonByID(install.existingAddon.id);
    if (addon) {
      this.updateAddon(addon);
    }
  }
}
customElements.define("addon-list", AddonList);

class RecommendedAddonList extends HTMLElement {
  connectedCallback() {
    if (this.isConnected) {
      this.loadCardsIfNeeded();
      this.updateCardsWithAddonManager();
    }
    AddonManagerListenerHandler.addListener(this);
  }

  disconnectedCallback() {
    AddonManagerListenerHandler.removeListener(this);
  }

  get type() {
    return this.getAttribute("type");
  }

  /**
   * Set the add-on type for this list. This will be used to filter the add-ons
   * that are displayed.
   *
   * Must be set prior to the first render.
   *
   * @param {string} val The type to filter on.
   */
  set type(val) {
    this.setAttribute("type", val);
  }

  get hideInstalled() {
    return this.hasAttribute("hide-installed");
  }

  /**
   * Set whether installed add-ons should be hidden from the list. If false,
   * installed add-ons will be shown with a "Manage" button, otherwise they
   * will be hidden.
   *
   * Must be set prior to the first render.
   *
   * @param {boolean} val Whether to show installed add-ons.
   */
  set hideInstalled(val) {
    this.toggleAttribute("hide-installed", val);
  }

  getCardById(addonId) {
    for (let card of this.children) {
      if (card.addonId === addonId) {
        return card;
      }
    }
    return null;
  }

  setAddonForCard(card, addon) {
    card.setAddon(addon);

    let wasHidden = card.hidden;
    card.hidden = this.hideInstalled && addon;

    if (wasHidden != card.hidden) {
      let eventName = card.hidden ? "card-hidden" : "card-shown";
      this.dispatchEvent(new CustomEvent(eventName, { detail: { card } }));
    }
  }

  /**
   * Whether the client ID should be preferred. This is disabled for themes
   * since they don't use the telemetry data and don't show the TAAR notice.
   */
  get preferClientId() {
    return !this.type || this.type == "extension";
  }

  async updateCardsWithAddonManager() {
    let cards = Array.from(this.children);
    let addonIds = cards.map(card => card.addonId);
    let addons = await AddonManager.getAddonsByIDs(addonIds);
    for (let [i, card] of cards.entries()) {
      let addon = addons[i];
      this.setAddonForCard(card, addon);
      if (addon) {
        // Already installed, move card to end.
        this.append(card);
      }
    }
  }

  async loadCardsIfNeeded() {
    // Use promise as guard. Also used by tests to detect when load completes.
    if (!this.cardsReady) {
      this.cardsReady = this._loadCards();
    }
    return this.cardsReady;
  }

  async _loadCards() {
    let recommendedAddons;
    try {
      recommendedAddons = await DiscoveryAPI.getResults(this.preferClientId);
    } catch (e) {
      return;
    }

    let frag = document.createDocumentFragment();
    for (let addon of recommendedAddons) {
      if (this.type && addon.type != this.type) {
        continue;
      }
      let card = document.createElement("recommended-addon-card");
      card.setDiscoAddon(addon);
      frag.append(card);
    }
    this.append(frag);
    await this.updateCardsWithAddonManager();
  }

  /**
   * AddonManager listener events.
   */

  onInstalled(addon) {
    let card = this.getCardById(addon.id);
    if (card) {
      this.setAddonForCard(card, addon);
    }
  }

  onUninstalled(addon) {
    let card = this.getCardById(addon.id);
    if (card) {
      this.setAddonForCard(card, null);
    }
  }
}
customElements.define("recommended-addon-list", RecommendedAddonList);

// Define views
gViewController.defineView("list", async type => {
  if (!AddonManager.hasAddonType(type)) {
    return null;
  }

  let frag = document.createDocumentFragment();
  let list = document.createElement("addon-list");
  list.type = type;

  let sections = [
    {
      headingId: type + "-enabled-heading",
      sectionClass: `${type}-enabled-section`,
      filterFn: addon =>
        !addon.hidden && addon.isActive && !isPending(addon, "uninstall"),
    },
  ];

  const disabledAddonsFilterFn = addon =>
    !addon.hidden && !addon.isActive && !isPending(addon, "uninstall");

  sections.push({
    headingId: getL10nIdMapping(`${type}-disabled-heading`),
    sectionClass: `${type}-disabled-section`,
    filterFn: disabledAddonsFilterFn,
  });

  // Show the colorway, forced-colors and smart window theme notices only
  // in themes list view.
  if (type === "theme") {
    const colorwayNotice = document.createElement("colorway-removal-notice");
    frag.appendChild(colorwayNotice);

    const forcedColorsNotice = document.createElement("forced-colors-notice");
    frag.appendChild(forcedColorsNotice);

    const smartWindowNotice = document.createElement(
      "smartwindow-themes-notice"
    );
    frag.appendChild(smartWindowNotice);
  }

  list.setSections(sections);
  frag.appendChild(list);

  // Show recommendations for themes and extensions.
  if (
    LIST_RECOMMENDATIONS_ENABLED &&
    (type == "extension" || type == "theme")
  ) {
    let elementName =
      type == "extension"
        ? "recommended-extensions-section"
        : "recommended-themes-section";
    let recommendations = document.createElement(elementName);
    // Start loading the recommendations. This can finish after the view load
    // event is sent.
    recommendations.render();
    frag.appendChild(recommendations);
  }

  await list.render();

  return frag;
});

gViewController.defineView("detail", async param => {
  let [id, selectedTab] = param.split("/");
  let addon = await AddonManager.getAddonByID(id);

  if (!addon) {
    return null;
  }

  if (addon.type === "mlmodel") {
    recordDetailsViewTelemetry(addon);
  }

  let card = document.createElement("addon-card");

  // Ensure the category for this add-on type is selected.
  document.querySelector("categories-box").selectType(addon.type);

  // Go back to the list view when the add-on is removed.
  card.addEventListener("remove", () =>
    gViewController.loadView(`list/${addon.type}`)
  );

  card.setAddon(addon);
  card.expand();
  await card.render();
  if (selectedTab === "preferences" && (await isAddonOptionsUIAllowed(addon))) {
    card.showPrefs();
  }

  return card;
});

gViewController.defineView("updates", async param => {
  let list = document.createElement("addon-list");
  list.type = "all";
  if (param == "available") {
    list.setSections([
      {
        headingId: "available-updates-heading",
        filterFn: addon => {
          // Filter the addons visible in the updates view using the same
          // criteria that is being used to compute the counter on the
          // available updates category button badge (updateAvailableCount).
          const install = getUpdateInstall(addon);
          return install && isManualUpdate(install);
        },
      },
    ]);
    list.listenForUpdates();
  } else if (param == "recent") {
    list.sortByFn = (a, b) => {
      if (a.updateDate > b.updateDate) {
        return -1;
      }
      if (a.updateDate < b.updateDate) {
        return 1;
      }
      return 0;
    };
    let updateLimit = new Date() - UPDATES_RECENT_TIMESPAN;
    list.setSections([
      {
        headingId: "recent-updates-heading",
        filterFn: addon =>
          !addon.hidden && addon.updateDate && addon.updateDate > updateLimit,
      },
    ]);
  } else {
    throw new Error(`Unknown updates view ${param}`);
  }

  await list.render();
  return list;
});

gViewController.defineView("discover", async () => {
  let discopane = document.createElement("discovery-pane");
  discopane.render();
  await document.l10n.translateFragment(discopane);
  return discopane;
});

gViewController.defineView("shortcuts", async extensionId => {
  // Force the extension category to be selected, in the case of a reload,
  // restart, or if the view was opened from another category's page.
  document.querySelector("categories-box").selectType("extension");

  let view = document.createElement("addon-shortcuts");
  if (extensionId && extensionId !== "shortcuts") {
    view.setAttribute("extension-id", extensionId);
  }
  await view.render();
  await document.l10n.translateFragment(view);
  return view;
});

/**
 * @param {Element} el The button element.
 */
function openAmoInTab(el, path) {
  let amoUrl = Services.urlFormatter.formatURLPref(
    "extensions.getAddons.link.url"
  );

  if (path) {
    amoUrl += path;
  }

  amoUrl = formatUTMParams("find-more-link-bottom", amoUrl);
  windowRoot.ownerGlobal.openTrustedLinkIn(amoUrl, "tab");
}

/**
 * Called when about:addons is loaded.
 */
async function initialize() {
  window.addEventListener(
    "unload",
    () => {
      // Clear out the document so the disconnectedCallback will trigger
      // properly and all of the custom elements can cleanup.
      document.body.textContent = "";
      AddonManagerListenerHandler.shutdown();
    },
    { once: true }
  );

  // Init UI and view management
  gViewController.initialize(document.getElementById("main"));

  document.querySelector("categories-box").initialize();
  AddonManagerListenerHandler.startup();

  // browser.js may call loadView here if it expects an EM-loaded notification
  gViewController.notifyEMLoaded();

  // Select an initial view if no listener has set one so far
  if (!gViewController.currentViewId) {
    if (history.state) {
      // If there is a history state to restore then use that
      await gViewController.renderState(history.state);
    } else {
      // Fallback to the last category or first valid category view otherwise.
      await gViewController.loadView(
        Services.prefs.getStringPref(
          PREF_UI_LASTCATEGORY,
          gViewController.defaultViewId
        )
      );
    }
  }
}

window.promiseInitialized = new Promise(resolve => {
  window.addEventListener(
    "load",
    () => {
      initialize().then(resolve);
    },
    { once: true }
  );
});
