/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

function getSwitcherIconUrl(win) {
  let el = win.gURLBar.querySelector(".searchmode-switcher");
  let val = el.getAttribute("iconsrc");
  return val;
}

add_setup(async function setup() {
  requestLongerTimeout(5);
  await SpecialPowers.pushPrefEnv({
    set: [["browser.urlbar.unifiedSearchButton.always", true]],
  });
  registerCleanupFunction(() => PlacesUtils.history.clear());
});

// When the urlbar is unfocused / empty, the icon should be the magnifying glass.
add_task(async function test_icon_is_search_glass_when_empty() {
  await UrlbarTestUtils.promiseAutocompleteResultPopup({
    window,
    value: "",
  });

  await BrowserTestUtils.waitForCondition(
    () => getSwitcherIconUrl(window) === UrlbarUtils.ICON.SEARCH_GLASS,
    "Icon should be the magnifying glass when input is empty"
  );

  Assert.equal(
    getSwitcherIconUrl(window),
    UrlbarUtils.ICON.SEARCH_GLASS,
    "Icon is search glass when urlbar is empty"
  );
});

// When the user types a query and the top result is a search result,
// the icon should update to match the engine's icon.
add_task(async function test_icon_updates_to_engine_icon_on_search_result() {
  let engine = await SearchService.getDefault();
  let expectedIcon = await engine.getIconURL();

  await UrlbarTestUtils.promiseAutocompleteResultPopup({
    window,
    value: "hello",
  });

  await BrowserTestUtils.waitForCondition(() => {
    let result = window.gURLBar.view.getResultAtIndex(0);
    return (
      result?.type == UrlbarUtils.RESULT_TYPE.SEARCH &&
      result?.payload?.engine === engine.name
    );
  }, "Waiting for a default engine SEARCH result at index 0");

  await BrowserTestUtils.waitForCondition(
    () => getSwitcherIconUrl(window) === expectedIcon,
    "Waiting for icon to update to the default engine's icon"
  );

  Assert.equal(
    getSwitcherIconUrl(window),
    expectedIcon,
    "Icon should match the default engine's icon"
  );

  await UrlbarTestUtils.promisePopupClose(window);
});

// When the top result is a URL result, the icon should be the globe.
add_task(async function test_icon_updates_to_globe_on_url_result() {
  await PlacesTestUtils.addVisits("https://example.com");
  // registerCleanupFunction(() => PlacesUtils.history.clear());

  await UrlbarTestUtils.promiseAutocompleteResultPopup({
    window,
    value: "example.com",
  });

  await BrowserTestUtils.waitForCondition(() => {
    let result = window.gURLBar.view.getResultAtIndex(0);
    return result?.type == UrlbarUtils.RESULT_TYPE.URL;
  }, "Waiting for a URL result at index 0");

  await BrowserTestUtils.waitForCondition(
    () => getSwitcherIconUrl(window) === UrlbarUtils.ICON.GLOBE,
    "Waiting for icon to update to globe for URL result"
  );

  Assert.equal(
    getSwitcherIconUrl(window),
    UrlbarUtils.ICON.GLOBE,
    "Icon should be the globe when the top result is a URL"
  );

  await UrlbarTestUtils.promisePopupClose(window);
});

// When the top result is an autofill result, the icon should be the globe.
add_task(async function test_icon_updates_to_globe_on_autofill_result() {
  await PlacesTestUtils.addVisits("https://example.com/autofill-test");
  // registerCleanupFunction(() => PlacesUtils.history.clear());

  await UrlbarTestUtils.promiseAutocompleteResultPopup({
    window,
    value: "example.com/autofill",
  });

  await BrowserTestUtils.waitForCondition(() => {
    let result = window.gURLBar.view.getResultAtIndex(0);
    return result?.autofill;
  }, "Waiting for an autofill result at index 0");

  await BrowserTestUtils.waitForCondition(
    () => getSwitcherIconUrl(window) === UrlbarUtils.ICON.GLOBE,
    "Waiting for icon to update to globe for autofill result"
  );

  Assert.equal(
    getSwitcherIconUrl(window),
    UrlbarUtils.ICON.GLOBE,
    "Icon should be the globe when the top result is autofilled"
  );

  await UrlbarTestUtils.promisePopupClose(window);
});
