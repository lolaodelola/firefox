/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Now load the QRCode library with the full resource URI
import { QR } from "moz-src:///toolkit/components/qrcode/encoder.mjs";
import { PromiseWorker } from "resource://gre/modules/workers/PromiseWorker.mjs";

// Per ISO/IEC 18004, finder patterns are always 7x7 modules.
const FINDER_SIZE = 7;
const CELL_SIZE = 20;
// Per ISO/IEC 18004, the minimum quiet zone around the code is 4 modules.
const MARGIN_CELLS = 4;
// Dot radius as a fraction of cell size. 0.4 means dots are 80% of cell width,
// leaving a visible gap between adjacent dots.
const DOT_RADIUS_FACTOR = 0.4;
// Corner radius factors for finder pattern rounded rectangles (design choices).
const FINDER_OUTER_CORNER_RADIUS_FACTOR = 1.2;
const FINDER_INNER_CORNER_RADIUS_FACTOR = 0.6;
// Minimum logo size in QR modules - below this the logo is too small to recognize.
const MIN_LOGO_MODULE_SPAN = 6;
// Maximum logo size in QR modules - keeps the logo within the H-level error correction budget.
const MAX_LOGO_MODULE_SPAN = 8;
// Format information is a 15-bit string reserved adjacent to each finder
// pattern (ISO/IEC 18004 §7.9). Column/row FINDER_SIZE + 1 (= 8) is where
// those bits are placed.
const FORMAT_INFO_BITS = 15;
// Version information is an 18-bit string stored in two 6×3 blocks for QR
// version 7 and above (ISO/IEC 18004 §7.10).
const VERSION_INFO_BITS = 18;
const VERSION_INFO_MIN_VERSION = 7;
// The version information blocks begin VERSION_INFO_BLOCK_OFFSET modules from
// the right and bottom edges of the symbol.
const VERSION_INFO_BLOCK_OFFSET = 11;
// Alignment pattern center coordinates by QR version (1-indexed), from ISO/IEC 18004 Table E.1.
const PATTERN_POSITION_TABLE = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
  [6, 30, 54],
  [6, 32, 58],
  [6, 34, 62],
  [6, 26, 46, 66],
  [6, 26, 48, 70],
  [6, 26, 50, 74],
  [6, 30, 54, 78],
  [6, 30, 56, 82],
  [6, 30, 58, 86],
  [6, 34, 62, 90],
  [6, 28, 50, 72, 94],
  [6, 26, 50, 74, 98],
  [6, 30, 54, 78, 102],
  [6, 28, 54, 80, 106],
  [6, 32, 58, 84, 110],
  [6, 30, 58, 86, 114],
  [6, 34, 62, 90, 118],
  [6, 26, 50, 74, 98, 122],
  [6, 30, 54, 78, 102, 126],
  [6, 26, 52, 78, 104, 130],
  [6, 30, 56, 82, 108, 134],
  [6, 34, 60, 86, 112, 138],
  [6, 30, 58, 86, 114, 142],
  [6, 34, 62, 90, 118, 146],
  [6, 30, 54, 78, 102, 126, 150],
  [6, 24, 50, 76, 102, 128, 154],
  [6, 28, 54, 80, 106, 132, 158],
  [6, 32, 58, 84, 110, 136, 162],
  [6, 26, 54, 82, 110, 138, 166],
  [6, 30, 58, 86, 114, 142, 170],
];

/**
 * QRCode Worker Implementation
 *
 * This worker handles QR code generation off the main thread.
 */
class QRCodeWorkerImpl {
  constructor() {
    this.#connectToPromiseWorker();
  }

