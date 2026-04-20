/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { QRCodeGenerator } = ChromeUtils.importESModule(
  "moz-src:///browser/components/qrcode/QRCodeGenerator.sys.mjs"
);
const { QRCodeWorker } = ChromeUtils.importESModule(
  "moz-src:///browser/components/qrcode/QRCodeWorker.sys.mjs"
);

const CELL_SIZE = 20;
const MARGIN = 4 * CELL_SIZE;
const DOT_RADIUS_FACTOR = 0.4;
const MIN_LOGO_MODULE_SPAN = 6;
const TEST_URL = "https://mozilla.org";
const LONG_TEST_URL =
  "https://www.cnet.com/home/kitchen-and-household/keep-these-7-devices-far-away-from-extension-cords-or-power-strips/?utm_source=firefox-newtab-en-us";
// Exceeds H-level error correction capacity (~1273 bytes at version 40),
// forcing a fallback to a lower EC level that cannot support logo overlay.
const TOO_LONG_FOR_H_LEVEL_URL = "https://example.com/?" + "a".repeat(1400);

async function renderToSamplingCanvas(url) {
  const dataURI = await QRCodeGenerator.generateQRCode(url);

  const img = document.createElementNS("http://www.w3.org/1999/xhtml", "img");
  await new Promise(resolve => {
    img.onload = resolve;
    img.src = dataURI;
  });

  const canvas = document.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "canvas"
  );
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);

  return {
    width: img.naturalWidth,
    height: img.naturalHeight,
    dataURI,
    getPixel(x, y) {
      const d = ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data;
      return { r: d[0], g: d[1], b: d[2] };
    },
  };
}

const isNearBlack = ({ r, g, b }) => r < 30 && g < 30 && b < 30;
const isNearWhite = ({ r, g, b }) => r > 200 && g > 200 && b > 200;

async function loadReferenceDataURI(filename) {
  const bytes = await IOUtils.read(getTestFilePath(filename));
  return `data:image/png;base64,${bytes.toBase64()}`;
}

async function getImagePixels(dataURI) {
  const img = document.createElementNS("http://www.w3.org/1999/xhtml", "img");
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = () => reject(new Error("Image failed to load from data URI"));
    img.src = dataURI;
  });
  const canvas = document.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "canvas"
  );
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  canvas.getContext("2d").drawImage(img, 0, 0);
  return canvas
    .getContext("2d")
    .getImageData(0, 0, canvas.width, canvas.height);
}

async function assertImagesMatch(actualDataURI, expectedDataURI, message) {
  const [actual, expected] = await Promise.all([
    getImagePixels(actualDataURI),
    getImagePixels(expectedDataURI),
  ]);
  Assert.equal(actual.width, expected.width, `${message}: width mismatch`);
  Assert.equal(actual.height, expected.height, `${message}: height mismatch`);
  let mismatchCount = 0;
  for (let i = 0; i < actual.data.length; i += 4) {
    if (
      actual.data[i] !== expected.data[i] ||
      actual.data[i + 1] !== expected.data[i + 1] ||
      actual.data[i + 2] !== expected.data[i + 2]
    ) {
      mismatchCount++;
    }
  }
  Assert.equal(mismatchCount, 0, message);
}

add_task(async function test_qrcode_png_dimensions_and_background() {
  const { width, height, getPixel } = await renderToSamplingCanvas(TEST_URL);

  Assert.equal(width, height, "QR code should be square");
  Assert.strictEqual(
    (width - 2 * MARGIN) % CELL_SIZE,
    0,
    "Canvas width should fit the module grid exactly"
  );

  Assert.ok(isNearWhite(getPixel(0, 0)), "Top-left corner should be white");
  Assert.ok(
    isNearWhite(getPixel(width - 1, 0)),
    "Top-right corner should be white"
  );
  Assert.ok(
    isNearWhite(getPixel(0, height - 1)),
    "Bottom-left corner should be white"
  );
  Assert.ok(
    isNearWhite(getPixel(width - 1, height - 1)),
    "Bottom-right corner should be white"
  );
});

add_task(async function test_qrcode_png_no_logo() {
  const worker = new QRCodeWorker();
  let dataURI;
  try {
    dataURI = await worker.post("generateFullQRCode", [TEST_URL, false]);
  } finally {
    await worker.terminate();
  }
  const refDataURI = await loadReferenceDataURI("reference-qr-no-logo.png");
  await assertImagesMatch(
    dataURI,
    refDataURI,
    "Logo-free QR code should match reference image"
  );
});

