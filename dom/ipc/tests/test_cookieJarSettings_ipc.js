/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// Regression tests for RecvUpdateCookieJarSettings IPC validation.
// These verify that our monotonic-downgrade protections on isFixed,
// shouldResistFingerprinting, and hasFingerprintingRandomizationKey
// do not produce false positives for legitimate content processes.

const { XPCShellContentUtils } = ChromeUtils.importESModule(
  "resource://testing-common/XPCShellContentUtils.sys.mjs"
);

XPCShellContentUtils.init(this);

const server = XPCShellContentUtils.createHttpServer({
  hosts: ["example.com"],
});

server.registerPathHandler("/", (request, response) => {
  response.write("<!DOCTYPE html><html><body></body></html>");
});

registerCleanupFunction(() => {
  Services.prefs.clearUserPref("dom.security.https_first");
});

add_setup(() => {
  Services.prefs.setBoolPref("dom.security.https_first", false);
});

// Loading a page in a content process triggers RecvUpdateCookieJarSettings.
// This test verifies the validation accepts valid settings and the page loads.
add_task(async function test_cookieJarSettings_update_accepted() {
  let page = await XPCShellContentUtils.loadContentPage("http://example.com/", {
    remote: true,
  });

  let cookieBehavior = await page.spawn([], () => {
    return content.document.cookieJarSettings.cookieBehavior;
  });

  Assert.greaterOrEqual(
    cookieBehavior,
    0,
    "CookieJarSettings should be present and valid in content process"
  );

  await page.close();
});

// Verify shouldResistFingerprinting is a boolean (RFP on or off is controlled
// by prefs; we only verify the IPC message was accepted and the value is a bool).
add_task(async function test_shouldResistFingerprinting_accessible() {
  let page = await XPCShellContentUtils.loadContentPage("http://example.com/", {
    remote: true,
  });

  let rfp = await page.spawn([], () => {
    return content.document.cookieJarSettings.shouldResistFingerprinting;
  });

  Assert.equal(typeof rfp, "boolean", "shouldResistFingerprinting is a boolean");

  await page.close();
});

// Verify that fingerprintingRandomizationKey is accessible and is an array-like
// object (verifying the IPC message was accepted, not that the key is empty).
add_task(async function test_fingerprintingRandomizationKey_accessible() {
  let page = await XPCShellContentUtils.loadContentPage("http://example.com/", {
    remote: true,
  });

  let keyLen = await page.spawn([], () => {
    let key =
      content.document.cookieJarSettings.fingerprintingRandomizationKey;
    return key.length;
  });

  Assert.greaterOrEqual(
    keyLen,
    0,
    "fingerprintingRandomizationKey is accessible with non-negative length"
  );

  await page.close();
});

// Verify multiple page loads work (each triggers RecvUpdateCookieJarSettings).
add_task(async function test_repeated_cookieJarSettings_updates_accepted() {
  for (let i = 0; i < 3; i++) {
    let page = await XPCShellContentUtils.loadContentPage(
      "http://example.com/",
      { remote: true }
    );

    let cookieBehavior = await page.spawn([], () => {
      return content.document.cookieJarSettings.cookieBehavior;
    });

    Assert.greaterOrEqual(
      cookieBehavior,
      0,
      `CookieJarSettings update ${i + 1} should be accepted`
    );

    await page.close();
  }
});
