// Where: extensions/vault-autofill/scripts/generate-icons.mjs
// What: Generate deterministic PNG icons for the Kinic Vault Chrome extension.
// Why: Keep extension icons distinct from Kinic Wiki Clipper with zero external binary deps.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const iconsDir = resolve(root, "icons");

const SIZES = [16, 32, 48, 128];

await mkdir(iconsDir, { recursive: true });
for (const size of SIZES) {
  const png = renderVaultIconPng(size);
  await writeFile(resolve(iconsDir, `icon-${size}.png`), png);
}
console.log(`generated ${SIZES.map((s) => `icons/icon-${s}.png`).join(", ")}`);

function renderVaultIconPng(size) {
  const pixels = new Uint8Array(size * size * 4);
  const samples = 4;
  const inv = 1 / samples;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const u = (x + (sx + 0.5) * inv) / size;
          const v = (y + (sy + 0.5) * inv) / size;
          const [sr, sg, sb, sa] = sampleVaultBadge(u, v);
          r += sr * sa;
          g += sg * sa;
          b += sb * sa;
          a += sa;
        }
      }
      const total = samples * samples;
      const alpha = a / total;
      const offset = (y * size + x) * 4;
      if (alpha > 0) {
        pixels[offset] = Math.round(r / a);
        pixels[offset + 1] = Math.round(g / a);
        pixels[offset + 2] = Math.round(b / a);
        pixels[offset + 3] = Math.round(alpha * 255);
      }
    }
  }
  return encodePng(size, size, pixels);
}

function sampleVaultBadge(u, v) {
  // Rounded squircle container
  const dx = Math.abs(u - 0.5);
  const dy = Math.abs(v - 0.5);
  const radius = 0.22;
  const half = 0.46;
  const qx = Math.max(dx - (half - radius), 0);
  const qy = Math.max(dy - (half - radius), 0);
  const dist = Math.hypot(qx, qy) - radius;
  if (dist > 0) return [0, 0, 0, 0];

  // Indigo gradient background (#4338CA -> #6366F1)
  const t = Math.min(1, Math.max(0, (u * 0.4 + v * 0.6)));
  let r = 99 - t * 32;
  let g = 102 - t * 46;
  let b = 241 - t * 39;

  // Inner shield silhouette
  const sx = Math.abs(u - 0.5);
  const inShieldTop = v >= 0.19 && v <= 0.52 && sx <= 0.27;
  const shieldT = (v - 0.52) / 0.31;
  const inShieldBottom =
    v > 0.52 &&
    v <= 0.83 &&
    sx <= 0.27 * Math.pow(Math.max(0, 1 - shieldT * shieldT), 0.72);
  if (inShieldTop || inShieldBottom) {
    // Subtle translucent inner shield border
    const borderTop = v >= 0.23 && v <= 0.52 && sx <= 0.23;
    const borderBottom =
      v > 0.52 &&
      v <= 0.78 &&
      sx <= 0.23 * Math.pow(Math.max(0, 1 - ((v - 0.52) / 0.26) ** 2), 0.72);
    if (!(borderTop || borderBottom)) {
      return [255, 255, 255, 0.94];
    }
    r = Math.min(255, r + 14);
    g = Math.min(255, g + 14);
    b = Math.min(255, b + 12);
  }

  // White keyhole emblem inside shield
  const keyCircle = Math.hypot(u - 0.5, v - 0.45) <= 0.085;
  const keyStem = v >= 0.48 && v <= 0.66 && Math.abs(u - 0.5) <= 0.038;
  if (keyCircle || keyStem) {
    return [255, 255, 255, 1];
  }

  return [r, g, b, 1];
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    raw.set(
      rgba.subarray(y * width * 4, (y + 1) * width * 4),
      y * (width * 4 + 1) + 1
    );
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}
