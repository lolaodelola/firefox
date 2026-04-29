ChromeUtils.defineESModuleGetters(this, {
  ContentSharingUtils:
    "resource:///modules/contentsharing/ContentSharingUtils.sys.mjs",
});

ChromeUtils.defineLazyGetter(this, "ContentSharingMockServer", () => {
  const { ContentSharingMockServer: server } = ChromeUtils.importESModule(
    "resource://testing-common/ContentSharingMockServer.sys.mjs"
  );
  return server;
});

/**
 * Starts the mock content sharing server, runs task, then stops it.
 * The server is stopped in a finally block so cleanup always runs.
 *
 * @param {Function} task - Async function receiving the mock server instance.
 */
async function withContentSharingMockServer(task) {
  await ContentSharingMockServer.start();
  try {
    await task(ContentSharingMockServer);
  } finally {
    await ContentSharingMockServer.stop();
  }
}

async function assertContentSharingModal(window, expected) {
  Assert.ok(window.gDialogBox.isOpen, "Content sharing modal should be open");
  Assert.deepEqual(
    window.gDialogBox.dialog.frameContentWindow.arguments[0],
    expected,
    "The window has the expected arguments"
  );

  const modalEl = await TestUtils.waitForCondition(() =>
    window.gDialogBox.dialog.frameContentWindow.document.querySelector(
      "content-sharing-modal"
    )
  );
  await modalEl.updateComplete;

  Assert.equal(
    modalEl.title.innerText,
    expected.share.title,
    "Modal has the correct share title"
  );

  Assert.equal(
    modalEl.linkCount.innerText,
    `${expected.share.links.length}`,
    "Modal has the correct link count"
  );

  Assert.equal(
    modalEl.links.length,
    Math.min(expected.share.links.length, 3),
    "Modal has the expected number of links. Max of 3 links"
  );
  if (expected.share.links.length > 3) {
    Assert.ok(
      modalEl.moreLinks.innerText.startsWith(
        `+${expected.share.links.length - 3}`
      ),
      `Modal has +${expected.share.links.length - 3} more links text`
    );
  }

  window.gDialogBox.dialog.close();
}
