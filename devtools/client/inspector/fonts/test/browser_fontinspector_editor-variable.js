/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */
"use strict";

const TEST_URI = URL_ROOT + "doc_browser_fontinspector-variable.html";

add_task(async function () {
  const { inspector, view } = await openFontInspectorForURL(TEST_URI);
  const viewDoc = view.document;

  await testWghtInteract(inspector, viewDoc);
  await testInstanceChange(inspector, viewDoc);
});

async function testWghtInteract(inspector, viewDoc) {
  await selectNode(".weight", inspector);

  const wghtInput = viewDoc.querySelector(`.font-value-input[name="wght"]`);
  is(wghtInput.value, "800", "wght value is 800 before focusing");

  wghtInput.focus();
  is(wghtInput.value, "800", "wght value is 800 after focusing");
}

async function testInstanceChange(inspector, viewDoc) {
  await selectNode(".weight", inspector);

  let wghtInput = viewDoc.querySelector(`.font-value-input[name="wght"]`);
  is(wghtInput.value, "800", "wght value is 800 initially");

  const instanceSelect = viewDoc.querySelector(
    "#font-editor .font-value-select"
  );

  instanceSelect.focus();
  const onEditorUpdated = inspector.once("fonteditor-updated");
  EventUtils.sendKey("LEFT", viewDoc.defaultView);
  await onEditorUpdated;

  wghtInput = viewDoc.querySelector(`.font-value-input[name="wght"]`);
  is(wghtInput.value, "900", "wght value is 900 after selecting new instance");

  wghtInput.focus();
  is(wghtInput.value, "900", "wght value is 900 after focusing");
}
