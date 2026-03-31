/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

/**
 * Tests for the getEffectiveErrorId fallback behavior in
 * net-error-card.mjs.
 *
 * These tests verify three scenarios:
 * 1. A specific registered SSL error uses its own config.
 * 2. An unregistered specific error falls back to the general gErrorCode config.
 * 3. The deniedPortAccess error shows the correct intro text.
 */

async function openErrorTab(url) {
  let browser;
  let tab;
  let pageLoaded;
  await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    () => {
      gBrowser.selectedTab = BrowserTestUtils.addTab(gBrowser, url);
      browser = gBrowser.selectedBrowser;
      tab = gBrowser.selectedTab;
      pageLoaded = BrowserTestUtils.waitForErrorPage(browser);
    },
    false
  );
  await pageLoaded;
  return { browser, tab };
}

// SSL_ERROR_RX_RECORD_TOO_LONG is a registered specific error with an array
// introContent. When the net-error-card sees this errorCodeString it should
// use the specific config rather than the generic nssFailure2 fallback, and
// render two intro spans.
add_task(async function test_specific_registered_ssl_error() {
  info("Testing SSL_ERROR_RX_RECORD_TOO_LONG with felt privacy enabled");

  // Use a raw TCP server to land on an nssFailure2 error page, then inject a
  // mock errorInfo with errorCodeString set to SSL_ERROR_RX_RECORD_TOO_LONG.
  const serverSocket = Cc[
    "@mozilla.org/network/server-socket;1"
  ].createInstance(Ci.nsIServerSocket);
  serverSocket.init(-1, true, -1);
  const port = serverSocket.port;
  registerCleanupFunction(() => serverSocket.close());

  serverSocket.asyncListen({
    onSocketAccepted(socket, transport) {
      const output = transport.openOutputStream(
        Ci.nsITransport.OPEN_BLOCKING,
        0,
        0
      );
      const response =
        "HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
      output.write(response, response.length);
      output.close();
    },
    onStopListening() {},
  });

  const { browser, tab } = await openErrorTab(`https://localhost:${port}`);

  await SpecialPowers.spawn(browser, [], async () => {
    const doc = content.document;
    Assert.ok(
      doc.documentURI.startsWith("about:neterror"),
      "Should be on the error page"
    );

    const netErrorCard = await ContentTaskUtils.waitForCondition(
      () => doc.querySelector("net-error-card")?.wrappedJSObject,
      "net-error-card should be present"
    );
    await netErrorCard.getUpdateComplete();

    const mockErrorInfo = {
      errorCodeString: "SSL_ERROR_RX_RECORD_TOO_LONG",
      errorIsOverridable: false,
      channelStatus: 0,
      overridableErrorCategory: 0,
      validNotBefore: 0,
      validNotAfter: 0,
      certValidityRangeNotAfter: 0,
      certValidityRangeNotBefore: 0,
      issuerCommonName: "",
      errorMessage: "",
      hasHSTS: false,
      hasHPKP: false,
      certChainStrings: [],
    };

    const info = Cu.cloneInto(mockErrorInfo, netErrorCard);
    netErrorCard.errorInfo = info;
    netErrorCard.errorConfig = netErrorCard.getErrorConfig();
    netErrorCard.requestUpdate();
    await netErrorCard.getUpdateComplete();

    // The SSL_ERROR_RX_RECORD_TOO_LONG config has an array introContent, so
    // the card should render two child spans inside errorIntro.
    const introEl = netErrorCard.errorIntro;
    Assert.ok(introEl, "Intro element should exist");
    const spans = introEl.querySelectorAll("span");
    Assert.equal(spans.length, 2, "Should have two intro content spans");
    Assert.equal(
      spans[1].dataset.l10nId,
      "ssl-error-rx-record-too-long",
      "Second span should be the specific SSL error message"
    );
  });

  BrowserTestUtils.removeTab(tab);
});

