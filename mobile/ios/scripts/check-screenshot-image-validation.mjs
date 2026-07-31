import assert from "node:assert/strict";
import { validatePng } from "./screenshot-image-validation.mjs";

const expected = { width: 1320, height: 2868 };

assert.doesNotThrow(() => validatePng(pngHeader(1320, 2868, 2), expected, "valid.png", "Raw screenshot"));
assert.throws(
  () => validatePng(pngHeader(1319, 2868, 2), expected, "wrong-width.png", "Raw screenshot"),
  /wrong-width\.png is 1319 × 2868; expected 1320 × 2868/,
);
assert.throws(
  () => validatePng(pngHeader(1320, 2867, 2), expected, "wrong-height.png", "Raw screenshot"),
  /wrong-height\.png is 1320 × 2867; expected 1320 × 2868/,
);
assert.throws(
  () => validatePng(Buffer.alloc(26), expected, "invalid.png", "Raw screenshot"),
  /Raw screenshot is not a PNG/,
);
assert.throws(
  () => validatePng(pngHeader(1320, 2868, 6), expected, "alpha.png", "Raw screenshot"),
  /Raw screenshot PNG has an alpha channel/,
);

process.stdout.write("App Store screenshot image validation checks passed\n");

function pngHeader(width, height, colorType) {
  const buffer = Buffer.alloc(26);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buffer, 0);
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  buffer.writeUInt8(colorType, 25);
  return buffer;
}
