import path from "node:path";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function validatePng(buffer, expected, filePath, label) {
  if (buffer.length < 26 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error(`${label} is not a PNG: ${filePath}`);
  }

  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  const colorType = buffer.readUInt8(25);
  if (width !== expected.width || height !== expected.height) {
    throw new Error(
      `${label} ${path.basename(filePath)} is ${width} × ${height}; expected ${expected.width} × ${expected.height}`,
    );
  }
  if (colorType === 4 || colorType === 6) {
    throw new Error(`${label} PNG has an alpha channel: ${filePath}`);
  }
}
