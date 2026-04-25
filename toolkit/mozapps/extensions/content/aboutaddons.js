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
// checkForUpdates is used as a window global by addon-page-options.mjs.
// nl2br is used as a window global by addon-details.mjs.
// getAddonMessageInfo is used as a window global by addon-card.mjs.
// getScreenshotUrlForAddon is used as a window global by
// recommended-addon-card.mjs.
// importTemplate is unused at this point in the stack (and to be removed in
// part 16);
// shouldSkipAnimations is used as a window global by addon-list.mjs.
// DiscoveryAPI is used as a window global by recommended-addon-list.mjs.
/* exported openAmoInTab, isAbuseReportSupported, checkForUpdates,
            nl2br, getAddonMessageInfo, getScreenshotUrlForAddon,
            importTemplate, DiscoveryAPI, shouldSkipAnimations */

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
