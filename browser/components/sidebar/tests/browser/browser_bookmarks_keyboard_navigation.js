/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const UPDATED_BOOKMARKS_PREF = "sidebar.updatedBookmarks.enabled";

add_setup(async () => {
  await SpecialPowers.pushPrefEnv({
    set: [[UPDATED_BOOKMARKS_PREF, true]],
  });
  await PlacesUtils.bookmarks.eraseEverything();
  registerCleanupFunction(async () => {
    await PlacesUtils.bookmarks.eraseEverything();
    SidebarTestUtils.closePanel(window);
  });
});

async function showBookmarksSidebar() {
  if (SidebarController.currentID !== "viewBookmarksSidebar") {
    await SidebarTestUtils.showPanel(window, "viewBookmarksSidebar");
  }
  const { contentDocument, contentWindow } = SidebarController.browser;
  await BrowserTestUtils.waitForCondition(
    () => contentDocument.querySelector("sidebar-bookmarks"),
    "Wait for sidebar-bookmarks element"
  );
  const component = contentDocument.querySelector("sidebar-bookmarks");
  await component.updateComplete;
  return { component, contentWindow };
}

async function openFolder(details) {
  if (!details.open) {
    const summary = details.querySelector("summary");
    summary.click();
    await BrowserTestUtils.waitForMutationCondition(
      details,
      { attributes: true },
      () => details.open
    );
  }
}

async function waitForNestedListRows(nestedList) {
  await BrowserTestUtils.waitForMutationCondition(
    nestedList.shadowRoot,
    { childList: true, subtree: true },
    () => !!nestedList.rowEls.length || !!nestedList.folderEls.length
  );
}

add_task(async function test_arrow_down_into_expanded_folder() {
  await PlacesUtils.bookmarks.insert({
    url: "https://example.com/",
    title: "Inside Bookmark",
    parentGuid: PlacesUtils.bookmarks.toolbarGuid,
  });

  const { component, contentWindow } = await showBookmarksSidebar();
  const tabList = component.bookmarkList;

  await BrowserTestUtils.waitForMutationCondition(
    tabList.shadowRoot,
    { childList: true, subtree: true },
    () => tabList.folderEls[0]
  );

  const toolbarDetails = tabList.folderEls[0];
  await openFolder(toolbarDetails);

  const nestedList = toolbarDetails.querySelector("sidebar-bookmark-list");
  await waitForNestedListRows(nestedList);

  const toolbarSummary = toolbarDetails.querySelector("summary");
  toolbarSummary.focus();

  info(
    "ArrowDown from expanded folder summary should focus first item inside."
  );
  const firstRow = nestedList.rowEls[0];
  await focusWithKeyboard(firstRow, "KEY_ArrowDown", contentWindow);
  ok(isActiveElement(firstRow), "First bookmark row inside folder is focused.");

  SidebarTestUtils.closePanel(window);
});

add_task(async function test_arrow_up_from_first_row_focuses_parent_summary() {
  await PlacesUtils.bookmarks.insert({
    url: "https://example.com/",
    title: "Bookmark A",
    parentGuid: PlacesUtils.bookmarks.toolbarGuid,
  });

  const { component, contentWindow } = await showBookmarksSidebar();
  const tabList = component.bookmarkList;

  await BrowserTestUtils.waitForMutationCondition(
    tabList.shadowRoot,
    { childList: true, subtree: true },
    () => tabList.folderEls[0]
  );

  const toolbarDetails = tabList.folderEls[0];
  await openFolder(toolbarDetails);

  const nestedList = toolbarDetails.querySelector("sidebar-bookmark-list");
  await waitForNestedListRows(nestedList);

  const firstRow = nestedList.rowEls[0];
  firstRow.focus();

  const toolbarSummary = toolbarDetails.querySelector("summary");
  info("ArrowUp from first row should focus the parent folder summary.");
  await focusWithKeyboard(toolbarSummary, "KEY_ArrowUp", contentWindow);
  ok(isActiveElement(toolbarSummary), "Parent folder summary is focused.");

  SidebarTestUtils.closePanel(window);
});

