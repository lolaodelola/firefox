/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

add_task(async function () {
  let tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, null, false);

  tab.linkedBrowser.stop(); // stop the about:blank load

  let writeDomainURL = encodeURI(
    "data:text/html,<script>parent.postMessage(document.domain, '*');</script>"
  );

  let tests = [
    {
      name: "view image with background image",
      url: "http://mochi.test:8888/",
      element: "body",
      opensNewTab: true,
      go() {
        return SpecialPowers.spawn(
          gBrowser.selectedBrowser,
          [{ writeDomainURL }],
          async function (arg) {
            let contentBody = content.document.body;
            contentBody.style.backgroundImage =
              "url('" + arg.writeDomainURL + "')";

            return "context-viewimage";
          }
        );
      },
      verify(browser) {
        return SpecialPowers.spawn(browser, [], async function () {
          Assert.equal(
            content.document.body.textContent,
            "",
            "no domain was inherited for view image with background image"
          );
        });
      },
    },
    {
      name: "view image",
      url: "http://mochi.test:8888/",
      element: "img",
      opensNewTab: true,
      go() {
        return SpecialPowers.spawn(
          gBrowser.selectedBrowser,
          [{ writeDomainURL }],
          async function (arg) {
            let doc = content.document;
            let img = doc.createElement("img");
            img.height = 100;
            img.width = 100;
            img.setAttribute("src", arg.writeDomainURL);
            doc.body.insertBefore(img, doc.body.firstElementChild);

            return "context-viewimage";
          }
        );
      },
      verify(browser) {
        return SpecialPowers.spawn(browser, [], async function () {
          Assert.equal(
            content.document.body.textContent,
            "",
            "no domain was inherited for view image"
          );
        });
      },
    },
  ];

  let contentAreaContextMenu = document.getElementById(
    "contentAreaContextMenu"
  );

  for (let test of tests) {
    let loadedPromise = BrowserTestUtils.browserLoaded(
      gBrowser.selectedBrowser
    );
    BrowserTestUtils.startLoadingURIString(gBrowser, test.url);
    await loadedPromise;

    info("Run subtest " + test.name);
    let commandToRun = await test.go();

    let popupShownPromise = BrowserTestUtils.waitForEvent(
      contentAreaContextMenu,
      "popupshown"
    );

    let browsingContext = gBrowser.selectedBrowser.browsingContext;

    await new Promise(r => {
      SimpleTest.executeSoon(r);
    });

    while (true) {
      try {
        await BrowserTestUtils.synthesizeMouse(
          test.element,
          3,
          3,
          { type: "contextmenu", button: 2 },
          browsingContext
        );
      } catch (ex) {
        continue;
      }
      break;
    }

    await popupShownPromise;
    info("onImage: " + gContextMenu.onImage);

    let loadedAfterCommandPromise = test.opensNewTab
      ? BrowserTestUtils.waitForNewTab(gBrowser, null, true)
      : BrowserTestUtils.browserLoaded(gBrowser.selectedBrowser);
    let popupHiddenPromise = BrowserTestUtils.waitForEvent(
      contentAreaContextMenu,
      "popuphidden"
    );
    contentAreaContextMenu.activateItem(document.getElementById(commandToRun));
    let result = await loadedAfterCommandPromise;

    await test.verify(
      test.opensNewTab ? result.linkedBrowser : gBrowser.selectedBrowser
    );

    await popupHiddenPromise;

    if (test.opensNewTab) {
      await BrowserTestUtils.removeTab(result);
    }
  }

  await BrowserTestUtils.removeTab(tab);
});

// Test that data: URI iframes don't inherit the domain from the parent page.
// This verifies the same security property as the context menu tests above,
// but checks the iframe content directly instead of navigating to top-level.
add_task(async function test_data_uri_iframe_domain_isolation() {
  let tab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    "http://mochi.test:8888/"
  );

  let writeDomainURL = encodeURI(
    "data:text/html,<script>parent.postMessage(document.domain, '*');</script>"
  );

  let receivedDomain = await SpecialPowers.spawn(
    tab.linkedBrowser,
    [writeDomainURL],
    async function (dataURL) {
      let doc = content.document;
      let iframe = doc.createElement("iframe");

      return new Promise(resolve => {
        content.addEventListener(
          "message",
          function onMessage(event) {
            if (event.source !== iframe.contentWindow) {
              return;
            }
            content.removeEventListener("message", onMessage);
            resolve(event.data);
          },
          { capture: true }
        );

        iframe.setAttribute("src", dataURL);
        doc.body.insertBefore(iframe, doc.body.firstElementChild);
      });
    }
  );

  is(receivedDomain, "", "no domain was inherited for data: URI iframe");

  await BrowserTestUtils.removeTab(tab);
});
