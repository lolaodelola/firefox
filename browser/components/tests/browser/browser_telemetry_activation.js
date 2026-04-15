/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

async function handleCommandLine(args, state) {
  let newWinPromise;
  let target = args.at(-1);

  const EXISTING_FILE = Cc["@mozilla.org/file/local;1"].createInstance(
    Ci.nsIFile
  );
  EXISTING_FILE.initWithPath(getTestFilePath("dummy.pdf"));

  if (state == Ci.nsICommandLine.STATE_INITIAL_LAUNCH) {
    newWinPromise = BrowserTestUtils.waitForNewWindow({
      waitForAnyURLLoaded: false,
    });
  }

  let cmdLineHandler = Cc["@mozilla.org/browser/final-clh;1"].getService(
    Ci.nsICommandLineHandler
  );

  let fakeCmdLine = Cu.createCommandLine(args, EXISTING_FILE.parent, state);
  cmdLineHandler.handle(fakeCmdLine);

  if (newWinPromise) {
    let newWin = await newWinPromise;
    await BrowserTestUtils.waitForDocLoadAndStopIt(
      target,
      newWin.gBrowser.selectedBrowser
    );
    await BrowserTestUtils.closeWindow(newWin);
  } else {
    let tab = gBrowser.selectedTab;
    await BrowserTestUtils.waitForDocLoadAndStopIt(target, tab.linkedBrowser);
    BrowserTestUtils.removeTab(tab);
  }
}

// Returns the number of times the specified search activation occurred or 0 if
// no data is available for the given label.
function getWindowsStartSearchActivationCount(label) {
  return (
    Glean.browserEngagement.windowsStartSearchActivationCount[
      label
    ].testGetValue() ?? 0
  );
}

add_task(async function test_launched_unlike_windows_search_no_osint() {
  let label = "startup";
  let counterBefore = getWindowsStartSearchActivationCount(label);
  await handleCommandLine(
    ["-url", "https://bing.com/search?q=test"],
    Ci.nsICommandLine.STATE_INITIAL_LAUNCH
  );
  Assert.equal(
    getWindowsStartSearchActivationCount(label),
    counterBefore,
    `Does not increase a telemetry counter labeled "${label}" when called without -osint.`
  );
});

add_task(async function test_launched_unlike_windows_search_not_bing() {
  for (let label of ["startup", "new_tab"]) {
    let counterBefore = getWindowsStartSearchActivationCount(label);
    await handleCommandLine(
      ["-osint", "-url", "https://example.com/search?q=test"],
      Ci.nsICommandLine.STATE_INITIAL_LAUNCH
    );
    Assert.equal(
      getWindowsStartSearchActivationCount(label),
      counterBefore,
      `Does not increase the ${label} telemetry counter when the domain is not bing.`
    );
  }
});

add_task(async function test_launched_unlike_windows_search_no_search_path() {
  let label = "startup";
  let counterBefore = getWindowsStartSearchActivationCount(label);
  await handleCommandLine(
    ["-osint", "-url", "https://bing.com/"],
    Ci.nsICommandLine.STATE_INITIAL_LAUNCH
  );
  Assert.equal(
    getWindowsStartSearchActivationCount(label),
    counterBefore,
    `Does not increase a telemetry counter labeled "${label}" when called without /search path.`
  );
});

add_task(async function test_launched_like_windows_search() {
  let label = "startup";
  let counterBefore = getWindowsStartSearchActivationCount(label);
  await handleCommandLine(
    ["-osint", "-url", "https://bing.com/search?q=test"],
    Ci.nsICommandLine.STATE_INITIAL_LAUNCH
  );
  Assert.equal(
    getWindowsStartSearchActivationCount(label),
    counterBefore + 1,
    `Increases a telemetry counter labeled "${label}" when called with the /search path.`
  );
});

add_task(async function test_invoked_like_windows_search() {
  let label = "new_tab";
  let counterBefore = getWindowsStartSearchActivationCount(label);
  await handleCommandLine(
    ["-osint", "-url", "https://bing.com/search?q=test"],
    Ci.nsICommandLine.STATE_REMOTE_EXPLICIT
  );
  Assert.equal(
    getWindowsStartSearchActivationCount(label),
    counterBefore + 1,
    `Increases a telemetry counter labeled "${label}" when called with the /search path.`
  );
});