add_task(async function test_arrow_down_navigates_between_rows() {
  await PlacesUtils.bookmarks.insert({
    url: "https://example.com/1",
    title: "First",
    parentGuid: PlacesUtils.bookmarks.toolbarGuid,
  });
  await PlacesUtils.bookmarks.insert({
    url: "https://example.com/2",
    title: "Second",
    parentGuid: PlacesUtils.bookmarks.toolbarGuid,
  });

  const { component, contentWindow } = await showBookmarksSidebar();
  const tabList = component.bookmarkList;

  await BrowserTestUtils.waitForMutationCondition(
    tabList.shadowRoot,
    { childList: true, subtree: true },
    () => tabList.folderEls[0]
  );

  const toolbarDetails = tabList.folderEls[0];
  await openFolder(toolbarDetails);

  const nestedList = toolbarDetails.querySelector("sidebar-bookmark-list");
  await BrowserTestUtils.waitForMutationCondition(
    nestedList.shadowRoot,
    { childList: true, subtree: true },
    () => nestedList.rowEls.length >= 2
  );

  const rows = nestedList.rowEls;
  rows[0].focus();

  info("ArrowDown should move from first to second row.");
  await focusWithKeyboard(rows[1], "KEY_ArrowDown", contentWindow);
  ok(isActiveElement(rows[1]), "Second row is focused.");

  info("ArrowUp should move back to first row.");
  await focusWithKeyboard(rows[0], "KEY_ArrowUp", contentWindow);
  ok(isActiveElement(rows[0]), "First row is focused again.");

  SidebarTestUtils.closePanel(window);
});

add_task(async function test_arrow_down_from_last_row_to_next_folder() {
  const folder1 = await PlacesUtils.bookmarks.insert({
    type: PlacesUtils.bookmarks.TYPE_FOLDER,
    title: "Folder One",
    parentGuid: PlacesUtils.bookmarks.toolbarGuid,
  });
  await PlacesUtils.bookmarks.insert({
    url: "https://example.com/",
    title: "In Folder One",
    parentGuid: folder1.guid,
  });
  const folder2 = await PlacesUtils.bookmarks.insert({
    type: PlacesUtils.bookmarks.TYPE_FOLDER,
    title: "Folder Two",
    parentGuid: PlacesUtils.bookmarks.toolbarGuid,
  });
  await PlacesUtils.bookmarks.insert({
    url: "https://example.org/",
    title: "In Folder Two",
    parentGuid: folder2.guid,
  });

  const { component, contentWindow } = await showBookmarksSidebar();
  const tabList = component.bookmarkList;

  await BrowserTestUtils.waitForMutationCondition(
    tabList.shadowRoot,
    { childList: true, subtree: true },
    () => tabList.folderEls[0]
  );

  const toolbarDetails = tabList.folderEls[0];
  await openFolder(toolbarDetails);

  const nestedList = toolbarDetails.querySelector("sidebar-bookmark-list");
  await BrowserTestUtils.waitForMutationCondition(
    nestedList.shadowRoot,
    { childList: true, subtree: true },
    () => nestedList.folderEls.length >= 2
  );

  const folder1Details = [...nestedList.folderEls].find(
    d => d.querySelector("summary")?.textContent.trim() === "Folder One"
  );
  const folder2Details = [...nestedList.folderEls].find(
    d => d.querySelector("summary")?.textContent.trim() === "Folder Two"
  );

  ok(folder1Details, "Folder One details element found.");
  ok(folder2Details, "Folder Two details element found.");

  await openFolder(folder1Details);
  const folder1NestedList = folder1Details.querySelector(
    "sidebar-bookmark-list"
  );
  await waitForNestedListRows(folder1NestedList);

  const lastRow = folder1NestedList.rowEls[folder1NestedList.rowEls.length - 1];
  lastRow.focus();

  const folder2Summary = folder2Details.querySelector("summary");
  info("ArrowDown from last row should navigate to next folder summary.");
  await focusWithKeyboard(folder2Summary, "KEY_ArrowDown", contentWindow);
  ok(isActiveElement(folder2Summary), "Folder Two summary is focused.");

  SidebarTestUtils.closePanel(window);
});

