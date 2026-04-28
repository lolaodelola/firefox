/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const MOCK_SHARE_URL = "https://share.firefox.com/mockShare001";

add_task(async function test_ServerErrors() {
  await withContentSharingMockServer(async server => {
    const share = {
      type: "tabs",
      title: "1 Tabs",
      links: [{ url: "https://example.com", title: "Example" }],
    };

    let shareUrl = await ContentSharingUtils.createShareableLink(share);

    Assert.equal(shareUrl, MOCK_SHARE_URL, "Got share url");

    // Set the response status to something that can be retried
    server.reset();
    server.mockResponseStatus = 503;
    server.mockResponse = {};

    shareUrl = await ContentSharingUtils.createShareableLink(share);
    Assert.strictEqual(
      shareUrl,
      undefined,
      "The server never returned a valid response"
    );

    Assert.equal(server.requests.length, 5, "Server received 5 requests");

    // Set the response status to something that cannot be retried
    server.reset();
    server.mockResponseStatus = 401;
    server.mockResponse = {};

    await ContentSharingUtils.createShareableLink(share);
    Assert.equal(server.requests.length, 1, "Server received one request");

    // Set the response status to something that can be retried
    server.reset();
    server.mockResponseStatus = 503;
    server.mockResponse = {};

    let promise = ContentSharingUtils.createShareableLink(share);
    // eslint-disable-next-line mozilla/no-arbitrary-setTimeout
    await new Promise(r => setTimeout(r, 100));

    server.mockResponseStatus = 201;
    server.mockResponse = { url: MOCK_SHARE_URL };

    shareUrl = await promise;
    Assert.equal(shareUrl, MOCK_SHARE_URL, "Got share url");
    Assert.greater(
      server.requests.length,
      1,
      "Server received more than one request"
    );
  });
});
