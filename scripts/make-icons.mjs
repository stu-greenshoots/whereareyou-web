/**
 * Generate the app icons.
 *
 * Written out rather than committed as opaque binaries, and drawn with nothing
 * but zlib so it runs with no dependencies and no network. This app has to be
 * installable from a cold start on a plane; fetching an icon from a CDN at any
 * point in its life, including build time, would undercut that.
 *
 *   node scripts/make-icons.mjs
 *
 * The motif is the map pin: an accuracy ring around a single point. It is the
 * one image in the product that means "here", so it is the one worth putting on
 * a home screen.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');

/** Ink, paper and accent, lifted straight from the stylesheet. */
const INK = [0x14, 0x16, 0x1a];
const PAPER = [0xf2, 0xf3, 0xf5];
const ACCENT = [0x3b, 0x82, 0xf6];

function crc32(buffer) {
  let table = crc32.table;
  if (table === undefined) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (const byte of buffer) crc = (crc >>> 8) ^ table[(crc ^ byte) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** Encode straight RGBA pixels as a PNG. */
function encodePng(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  // Each scanline is prefixed with filter type 0 (none).
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function mix(under, over, alpha) {
  return [
    Math.round(under[0] * (1 - alpha) + over[0] * alpha),
    Math.round(under[1] * (1 - alpha) + over[1] * alpha),
    Math.round(under[2] * (1 - alpha) + over[2] * alpha),
  ];
}

/**
 * Draw the pin.
 *
 * `scale` shrinks the motif for the maskable variant, whose outer fifth can be
 * cropped to any shape the platform fancies.
 */
function draw(size, scale) {
  const rgba = Buffer.alloc(size * size * 4);
  const centre = (size - 1) / 2;
  const unit = (size / 2) * scale;

  // Radii as fractions of the motif's half-width.
  const ringOuter = unit * 0.92;
  const ringInner = unit * 0.74;
  const haloOuter = unit * 0.62;
  const dotOuter = unit * 0.34;
  const collar = unit * 0.46;

  // One-pixel feather, so curves do not come out jagged at 192px.
  const edge = (distance, radius) => Math.max(0, Math.min(1, radius + 0.5 - distance));

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const distance = Math.hypot(x - centre, y - centre);
      let colour = INK;

      // Accuracy ring: a thin paper annulus at the outside.
      const ring = Math.min(edge(distance, ringOuter), 1) * (1 - edge(distance, ringInner));
      if (ring > 0) colour = mix(colour, PAPER, ring * 0.9);

      // Soft accent halo, the accuracy fill on the map.
      const halo = edge(distance, haloOuter);
      if (halo > 0) colour = mix(colour, ACCENT, halo * 0.28);

      // Paper collar and the point itself.
      const collarAlpha = edge(distance, collar);
      if (collarAlpha > 0) colour = mix(colour, PAPER, collarAlpha);
      const dot = edge(distance, dotOuter);
      if (dot > 0) colour = mix(colour, ACCENT, dot);

      const offset = (y * size + x) * 4;
      rgba[offset] = colour[0];
      rgba[offset + 1] = colour[1];
      rgba[offset + 2] = colour[2];
      rgba[offset + 3] = 255;
    }
  }
  return encodePng(size, rgba);
}

mkdirSync(OUT, { recursive: true });

const icons = [
  ['icon-192.png', 192, 0.82],
  ['icon-512.png', 512, 0.82],
  // Maskable: motif inside the 80% safe zone, background bleeding to the edge.
  ['icon-maskable-512.png', 512, 0.6],
  ['apple-touch-icon.png', 180, 0.78],
  ['favicon-32.png', 32, 0.92],
];

for (const [name, size, scale] of icons) {
  const png = draw(size, scale);
  writeFileSync(join(OUT, name), png);
  console.log(`${name.padEnd(24)} ${size}x${size}  ${(png.length / 1024).toFixed(1)} kB`);
}