add_task(async function test_arrow_left_collapses_folder() {
  await PlacesUtils.bookmarks.insert({
    url: "https://example.com/",
    title: "A Bookmark",
    parentGuid: PlacesUtils.bookmarks.toolbarGuid,
  });

  const { component, contentWindow } = await showBookmarksSidebar();
  const tabList = component.bookmarkList;

  await BrowserTestUtils.waitForMutationCondition(
    tabList.shadowRoot,
    { childList: true, subtree: true },
    () => tabList.folderEls[0]
  );

  const toolbarDetails = tabList.folderEls[0];
  await openFolder(toolbarDetails);

  const toolbarSummary = toolbarDetails.querySelector("summary");
  toolbarSummary.focus();

  info("ArrowLeft on an open folder summary should collapse it.");
  EventUtils.synthesizeKey("KEY_ArrowLeft", {}, contentWindow);
  await BrowserTestUtils.waitForMutationCondition(
    toolbarDetails,
    { attributes: true },
    () => !toolbarDetails.open
  );
  ok(!toolbarDetails.open, "Folder is collapsed.");
  ok(isActiveElement(toolbarSummary), "Summary retains focus after collapse.");

  SidebarTestUtils.closePanel(window);
});

add_task(async function test_arrow_left_from_row_focuses_parent_summary() {
  await PlacesUtils.bookmarks.insert({
    url: "https://example.com/",
    title: "A Bookmark",
    parentGuid: PlacesUtils.bookmarks.toolbarGuid,
  });

  const { component, contentWindow } = await showBookmarksSidebar();
  const tabList = component.bookmarkList;

  await BrowserTestUtils.waitForMutationCondition(
    tabList.shadowRoot,
    { childList: true, subtree: true },
    () => tabList.folderEls[0]
  );

  const toolbarDetails = tabList.folderEls[0];
  await openFolder(toolbarDetails);

  const nestedList = toolbarDetails.querySelector("sidebar-bookmark-list");
  await waitForNestedListRows(nestedList);

  const firstRow = nestedList.rowEls[0];
  firstRow.focus();

  const toolbarSummary = toolbarDetails.querySelector("summary");
  info("ArrowLeft from a row should focus the parent folder summary.");
  await focusWithKeyboard(toolbarSummary, "KEY_ArrowLeft", contentWindow);
  ok(isActiveElement(toolbarSummary), "Parent folder summary is focused.");

  SidebarTestUtils.closePanel(window);
});

add_task(async function test_arrow_right_expands_folder() {
  await PlacesUtils.bookmarks.insert({
    url: "https://example.com/",
    title: "A Bookmark",
    parentGuid: PlacesUtils.bookmarks.toolbarGuid,
  });

  const { component, contentWindow } = await showBookmarksSidebar();
  const tabList = component.bookmarkList;

  await BrowserTestUtils.waitForMutationCondition(
    tabList.shadowRoot,
    { childList: true, subtree: true },
    () => tabList.folderEls[0]
  );

  const toolbarDetails = tabList.folderEls[0];
  if (toolbarDetails.open) {
    toolbarDetails.querySelector("summary").click();
    await BrowserTestUtils.waitForMutationCondition(
      toolbarDetails,
      { attributes: true },
      () => !toolbarDetails.open
    );
  }

  const toolbarSummary = toolbarDetails.querySelector("summary");
  toolbarSummary.focus();

  info("ArrowRight on a closed folder summary should expand it.");
  EventUtils.synthesizeKey("KEY_ArrowRight", {}, contentWindow);
  await BrowserTestUtils.waitForMutationCondition(
    toolbarDetails,
    { attributes: true },
    () => toolbarDetails.open
  );
  ok(toolbarDetails.open, "Folder is expanded.");

  SidebarTestUtils.closePanel(window);
});