  /**
   * @returns {number} Pixel margin around the QR code.
   */
  #getMargin() {
    return MARGIN_CELLS * CELL_SIZE;
  }

  /**
   * @param {number} dotCount - Number of modules per side.
   * @param {number} [margin] - Pixel margin; defaults to #getMargin().
   * @returns {number} Canvas side length in pixels.
   */
  #getCanvasSize(dotCount, margin = this.#getMargin()) {
    return dotCount * CELL_SIZE + margin * 2;
  }

  /**
   * Returns the top-left [row, col] of each of the three finder patterns.
   *
   * @param {number} dotCount
   * @returns {number[][]}
   */
  #getFinderPatternOrigins(dotCount) {
    return [
      [0, 0],
      [0, dotCount - FINDER_SIZE],
      [dotCount - FINDER_SIZE, 0],
    ];
  }

  /**
   * Calls callback(dotX, dotY) for every dark module that should be drawn as a
   * dot — skipping finder-pattern corners and any module suppressed by the logo.
   *
   * @param {boolean[][]} matrix
   * @param {object} placement - Logo placement descriptor from getLogoPlacement.
   * @param {number} margin - Pixel margin.
   * @param {Function} callback
   */
  #forEachVisibleDarkModule(matrix, placement, margin, callback) {
    const dotCount = matrix.length;
    const isInFinderPatternCorners = (row, col) =>
      (row < FINDER_SIZE && col < FINDER_SIZE) ||
      (row < FINDER_SIZE && col >= dotCount - FINDER_SIZE) ||
      (row >= dotCount - FINDER_SIZE && col < FINDER_SIZE);

    for (let row = 0; row < dotCount; row++) {
      for (let col = 0; col < dotCount; col++) {
        if (isInFinderPatternCorners(row, col) || !matrix[row][col]) {
          continue;
        }
        const dotX = margin + (col + 0.5) * CELL_SIZE;
        const dotY = margin + (row + 0.5) * CELL_SIZE;
        const offsetX = dotX - placement.centerX;
        const offsetY = dotY - placement.centerY;
        if (
          placement.showLogo &&
          !placement.reservedMatrix[row][col] &&
          Math.hypot(offsetX, offsetY) <
            placement.clearRadius + CELL_SIZE * DOT_RADIUS_FACTOR
        ) {
          continue;
        }
        callback(dotX, dotY);
      }
    }
  }

  /**
   * Draws a single rounded-rectangle finder pattern at canvas position (x, y).
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} x - Left edge in pixels.
   * @param {number} y - Top edge in pixels.
   */
  #drawFinderPattern(ctx, x, y) {
    // Finder pattern: 7×7 outer square, 5×5 white ring (inset 1 module each side),
    // 3×3 black center (inset 1 more module each side).
    const outerSize = FINDER_SIZE * CELL_SIZE;
    const ringSize = (FINDER_SIZE - 2) * CELL_SIZE;
    const centerSize = (FINDER_SIZE - 4) * CELL_SIZE;
    const outerR = CELL_SIZE * FINDER_OUTER_CORNER_RADIUS_FACTOR;
    const innerR = CELL_SIZE * FINDER_INNER_CORNER_RADIUS_FACTOR;

    ctx.fillStyle = "black";
    ctx.beginPath();
    ctx.roundRect(x, y, outerSize, outerSize, outerR);
    ctx.fill();

    ctx.fillStyle = "white";
    ctx.beginPath();
    ctx.roundRect(x + CELL_SIZE, y + CELL_SIZE, ringSize, ringSize, innerR);
    ctx.fill();

    ctx.fillStyle = "black";
    ctx.beginPath();
    ctx.roundRect(
      x + 2 * CELL_SIZE,
      y + 2 * CELL_SIZE,
      centerSize,
      centerSize,
      innerR
    );
    ctx.fill();
  }

  /**
   * Fills ctx with the white background, draws all data dots, and draws the
   * three finder patterns.
   *
   * @param {OffscreenCanvasRenderingContext2D} ctx
   * @param {boolean[][]} matrix
   * @param {object} placement - Logo placement descriptor from getLogoPlacement.
   * @param {number} [margin]
   */
  #drawQRBodyToCanvas(ctx, matrix, placement, margin = this.#getMargin()) {
    const dotCount = matrix.length;
    const canvasSize = this.#getCanvasSize(dotCount, margin);

    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, canvasSize, canvasSize);

    ctx.fillStyle = "black";
    this.#forEachVisibleDarkModule(matrix, placement, margin, (dotX, dotY) => {
      ctx.beginPath();
      ctx.arc(dotX, dotY, CELL_SIZE * DOT_RADIUS_FACTOR, 0, Math.PI * 2);
      ctx.fill();
    });

    for (const [startRow, startCol] of this.#getFinderPatternOrigins(
      dotCount
    )) {
      const x = margin + startCol * CELL_SIZE;
      const y = margin + startRow * CELL_SIZE;
      this.#drawFinderPattern(ctx, x, y);
    }
  }

  /**
   * Returns the preferred logo size capped at MAX_LOGO_MODULE_SPAN modules.
   *
   * @param {number} canvasSize - Canvas side length in pixels.
   * @returns {number} Logo size in pixels.
   */
  #getPreferredLogoSize(canvasSize) {
    // 18% of canvas width is a design choice: large enough to be recognisable
    // without exceeding the H-level error correction budget.
    const desiredLogoSize = Math.round(canvasSize * 0.18);
    return Math.min(desiredLogoSize, MAX_LOGO_MODULE_SPAN * CELL_SIZE);
  }

  /**
   * Builds a boolean matrix marking every QR structural cell that must not be
   * obscured: finder patterns, separators, timing patterns, alignment patterns,
   * and format/version information.
   *
   * @param {number} dotCount
   * @returns {boolean[][]}
   */
  #createReservedMatrix(dotCount) {
    // QR version: modules = 17 + 4*version (ISO/IEC 18004 §6.1).
    const version = (dotCount - 17) / 4;
    const reservedMatrix = Array.from({ length: dotCount }, () =>
      Array(dotCount).fill(false)
    );
    const mark = (row, col) => {
      if (row >= 0 && row < dotCount && col >= 0 && col < dotCount) {
        reservedMatrix[row][col] = true;
      }
    };

    // Finder patterns (top-left, top-right, bottom-left) plus their 1-module
    // separator borders: sweep -1..FINDER_SIZE in each axis around the pattern origin.
    for (const [startRow, startCol] of [
      [0, 0],
      [0, dotCount - FINDER_SIZE],
      [dotCount - FINDER_SIZE, 0],
    ]) {
      for (let rowOffset = -1; rowOffset <= FINDER_SIZE; rowOffset++) {
        for (let colOffset = -1; colOffset <= FINDER_SIZE; colOffset++) {
          mark(startRow + rowOffset, startCol + colOffset);
        }
      }
    }

    // Timing patterns on row and column FINDER_SIZE - 1, between the finder zones.
    for (
      let index = FINDER_SIZE + 1;
      index < dotCount - (FINDER_SIZE + 1);
      index++
    ) {
      mark(index, FINDER_SIZE - 1);
      mark(FINDER_SIZE - 1, index);
    }

    // Alignment patterns: 5×5 squares (±2 from center), skipping cells already
    // occupied by finder patterns (ISO/IEC 18004 Table E.1).
    const alignmentPositions = PATTERN_POSITION_TABLE[version - 1] ?? [];
    for (const row of alignmentPositions) {
      for (const col of alignmentPositions) {
        if (reservedMatrix[row][col]) {
          continue;
        }
        for (let rowOffset = -2; rowOffset <= 2; rowOffset++) {
          for (let colOffset = -2; colOffset <= 2; colOffset++) {
            mark(row + rowOffset, col + colOffset);
          }
        }
      }
    }

    // Format information: FORMAT_INFO_BITS-bit string placed in two copies around
    // the top-left finder pattern and one copy each near the other two
    // (ISO/IEC 18004 §7.9). Index FINDER_SIZE - 1 is skipped on the vertical
    // strip (timing pattern cell).
    const formatInfoColRow = FINDER_SIZE + 1;
    for (let index = 0; index < FORMAT_INFO_BITS; index++) {
      if (index < FINDER_SIZE - 1) {
        mark(index, formatInfoColRow);
      } else if (index < FINDER_SIZE + 1) {
        mark(index + 1, formatInfoColRow);
      } else {
        mark(dotCount - FORMAT_INFO_BITS + index, formatInfoColRow);
      }

      if (index < FINDER_SIZE + 1) {
        mark(formatInfoColRow, dotCount - index - 1);
      } else if (index < FINDER_SIZE + 2) {
        mark(formatInfoColRow, FORMAT_INFO_BITS - index);
      } else {
        mark(formatInfoColRow, FORMAT_INFO_BITS - 1 - index);
      }
    }

    mark(dotCount - (FINDER_SIZE + 1), formatInfoColRow);

    // Version information: VERSION_INFO_BITS-bit string in two 6×3 blocks for
    // version VERSION_INFO_MIN_VERSION+ (ISO/IEC 18004 §7.10). Blocks sit
    // VERSION_INFO_BLOCK_OFFSET modules from the right/bottom edges.
    if (version >= VERSION_INFO_MIN_VERSION) {
      for (let index = 0; index < VERSION_INFO_BITS; index++) {
        mark(
          Math.floor(index / 3),
          (index % 3) + dotCount - VERSION_INFO_BLOCK_OFFSET
        );
        mark(
          (index % 3) + dotCount - VERSION_INFO_BLOCK_OFFSET,
          Math.floor(index / 3)
        );
      }
    }

    return reservedMatrix;
  }

  /**
   * Returns all module positions sorted by distance from the QR code centre,
   * nearest first.
   *
   * @param {number} dotCount
   * @returns {{ row: number, col: number, distance: number }[]}
   */
  #sortedCenterCandidates(dotCount) {
    const midpoint = (dotCount - 1) / 2;
    const candidates = [];
    for (let row = 0; row < dotCount; row++) {
      for (let col = 0; col < dotCount; col++) {
        candidates.push({
          col,
          row,
          distance: (row - midpoint) ** 2 + (col - midpoint) ** 2,
        });
      }
    }
    candidates.sort((a, b) => a.distance - b.distance);
    return candidates;
  }

  /**
   * Returns the first candidate cell where the logo fits, or null if none found.
   *
   * @param {{ row: number, col: number }[]} candidates - Sorted centre candidates.
   * @param {number} dotCount
   * @param {number} logoSize - Logo size in pixels.
   * @param {boolean[][]} reservedMatrix
   * @returns {{ row: number, col: number } | null}
   */
  #findLogoCenterCell(candidates, dotCount, logoSize, reservedMatrix) {
    for (const candidate of candidates) {
      if (this.#logoFitsAtCell(candidate, dotCount, logoSize, reservedMatrix)) {
        return candidate;
      }
    }
    return null;
  }

  /**
   * Returns true if the logo can be placed centred on centerCell without
   * overlapping any reserved structural module.
   *
   * @param {{ row: number, col: number }} centerCell
   * @param {number} dotCount
   * @param {number} logoSize - Logo size in pixels.
   * @param {boolean[][]} reservedMatrix
   * @returns {boolean}
   */
  #logoFitsAtCell(centerCell, dotCount, logoSize, reservedMatrix) {
    const halfLogoSize = logoSize / 2;
    const halfLogoDots = halfLogoSize / CELL_SIZE;
    const suppressionRadius = halfLogoSize + CELL_SIZE * DOT_RADIUS_FACTOR;
    const maxOffset = Math.ceil(suppressionRadius / CELL_SIZE);

    if (
      centerCell.row + 0.5 - halfLogoDots < 0 ||
      centerCell.col + 0.5 - halfLogoDots < 0 ||
      centerCell.row + 0.5 + halfLogoDots > dotCount ||
      centerCell.col + 0.5 + halfLogoDots > dotCount
    ) {
      return false;
    }

    for (
      let row = Math.max(0, centerCell.row - maxOffset);
      row <= Math.min(dotCount - 1, centerCell.row + maxOffset);
      row++
    ) {
      for (
        let col = Math.max(0, centerCell.col - maxOffset);
        col <= Math.min(dotCount - 1, centerCell.col + maxOffset);
        col++
      ) {
        if (!reservedMatrix[row][col]) {
          continue;
        }

        const offsetX = (col - centerCell.col) * CELL_SIZE;
        const offsetY = (row - centerCell.row) * CELL_SIZE;
        if (
          Math.hypot(offsetX, offsetY) < suppressionRadius ||
          (Math.abs(offsetX) < halfLogoSize && Math.abs(offsetY) < halfLogoSize)
        ) {
          return false;
        }
      }
    }

    return true;
  }

  /**
   * @param {string} url
   * @param {string} [errorCorrectionLevel]
   * @returns {{ matrix: boolean[][], dotCount: number }}
   */
  generateQRMatrix(url, errorCorrectionLevel = "H") {
    if (!QR || !QR.encodeToMatrix) {
      throw new Error("QRCode library not available in worker");
    }
    const { matrix, dotCount } = QR.encodeToMatrix(url, errorCorrectionLevel);
    return { matrix, dotCount };
  }

  /**
   * Finds the best position and size for the logo in a QR code of dotCount
   * modules, avoiding all structural reserved areas.
   *
   * @param {number} dotCount
   * @param {number} [margin]
   * @returns {object} Logo placement descriptor.
   */
  getLogoPlacement(dotCount, margin = this.#getMargin()) {
    const canvasSize = this.#getCanvasSize(dotCount, margin);
    const reservedMatrix = this.#createReservedMatrix(dotCount);
    const preferredLogoSize = this.#getPreferredLogoSize(canvasSize);
    const minimumLogoSize = MIN_LOGO_MODULE_SPAN * CELL_SIZE;
    let logoSize = Math.max(preferredLogoSize, minimumLogoSize);
    let centerCell = null;

    const candidates = this.#sortedCenterCandidates(dotCount);
    while (logoSize >= minimumLogoSize && !centerCell) {
      centerCell = this.#findLogoCenterCell(
        candidates,
        dotCount,
        logoSize,
        reservedMatrix
      );
      if (!centerCell) {
        logoSize -= CELL_SIZE / 2;
      }
    }

    if (!centerCell) {
      return {
        centerX: Math.floor(canvasSize / 2),
        centerY: Math.floor(canvasSize / 2),
        clearRadius: 0,
        logoSize: minimumLogoSize,
        reservedMatrix,
        showLogo: false,
      };
    }

    return {
      centerX: margin + (centerCell.col + 0.5) * CELL_SIZE,
      centerY: margin + (centerCell.row + 0.5) * CELL_SIZE,
      clearRadius: logoSize / 2,
      logoSize,
      reservedMatrix,
      showLogo: true,
    };
  }

  /**
   * Generate a complete QR code PNG with the Firefox logo composited in the
   * worker. Returns a data URI ready for display or saving.
   *
   * Tries H-level error correction first. If the URL is too long to fit,
   * falls back through Q, M, L. The logo is only shown at H-level, which
   * has enough redundancy to survive the logo overlay without making the
   * code undecodable.
   *
   * @param {string} url
   * @param {boolean} [showLogo=true]
   * @returns {Promise<string>} data:image/png;base64,... URI
   */
  async generateFullQRCode(url, showLogo = true) {
    let matrix, dotCount, ecLevel;
    for (const level of ["H", "Q", "M", "L"]) {
      try {
        ({ matrix, dotCount } = this.generateQRMatrix(url, level));
        ecLevel = level;
        break;
      } catch (e) {
        if (level === "L") {
          throw e;
        }
      }
    }
    const margin = this.#getMargin();
    const placement = this.getLogoPlacement(dotCount, margin);
    if (ecLevel !== "H" || !showLogo) {
      placement.showLogo = false;
    }
    const size = this.#getCanvasSize(dotCount, margin);

    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext("2d");

    this.#drawQRBodyToCanvas(ctx, matrix, placement, margin);

    if (placement.showLogo) {
      try {
        const response = await fetch(
          "chrome://branding/content/about-logo@2x.png"
        );
        if (!response.ok) {
          throw new Error(`Logo fetch failed: ${response.status}`);
        }
        const blob = await response.blob();
        const logoSize = Math.round(placement.logoSize);
        const logoBitmap = await globalThis.createImageBitmap(blob, {
          resizeWidth: logoSize,
          resizeHeight: logoSize,
          resizeQuality: "high",
        });
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(
          logoBitmap,
          placement.centerX - placement.logoSize / 2,
          placement.centerY - placement.logoSize / 2,
          placement.logoSize,
          placement.logoSize
        );
        logoBitmap.close();
      } catch (e) {
        // Workers don't have access to the main-thread lazy.logConsole, so
        // log directly via console.
        console.warn("Failed to load Firefox logo for QR code:", e);
      }
    }

    const pngBlob = await canvas.convertToBlob({ type: "image/png" });
    const arrayBuffer = await pngBlob.arrayBuffer();
    const base64 = new Uint8Array(arrayBuffer).toBase64();
    return `data:image/png;base64,${base64}`;
  }

  /**
   * Glue code to connect the `QRCodeWorkerImpl` to the PromiseWorker interface.
   */
  #connectToPromiseWorker() {
    const worker = new PromiseWorker.AbstractWorker();

    worker.dispatch = (method, args = []) => {
      if (!this[method]) {
        throw new Error("Method does not exist: " + method);
      }
      return this[method](...args);
    };

    worker.close = () => self.close();

    worker.postMessage = (message, ...transfers) => {
      self.postMessage(message, ...transfers);
    };

    self.addEventListener("message", msg => worker.handleMessage(msg));
    self.addEventListener("unhandledrejection", function (error) {
      throw error.reason;
    });
  }
}

// Create the worker instance
new QRCodeWorkerImpl();
