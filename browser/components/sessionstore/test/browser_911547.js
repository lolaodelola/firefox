/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

// This test tests that session restore component does restore the right
// content security policy with the document. (The policy being tested
// disallows inline scripts).

add_task(async function test() {
  // create a tab that has a CSP
  let testURL =
    "http://mochi.test:8888/browser/browser/components/sessionstore/test/browser_911547_sample.html";
  let tab = (gBrowser.selectedTab = BrowserTestUtils.addTab(gBrowser, testURL));

  let browser = tab.linkedBrowser;
  await promiseBrowserLoaded(browser);

  // this is a baseline to ensure CSP is active
  // attempt to inject and run a script via inline (pre-restore, allowed)
  await injectInlineScript(
    browser,
    `document.getElementById("test_id1").value = "id1_modified";`
  );

  await SpecialPowers.spawn(browser, [], function () {
    is(
      content.document.getElementById("test_id1").value,
      "id1_initial",
      "CSP should block the inline script that modifies test_id"
    );
  });

  // close the tab while on the CSP page (no blob: URL in session history)
  await promiseRemoveTabAndSessionState(tab);

  // restore the tab
  tab = ss.undoCloseTab(window, 0);
  await promiseTabRestored(tab);
  browser = tab.linkedBrowser;

  // navigate to a blob: URI to verify CSP still works after restore
  let loadedPromise = promiseBrowserLoaded(browser);
  await SpecialPowers.spawn(browser, [], function () {
    const html =
      "<!DOCTYPE html><html><body>" +
      '<input type="text" id="test_id2" value="id2_initial">' +
      "<script>document.getElementById('test_id2').value = 'id2_modified';<\/script>" +
      "</body></html>";
    const blob = new Blob([html], { type: "text/html" });
    content.location.href = URL.createObjectURL(blob);
  });
  await loadedPromise;

  await SpecialPowers.spawn(browser, [], function () {
    // the blob: URI inherits the CSP and the inline script should be blocked
    is(
      content.document.getElementById("test_id2").value,
      "id2_initial",
      "CSP should block the inline script in the blob: URI after restore"
    );
  });

  // clean up
  gBrowser.removeTab(tab);
});

// injects an inline script element (with a text body)
function injectInlineScript(browser, scriptText) {
  return SpecialPowers.spawn(browser, [scriptText], function (text) {
    let scriptElt = content.document.createElement("script");
    scriptElt.type = "text/javascript";
    scriptElt.text = text;
    content.document.body.appendChild(scriptElt);
  });
}