add_task(async function test_arrow_right_enters_already_expanded_folder() {
  await PlacesUtils.bookmarks.insert({
    url: "https://example.com/",
    title: "A Bookmark",
    parentGuid: PlacesUtils.bookmarks.toolbarGuid,
  });

  const { component, contentWindow } = await showBookmarksSidebar();
  const tabList = component.bookmarkList;

  await BrowserTestUtils.waitForMutationCondition(
    tabList.shadowRoot,
    { childList: true, subtree: true },
    () => tabList.folderEls[0]
  );

  const toolbarDetails = tabList.folderEls[0];
  await openFolder(toolbarDetails);

  const nestedList = toolbarDetails.querySelector("sidebar-bookmark-list");
  await waitForNestedListRows(nestedList);

  const toolbarSummary = toolbarDetails.querySelector("summary");
  toolbarSummary.focus();

  const firstRow = nestedList.rowEls[0];
  info(
    "ArrowRight on an already-open folder should focus the first item inside."
  );
  await focusWithKeyboard(firstRow, "KEY_ArrowRight", contentWindow);
  ok(isActiveElement(firstRow), "First item inside the folder is focused.");

  SidebarTestUtils.closePanel(window);
});

add_task(async function test_arrow_up_enters_previous_expanded_folder() {
  const folder1 = await PlacesUtils.bookmarks.insert({
    type: PlacesUtils.bookmarks.TYPE_FOLDER,
    title: "First Folder",
    parentGuid: PlacesUtils.bookmarks.toolbarGuid,
  });
  await PlacesUtils.bookmarks.insert({
    url: "https://example.com/last",
    title: "Last In First",
    parentGuid: folder1.guid,
  });
  const folder2 = await PlacesUtils.bookmarks.insert({
    type: PlacesUtils.bookmarks.TYPE_FOLDER,
    title: "Second Folder",
    parentGuid: PlacesUtils.bookmarks.toolbarGuid,
  });
  await PlacesUtils.bookmarks.insert({
    url: "https://example.org/second",
    title: "In Second Folder",
    parentGuid: folder2.guid,
  });

  const { component, contentWindow } = await showBookmarksSidebar();
  const tabList = component.bookmarkList;

  await BrowserTestUtils.waitForMutationCondition(
    tabList.shadowRoot,
    { childList: true, subtree: true },
    () => tabList.folderEls[0]
  );

  const toolbarDetails = tabList.folderEls[0];
  await openFolder(toolbarDetails);

  const nestedList = toolbarDetails.querySelector("sidebar-bookmark-list");
  await BrowserTestUtils.waitForMutationCondition(
    nestedList.shadowRoot,
    { childList: true, subtree: true },
    () => nestedList.folderEls.length >= 2
  );

  const folder1Details = [...nestedList.folderEls].find(
    d => d.querySelector("summary")?.textContent.trim() === "First Folder"
  );
  const folder2Details = [...nestedList.folderEls].find(
    d => d.querySelector("summary")?.textContent.trim() === "Second Folder"
  );

  await openFolder(folder1Details);
  const folder1NestedList = folder1Details.querySelector(
    "sidebar-bookmark-list"
  );
  await waitForNestedListRows(folder1NestedList);

  const folder2Summary = folder2Details.querySelector("summary");
  folder2Summary.focus();

  const lastRow = folder1NestedList.rowEls[folder1NestedList.rowEls.length - 1];
  info(
    "ArrowUp from folder header should focus last item of previous expanded folder."
  );
  await focusWithKeyboard(lastRow, "KEY_ArrowUp", contentWindow);
  ok(
    isActiveElement(lastRow),
    "Last row in expanded previous folder is focused."
  );

  SidebarTestUtils.closePanel(window);
});