add_task(async function test_qrcode_png_logo_clear_zone() {
  // Use the raw matrix to identify which modules are actually dark within the
  // clear zone for this URL. This ensures the test is meaningful: we only assert on
  // positions that would have rendered as dots if the clear zone weren't applied.
  const worker = new QRCodeWorker();
  let matrix, dotCount, placement;
  try {
    ({ matrix, dotCount } = await worker.post("generateQRMatrix", [
      TEST_URL,
      "H",
    ]));
    placement = await worker.post("getLogoPlacement", [dotCount, MARGIN]);
  } finally {
    await worker.terminate();
  }

  Assert.ok(placement.showLogo, "Baseline QR code should still render a logo");
  Assert.greaterOrEqual(
    placement.logoSize,
    MIN_LOGO_MODULE_SPAN * CELL_SIZE,
    "Rendered logo should not shrink below the minimum viable size"
  );

  const suppressedModules = [];
  for (let row = 0; row < dotCount; row++) {
    for (let col = 0; col < dotCount; col++) {
      if (!matrix[row][col] || placement.reservedMatrix[row][col]) {
        continue;
      }
      const dotX = MARGIN + (col + 0.5) * CELL_SIZE;
      const dotY = MARGIN + (row + 0.5) * CELL_SIZE;
      const offsetX = dotX - placement.centerX;
      const offsetY = dotY - placement.centerY;
      if (
        placement.showLogo &&
        Math.hypot(offsetX, offsetY) <
          placement.clearRadius + CELL_SIZE * DOT_RADIUS_FACTOR
      ) {
        suppressedModules.push({ dotX, dotY });
      }
    }
  }

  Assert.greater(
    suppressedModules.length,
    0,
    "Raw QR matrix must have dark modules inside the clear zone so suppression assertions are meaningful"
  );

  const { getPixel } = await renderToSamplingCanvas(TEST_URL);
  for (const { dotX, dotY } of suppressedModules) {
    Assert.ok(
      !isNearBlack(getPixel(dotX, dotY)),
      `Suppressed dot at (${Math.round(dotX)}, ${Math.round(dotY)}) should not render as a dark dot`
    );
  }
});

add_task(async function test_qrcode_png_logo_is_rendered() {
  const worker = new QRCodeWorker();
  let placement;
  try {
    const { dotCount } = await worker.post("generateQRMatrix", [TEST_URL, "H"]);
    placement = await worker.post("getLogoPlacement", [dotCount, MARGIN]);
  } finally {
    await worker.terminate();
  }

  Assert.ok(placement.showLogo, "Test URL should render a logo");

  const { getPixel } = await renderToSamplingCanvas(TEST_URL);

  // Sample a grid of points inside the logo area. The clear zone leaves those
  // pixels white when the logo fails to load. Any logo — colorful or
  // monochrome — will paint at least some non-white pixels over that area.
  // 0.3 keeps samples well inside the circular artwork and away from the white
  // corners of the square bounding box (the Firefox logo is a circle in a
  // square; sampling near 0.5 could land in a transparent/white corner).
  const sampleRadius = placement.logoSize * 0.3;
  const steps = 5;
  let nonWhitePixels = 0;
  for (let dy = -steps; dy <= steps; dy++) {
    for (let dx = -steps; dx <= steps; dx++) {
      const x = placement.centerX + (dx / steps) * sampleRadius;
      const y = placement.centerY + (dy / steps) * sampleRadius;
      if (!isNearWhite(getPixel(x, y))) {
        nonWhitePixels++;
      }
    }
  }

  Assert.greater(
    nonWhitePixels,
    0,
    "Logo area should contain non-white pixels; all-white means the logo failed to render"
  );
});

add_task(async function test_qrcode_png_long_url_center_alignment_pattern() {
  const worker = new QRCodeWorker();
  let matrix, dotCount, placement;
  try {
    ({ matrix, dotCount } = await worker.post("generateQRMatrix", [
      LONG_TEST_URL,
      "H",
    ]));
    placement = await worker.post("getLogoPlacement", [dotCount, MARGIN]);
  } finally {
    await worker.terminate();
  }

  Assert.ok(placement.showLogo, "Long test URL should still render a logo");
  Assert.greaterOrEqual(
    placement.logoSize,
    MIN_LOGO_MODULE_SPAN * CELL_SIZE,
    "Long-URL logo should stay at or above the minimum viable size"
  );

  // Find the alignment pattern center nearest the QR code midpoint by looking for
  // a dark reserved cell (outside finder zones) surrounded by a full 5x5 reserved block.
  const isInFinderZone = (r, c) =>
    (r < 8 && c < 8) ||
    (r < 8 && c >= dotCount - 8) ||
    (r >= dotCount - 8 && c < 8);
  const mid = (dotCount - 1) / 2;
  let centerRow = -1,
    centerCol = -1,
    bestDist = Infinity;
  for (let row = 2; row < dotCount - 2; row++) {
    for (let col = 2; col < dotCount - 2; col++) {
      if (
        isInFinderZone(row, col) ||
        !matrix[row][col] ||
        !placement.reservedMatrix[row][col]
      ) {
        continue;
      }
      let isAlignmentCenter = true;
      for (let dr = -2; dr <= 2 && isAlignmentCenter; dr++) {
        for (let dc = -2; dc <= 2 && isAlignmentCenter; dc++) {
          if (!placement.reservedMatrix[row + dr]?.[col + dc]) {
            isAlignmentCenter = false;
          }
        }
      }
      if (!isAlignmentCenter) {
        continue;
      }
      const dist = (row - mid) ** 2 + (col - mid) ** 2;
      if (dist < bestDist) {
        bestDist = dist;
        centerRow = row;
        centerCol = col;
      }
    }
  }

  Assert.notEqual(
    centerRow,
    -1,
    "Long URL should produce a QR code with a center alignment pattern"
  );

  const { getPixel } = await renderToSamplingCanvas(LONG_TEST_URL);
  for (let row = centerRow - 2; row <= centerRow + 2; row++) {
    for (let col = centerCol - 2; col <= centerCol + 2; col++) {
      Assert.equal(
        isNearBlack(
          getPixel(
            MARGIN + (col + 0.5) * CELL_SIZE,
            MARGIN + (row + 0.5) * CELL_SIZE
          )
        ),
        matrix[row][col],
        `Center alignment pattern at (${row},${col}) should be preserved`
      );
    }
  }
});

