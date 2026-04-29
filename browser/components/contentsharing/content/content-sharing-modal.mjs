/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { MozLitElement } from "chrome://global/content/lit-utils.mjs";
import { html, until } from "chrome://global/content/vendor/lit.all.mjs";

const { XPCOMUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/XPCOMUtils.sys.mjs"
);

const MAX_PREVIEW_LINKS = 3;
const lazy = {};

XPCOMUtils.defineLazyServiceGetters(lazy, {
  Favicons: ["@mozilla.org/browser/favicon-service;1", Ci.nsIFaviconService],
});

// eslint-disable-next-line import/no-unassigned-import
import "chrome://global/content/elements/moz-card.mjs";
// eslint-disable-next-line import/no-unassigned-import
import "chrome://global/content/elements/moz-button.mjs";

/**
 * Element used for content sharing modal content
 */
export class ContentSharingModal extends MozLitElement {
  static properties = { share: { type: Object } };

  static queries = {
    title: ".share-title",
    linkCount: ".share-count",
    links: { all: ".link" },
    moreLinks: ".more-links",
    previewCard: ".preview > moz-card",
  };

  async getUpdateComplete() {
    await super.getUpdateComplete();
    await this.previewCard.updateComplete;
  }

  connectedCallback() {
    super.connectedCallback();

    const shareObject = window.arguments?.[0];
    this.share = shareObject.share;
  }

  close() {
    window.close();
  }

  async linkTemplate(link) {
    if (link.type === "bookmarks") {
      return html`<div class="link">
        <img class="link-icon" src="chrome://global/skin/icons/folder.svg" />
        <span class="link-title">${link.title}</span>
      </div>`;
    }

    const icon = await lazy.Favicons.getFaviconForPage(
      Services.io.newURI(link.url)
    );
    return html`<div class="link">
      <img
        class="link-icon"
        src=${icon?.uri.spec ?? "chrome://global/skin/icons/defaultFavicon.svg"}
      />
      <span class="link-title">${link.title}</span>
    </div>`;
  }

  linksTemplate() {
    if (!this.share?.links) {
      return null;
    }

    if (this.share.links.length > MAX_PREVIEW_LINKS) {
      return html`${this.share.links
          .slice(0, 3)
          .map(link => until(this.linkTemplate(link), null))}
        <div
          class="more-links"
          data-l10n-id="content-sharing-modal-more-tabs"
          data-l10n-args=${JSON.stringify({
            count: this.share.links.length - MAX_PREVIEW_LINKS,
          })}
        ></div>`;
    }

    return this.share.links.map(link => until(this.linkTemplate(link), null));
  }

  render() {
    if (!this.share) {
      return null;
    }

    return html`<link
        rel="stylesheet"
        href="chrome://browser/content/contentsharing/content-sharing-modal.css"
      />
      <link
        rel="stylesheet"
        href="chrome://global/skin/in-content/common.css"
      />
      <div id="backgroud-image"></div>
      <div id="plain-backgroud"></div>
      <div class="container">
        <div class="preview">
          <moz-card
            ><label class="share-header"
              ><span class="share-title">${this.share.title}</span>
              <span class="share-count"
                ><img
                  class="share-icon"
                  src="chrome://browser/content/contentsharing/content-sharing-icon.svg"
                />
                ${this.share.links.length}</span
              ></label
            >
            <div class="link-preview-list">${this.linksTemplate()}</div>
          </moz-card>
        </div>
        <div class="description">
          <moz-button
            @click=${this.close}
            type="ghost"
            id="close-button"
            iconsrc="chrome://global/skin/icons/close.svg"
          ></moz-button>
        </div>
      </div>`;
  }
}
customElements.define("content-sharing-modal", ContentSharingModal);
