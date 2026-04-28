/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

import { SettingGroupManager } from "chrome://browser/content/preferences/config/SettingGroupManager.mjs";

// The setting classes, Preferences.addSetting registrations, Multilingual
// helper, and gMainPane language/translation methods still live in main.js
// and run when the preferences page loads. This module owns the four
// SettingGroupManager group configs that the Languages pane renders.

SettingGroupManager.registerGroups({
  browserLanguage: {
    inProgress: true,
    l10nId: "browser-language-heading",
    headingLevel: 2,
    iconSrc: "chrome://browser/skin/sidebar/firefox.svg",
    items: [
      {
        id: "browserLanguagePreferred",
        l10nId: "browser-language-preferred-label",
        control: "moz-select",
      },
      {
        id: "browserLanguageFallback",
        l10nId: "browser-language-fallback-label",
        control: "moz-select",
      },
      {
        id: "useSystemLocale",
        l10nId: "use-system-locale",
        get l10nArgs() {
          let regionalPrefsLocales = Services.locale.regionalPrefsLocales;
          if (!regionalPrefsLocales.length) {
            return { localeName: "und" };
          }
          let [systemLocale] = regionalPrefsLocales;
          let [displayName] = Services.intl.getLocaleDisplayNames(
            undefined,
            [systemLocale],
            { preferNative: true }
          );
          return { localeName: displayName || systemLocale };
        },
      },
      {
        id: "browserLanguageMessage",
        control: "browser-language-restart-message",
      },
    ],
  },
  websiteLanguage: {
    inProgress: true,
    l10nId: "website-language-heading",
    headingLevel: 2,
    iconSrc: "chrome://global/skin/icons/defaultFavicon.svg",
    items: [
      {
        id: "websiteLanguageWrapper",
        control: "moz-box-group",
        controlAttrs: {
          type: "reorderable-list",
        },
        options: [
          {
            id: "websiteLanguagePickerWrapper",
            l10nId: "website-preferred-language",
            key: "addlanguage",
            control: "moz-box-item",
            slot: "header",
            items: [
              {
                id: "websiteLanguagePicker",
                slot: "actions",
                control: "moz-select",
                options: [
                  {
                    control: "moz-option",
                    l10nId: "website-add-language",
                    controlAttrs: {
                      value: "-1",
                    },
                  },
                ],
              },
              {
                id: "websiteLanguageAddLanguage",
                slot: "actions",
                control: "moz-button",
                iconSrc: "chrome://global/skin/icons/plus.svg",
                l10nId: "website-add-language-button",
              },
            ],
          },
        ],
      },
    ],
  },
  translations: {
    inProgress: true,
    l10nId: "settings-translations-header",
    iconSrc: "chrome://browser/skin/translations.svg",
    supportPage: "website-translation",
    headingLevel: 2,
    items: [
      {
        id: "offerTranslations",
        l10nId: "settings-translations-offer-to-translate-label",
      },
      {
        id: "translationsManageButton",
        l10nId: "settings-translations-more-settings-button",
        control: "moz-box-button",
      },
    ],
  },
  spellCheck: {
    l10nId: "settings-spellcheck-header",
    iconSrc: "chrome://global/skin/icons/check.svg",
    headingLevel: 2,
    items: [
      {
        id: "checkSpelling",
        l10nId: "check-user-spelling",
        supportPage: "how-do-i-use-firefox-spell-checker",
      },
      {
        id: "downloadDictionaries",
        l10nId: "spellcheck-download-dictionaries",
        control: "moz-box-link",
        controlAttrs: {
          href: Services.urlFormatter.formatURLPref(
            "browser.dictionaries.download.url"
          ),
        },
      },
      {
        id: "spellCheckPromo",
        l10nId: "spellcheck-promo",
        control: "moz-promo",
        controlAttrs: {
          imagesrc:
            "chrome://browser/content/preferences/spell-check-promo.svg",
          imagewidth: "large",
          imagedisplay: "cover",
        },
      },
    ],
  },
});
