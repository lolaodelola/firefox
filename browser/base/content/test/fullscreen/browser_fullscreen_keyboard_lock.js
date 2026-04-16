"use strict";

add_setup(async () => {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["dom.fullscreen.keyboard_lock.enabled", true],
      ["dom.fullscreen.keyboard_lock.long_press_interval", 0],
    ],
  });
});

add_task(async function test_escape_doesnt_exit_keyboardlock() {
  await BrowserTestUtils.withNewTab("https://example.com", async browser => {
    await DOMFullscreenTestUtils.changeFullscreen(browser, true, {
      keyboardLock: "browser",
    });

    await SpecialPowers.spawn(browser, [], async () => {
      content.window.escapePressed = false;
      content.window.addEventListener(
        "keydown",
        e => {
          if (e.key == "Escape") {
            content.window.escapePressed = true;
          }
        },
        { once: true }
      );
    });

    EventUtils.synthesizeKey("KEY_Escape", {}, browser.ownerGlobal);
    let escapePressed = await SpecialPowers.spawn(browser, [], async () => {
      return content.window.escapePressed;
    });
    let isStillFullscreen = await SpecialPowers.spawn(browser, [], async () => {
      return content.document.fullscreenElement != null;
    });

    ok(escapePressed, "Escape key press made it to content process");
    ok(isStillFullscreen, "Escape key press shouldn't exit fullscreen");

    let fullScreenExited = BrowserTestUtils.waitForEvent(
      document,
      "fullscreenchange",
      false,
      () => !document.fullscreenElement
    );
    // Synthesize a long-press of the Escape key by repeating 2 keydown events.
    // This works as the long_press_interval is set to 0 on setup.
    EventUtils.synthesizeKey("KEY_Escape", { repeat: 2 }, browser.ownerGlobal);
    await fullScreenExited;
    isStillFullscreen = await SpecialPowers.spawn(browser, [], async () => {
      return content.document.fullscreenElement != null;
    });
    ok(
      !isStillFullscreen,
      "Long-press Escape key press should exit fullscreen"
    );
  });
});

add_task(async function test_inner_iframe_with_keyboardlock() {
  await BrowserTestUtils.withNewTab("https://example.com", async browser => {
    await DOMFullscreenTestUtils.changeFullscreen(browser, true, {
      keyboardLock: "none",
    });

    await SpecialPowers.spawn(browser, [], async () => {
      let frame = content.document.createElement("iframe");
      content.document.body.appendChild(frame);

      frame.focus();
      await SpecialPowers.spawn(frame, [], async () => {
        await content.document.body.requestFullscreen({
          keyboardLock: "browser",
        });
      });
    });

    EventUtils.synthesizeKey("KEY_Escape", {}, browser.ownerGlobal);
    let isStillFullscreen = await SpecialPowers.spawn(browser, [], async () => {
      return content.document.fullscreenElement != null;
    });
    ok(isStillFullscreen, "Escape key press shouldn't exit fullscreen");

    await SpecialPowers.spawn(browser, [], async () => {
      let frame = content.document.querySelector("iframe");
      await SpecialPowers.spawn(frame, [], async () => {
        await content.document.exitFullscreen();
      });
    });

    isStillFullscreen = await SpecialPowers.spawn(browser, [], async () => {
      return content.document.fullscreenElement != null;
    });
    ok(
      isStillFullscreen,
      "Exiting inner fullscreen shouldn't exit outer fullscreen"
    );

    let fullScreenExited = BrowserTestUtils.waitForEvent(
      document,
      "fullscreenchange",
      false,
      () => !document.fullscreenElement
    );
    EventUtils.synthesizeKey("KEY_Escape", {}, browser.ownerGlobal);
    await fullScreenExited;
    isStillFullscreen = await SpecialPowers.spawn(browser, [], async () => {
      return content.document.fullscreenElement != null;
    });
    ok(!isStillFullscreen, "Escape key press should exit fullscreen");
  });
});

add_task(async function test_inner_iframe_without_keyboardlock() {
  await BrowserTestUtils.withNewTab("https://example.com", async browser => {
    await DOMFullscreenTestUtils.changeFullscreen(browser, true, {
      keyboardLock: "browser",
    });

    await SpecialPowers.spawn(browser, [], async () => {
      let frame = content.document.createElement("iframe");
      content.document.body.appendChild(frame);

      frame.focus();
      await SpecialPowers.spawn(frame, [], async () => {
        await content.document.body.requestFullscreen({ keyboardLock: "none" });
      });
    });

    let fullScreenExited = BrowserTestUtils.waitForEvent(
      document,
      "fullscreenchange",
      false,
      () => !document.fullscreenElement
    );
    EventUtils.synthesizeKey("KEY_Escape", {}, browser.ownerGlobal);
    await fullScreenExited;
    let isStillFullscreen = await SpecialPowers.spawn(browser, [], async () => {
      return content.document.fullscreenElement != null;
    });
    ok(!isStillFullscreen, "Escape key press should exit fullscreen");

    await DOMFullscreenTestUtils.changeFullscreen(browser, true, {
      keyboardLock: "browser",
    });
    await SpecialPowers.spawn(browser, [], async () => {
      let frame = content.document.querySelector("iframe");
      await SpecialPowers.spawn(frame, [], async () => {
        await content.document.body.requestFullscreen({ keyboardLock: "none" });
        await content.document.exitFullscreen();
      });
    });

    EventUtils.synthesizeKey("KEY_Escape", {}, browser.ownerGlobal);
    isStillFullscreen = await SpecialPowers.spawn(browser, [], async () => {
      return content.document.fullscreenElement != null;
    });
    ok(isStillFullscreen, "Escape key press shouldn't exit fullscreen");
  });
});
