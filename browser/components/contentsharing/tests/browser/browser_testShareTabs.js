/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

add_task(async function test_handleShareTabs() {
  await withContentSharingMockServer(async server => {
    const tab1 = await BrowserTestUtils.openNewForegroundTab(
      gBrowser,
      "https://example.com"
    );
    const tab2 = await BrowserTestUtils.openNewForegroundTab(
      gBrowser,
      "https://example.com/1"
    );

    await ContentSharingUtils.handleShareTabs([tab1, tab2]);

    Assert.equal(
      server.requests.length,
      1,
      "Server received exactly one request"
    );

    const body = server.requests[0].body;

    await assertContentSharingModal(window, {
      share: body,
      url: server.mockResponse.url,
    });

    Assert.equal(body.type, "tabs", "Share type is 'tabs'");
    Assert.equal(
      body.title,
      "2 tabs",
      "Title reflects tab count for tab shares"
    );
    Assert.equal(body.links.length, 2, "Share contains 2 links");
    Assert.equal(
      body.links[0].url,
      tab1.linkedBrowser.currentURI.displaySpec,
      "First link URL matches tab 1"
    );
    Assert.equal(
      body.links[1].url,
      tab2.linkedBrowser.currentURI.displaySpec,
      "Second link URL matches tab 2"
    );

    gBrowser.removeTabs([tab1, tab2]);
  });
});
