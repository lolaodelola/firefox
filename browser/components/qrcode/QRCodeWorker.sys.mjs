/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * QRCodeWorker - Worker-based QR code generation
 *
 * This module provides a worker-based implementation for QR code generation
 * to avoid blocking the main thread during QR code processing.
 */

import { BasePromiseWorker } from "resource://gre/modules/PromiseWorker.sys.mjs";

const lazy = {};

ChromeUtils.defineLazyGetter(lazy, "logConsole", function () {
  return console.createInstance({
    prefix: "QRCodeWorker",
    maxLogLevel: Services.prefs.getBoolPref("browser.qrcode.log", false)
      ? "Debug"
      : "Warn",
  });
});

/**
 * Worker wrapper for QR code generation
 */
export class QRCodeWorker extends BasePromiseWorker {
  constructor() {
    super("chrome://browser/content/qrcode/QRCodeWorker.worker.mjs", {
      type: "module",
    });

    // Set up logging
    this.log = (...args) => lazy.logConsole.debug(...args);
  }

  /**
   * Generate a complete QR code PNG with the Firefox logo composited off the
   * main thread.
   *
   * @param {string} url - The URL to encode in the QR code
   * @returns {Promise<string>} data:image/png;base64,... URI
   */
  async generateFullQRCode(url) {
    return this.post("generateFullQRCode", [url]);
  }

  /**
   * Terminate the worker and clean up resources
   */
  async terminate() {
    super.terminate();
  }
}
