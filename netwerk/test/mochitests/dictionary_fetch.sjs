/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// SJS handler for compression dictionary fetch tests.
// Routes on ?action= query parameter.

const DICTIONARY_CONTENT = "This is a test dictionary.\n";

// Pre-computed DCB data: \xffDCB + sha256(dict) + brotli_with_dict(content)
// Dictionary: "This is a test dictionary.\n"
// Content: "This is compressed test data using a test dictionary"
const DCB_HEX =
  "ff44434253969bcf5e960e0edbf0a4bdde6b0b3e9381e156de7f5b91ce839162" +
  "4270f416a198018062a44c1ddf12848caec2ca6022076e810514c9b7c3448ebc" +
  "16e0150eecc1ee34333e0d";

// Pre-computed DCZ data: \x5e\x2a\x4d\x18\x20\x00\x00\x00 + sha256(dict) + zstd_with_dict(content)
const DCZ_HEX =
  "5e2a4d182000000053969bcf5e960e0edbf0a4bdde6b0b3e9381e156de7f5b91" +
  "ce8391624270f41628b52ffd2434f5000098636f6d7072657373656461746120" +
  "7573696e67030059f97354462726109e99f2bc";

function hexToBytes(hex) {
  let bytes = [];
  for (let i = 0; i < hex.length; i += 2) {
    bytes.push(parseInt(hex.substr(i, 2), 16));
  }
  return bytes;
}

function handleRequest(request, response) {
  let start = request.queryString.indexOf("action=");
  if (start < 0) {
    response.setStatusLine(request.httpVersion, 400, "Bad Request");
    response.write("Missing action parameter");
    return;
  }
  let action = request.queryString.substring(start + 7).split("&")[0];

  if (action === "dict") {
    response.setHeader("Content-Type", "application/octet-stream", false);
    response.setHeader("Cache-Control", "max-age=3600", false);
    response.setHeader(
      "Use-As-Dictionary",
      'match="/tests/netwerk/test/mochitests/*"',
      false
    );
    response.write(DICTIONARY_CONTENT);
  } else if (action === "check_header") {
    response.setHeader("Content-Type", "application/json", false);
    response.setHeader("Cache-Control", "no-store", false);
    let availDict = "";
    if (request.hasHeader("Available-Dictionary")) {
      availDict = request.getHeader("Available-Dictionary");
    }
    response.write(JSON.stringify({ "available-dictionary": availDict }));
  } else if (action === "dcb") {
    response.setHeader("Content-Type", "text/plain", false);
    response.setHeader("Content-Encoding", "dcb", false);
    response.setHeader("Cache-Control", "no-store", false);
    let bytes = hexToBytes(DCB_HEX);
    let bos = Cc["@mozilla.org/binaryoutputstream;1"].createInstance(
      Ci.nsIBinaryOutputStream
    );
    bos.setOutputStream(response.bodyOutputStream);
    bos.writeByteArray(bytes);
  } else if (action === "dcz") {
    response.setHeader("Content-Type", "text/plain", false);
    response.setHeader("Content-Encoding", "dcz", false);
    response.setHeader("Cache-Control", "no-store", false);
    let bytes = hexToBytes(DCZ_HEX);
    let bos = Cc["@mozilla.org/binaryoutputstream;1"].createInstance(
      Ci.nsIBinaryOutputStream
    );
    bos.setOutputStream(response.bodyOutputStream);
    bos.writeByteArray(bytes);
  } else {
    response.setStatusLine(request.httpVersion, 400, "Bad Request");
    response.write("Unknown action: " + action);
  }
}