// When errorCodeString is a specific NSS error that is NOT registered
// in the error registry, getEffectiveErrorId should fall back to gErrorCode
// (nssFailure2), which IS registered. The net-error-card should still render.
add_task(async function test_fallback_to_general_nss_error() {
  info(
    "Testing fallback from unregistered NSS error to general nssFailure2 config"
  );

  const serverSocket = Cc[
    "@mozilla.org/network/server-socket;1"
  ].createInstance(Ci.nsIServerSocket);
  serverSocket.init(-1, true, -1);
  const port = serverSocket.port;
  registerCleanupFunction(() => serverSocket.close());

  serverSocket.asyncListen({
    onSocketAccepted(socket, transport) {
      const output = transport.openOutputStream(
        Ci.nsITransport.OPEN_BLOCKING,
        0,
        0
      );
      const response =
        "HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
      output.write(response, response.length);
      output.close();
    },
    onStopListening() {},
  });

  const { browser, tab } = await openErrorTab(`https://localhost:${port}`);

  await SpecialPowers.spawn(browser, [], async () => {
    const doc = content.document;

    const netErrorCard = await ContentTaskUtils.waitForCondition(
      () => doc.querySelector("net-error-card")?.wrappedJSObject,
      "net-error-card should be present"
    );

    // Mock errorInfo with an unregistered specific error code.
    // gErrorCode on this page is "nssFailure2" (registered in the
    // error registry). The mocked errorCodeString is not registered,
    // so getEffectiveErrorId should fall back to gErrorCode.
    const mockErrorInfo = {
      errorCodeString: "SSL_ERROR_UNREGISTERED_FAKE_ERROR",
      errorIsOverridable: false,
      channelStatus: 0,
      overridableErrorCategory: 0,
      validNotBefore: 0,
      validNotAfter: 0,
      certValidityRangeNotAfter: 0,
      certValidityRangeNotBefore: 0,
      issuerCommonName: "",
      errorMessage: "An unregistered NSS error.",
      hasHSTS: false,
      hasHPKP: false,
      certChainStrings: [],
    };

    content.document.getFailedCertSecurityInfo = () => mockErrorInfo;

    const info = Cu.cloneInto(mockErrorInfo, netErrorCard);
    netErrorCard.errorInfo = info;
    netErrorCard.errorConfig = netErrorCard.getErrorConfig();
    netErrorCard.requestUpdate();
    await netErrorCard.getUpdateComplete();

    // The card should be rendered using the nssFailure2 fallback config.
    Assert.ok(
      netErrorCard.errorTitle,
      "Error title should exist after fallback"
    );
    Assert.equal(
      netErrorCard.errorTitle.dataset.l10nId,
      "nssFailure2-title",
      "Should use the nssFailure2 title from the fallback config"
    );
  });

  BrowserTestUtils.removeTab(tab);
});

// The deniedPortAccess error should show the correct intro text
// (fp-neterror-denied-port-access) rather than the old offline-intro string.
add_task(async function test_denied_port_access_intro_text() {
  info("Testing deniedPortAccess shows correct intro text with felt privacy");
  await SpecialPowers.pushPrefEnv({
    set: [
      ["dom.security.https_first", false],
      ["network.security.ports.banned.override", ""],
    ],
  });

  // Port 25 (SMTP) is on Firefox's blocked port list.
  // eslint-disable-next-line @microsoft/sdl/no-insecure-url
  const { browser, tab } = await openErrorTab("http://example.com:25");

  await SpecialPowers.spawn(browser, [], async () => {
    const doc = content.document;
    Assert.ok(
      doc.documentURI.startsWith("about:neterror"),
      "Should be on the error page"
    );
    Assert.ok(
      doc.documentURI.includes("deniedPortAccess"),
      "Error code should be deniedPortAccess"
    );

    const netErrorCard = await ContentTaskUtils.waitForCondition(
      () => doc.querySelector("net-error-card")?.wrappedJSObject,
      "net-error-card should be present for deniedPortAccess"
    );
    await netErrorCard.getUpdateComplete();

    const introEl = netErrorCard.errorIntro;
    Assert.ok(introEl, "Intro element should exist");
    Assert.equal(
      introEl.dataset.l10nId,
      "fp-neterror-denied-port-access",
      "Should show the denied port access intro, not the offline intro"
    );
  });

  BrowserTestUtils.removeTab(tab);
  await SpecialPowers.popPrefEnv();
});