// Validates that the rendered PNG faithfully represents reserved QR dots and
// keeps any data-dot suppression within H-level error correction capacity
// (30%). Tests two URL lengths: short (baseline) and long (stress).
add_task(async function test_qrcode_png_decodability() {
  const urls = [TEST_URL, LONG_TEST_URL];

  for (const url of urls) {
    const worker = new QRCodeWorker();
    let matrix, dotCount, placement;
    try {
      ({ matrix, dotCount } = await worker.post("generateQRMatrix", [
        url,
        "H",
      ]));
      placement = await worker.post("getLogoPlacement", [dotCount, MARGIN]);
    } finally {
      await worker.terminate();
    }

    const { getPixel } = await renderToSamplingCanvas(url);

    let totalDataDots = 0;
    let dataMismatches = 0;
    let reservedMismatches = 0;

    for (let row = 0; row < dotCount; row++) {
      for (let col = 0; col < dotCount; col++) {
        const dotX = MARGIN + (col + 0.5) * CELL_SIZE;
        const dotY = MARGIN + (row + 0.5) * CELL_SIZE;
        const renderedDark = isNearBlack(getPixel(dotX, dotY));

        if (placement.reservedMatrix[row][col]) {
          if (renderedDark !== matrix[row][col]) {
            reservedMismatches++;
          }
          continue;
        }

        totalDataDots++;
        if (renderedDark !== matrix[row][col]) {
          dataMismatches++;
        }
      }
    }

    Assert.equal(
      reservedMismatches,
      0,
      `url="${url}" should preserve all reserved QR dots`
    );

    const suppressedFraction = dataMismatches / totalDataDots;
    Assert.less(
      suppressedFraction,
      0.3,
      `url="${url}" changed ${(suppressedFraction * 100).toFixed(1)}% of data dots; must be under 30% for H-level error correction`
    );
  }
});

add_task(async function test_qrcode_png_long_url_omits_logo() {
  // URLs too long for H-level fall back to a lower EC level and the logo is
  // omitted. Verify the full rendered output matches the reference image, which
  // was generated with automatic EC fallback (no logo overlay).
  const dataURI = await QRCodeGenerator.generateQRCode(
    TOO_LONG_FOR_H_LEVEL_URL
  );
  const refDataURI = await loadReferenceDataURI(
    "reference-long-url-no-logo.png"
  );
  await assertImagesMatch(
    dataURI,
    refDataURI,
    "Long URL QR code should match reference image (no logo overlay)"
  );
});

add_task(async function test_qrcode_png_save_bytes() {
  const { dataURI, width } = await renderToSamplingCanvas(TEST_URL);

  const DATA_PREFIX = "data:image/png;base64,";
  Assert.ok(dataURI.startsWith(DATA_PREFIX), "Data URI should be a PNG");

  // Decode exactly as the dialog's save/copy path does.
  const bytes = Uint8Array.fromBase64(dataURI.slice(DATA_PREFIX.length));

  // Verify PNG magic header.
  const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < PNG_MAGIC.length; i++) {
    Assert.equal(bytes[i], PNG_MAGIC[i], `PNG magic byte ${i} should match`);
  }

  // First chunk must be IHDR.
  const IHDR = [0x49, 0x48, 0x44, 0x52];
  for (let i = 0; i < IHDR.length; i++) {
    Assert.equal(
      bytes[12 + i],
      IHDR[i],
      `IHDR chunk type byte ${i} should match`
    );
  }

  // Width and height are big-endian uint32s at bytes 16 and 20.
  const view = new DataView(bytes.buffer);
  const pngWidth = view.getUint32(16, false);
  const pngHeight = view.getUint32(20, false);

  Assert.equal(pngWidth, width, "PNG width in IHDR should match canvas width");
  Assert.equal(pngWidth, pngHeight, "Saved PNG should be square");
  Assert.strictEqual(
    (pngWidth - 2 * MARGIN) % CELL_SIZE,
    0,
    "Saved PNG width should fit the module grid"
  );
});
