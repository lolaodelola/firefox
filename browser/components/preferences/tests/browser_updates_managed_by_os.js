/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

add_task(async function test_updates_managed_by_os_message_bar() {
  await openPreferencesViaOpenPreferencesAPI("general", { leaveOpen: true });
  let doc = gBrowser.selectedBrowser.contentDocument;
  let win = gBrowser.selectedBrowser.contentWindow;

  let settingControl = doc.getElementById("updatesManagedByOS");
  await settingControl.updateComplete;

  let origIsPackagedApp = win.gIsPackagedApp;
  let isMessageBarHidden = win.AppConstants.MOZ_UPDATER && !origIsPackagedApp;
  is(
    BrowserTestUtils.isHidden(settingControl),
    isMessageBarHidden,
    "Message bar initial visibility matches expected state"
  );

  win.gIsPackagedApp = true;
  let setting = win.Preferences.getSetting("updatesManagedByOS");
  setting.onChange();
  await settingControl.updateComplete;

  ok(
    !BrowserTestUtils.isHidden(settingControl),
    "Message bar is visible when running as a packaged app"
  );

  win.gIsPackagedApp = origIsPackagedApp;
  gBrowser.removeCurrentTab();
});
