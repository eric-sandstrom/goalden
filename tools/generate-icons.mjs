#!/usr/bin/env node
/**
 * Rasterises public/icons/icon.svg into every PWA icon size declared in
 * public/manifest.webmanifest, writing PNGs in place.
 *
 * Run: `npm run icons:generate`
 *
 * Rerun any time you edit icon.svg. The script is idempotent — it overwrites
 * the existing PNGs. Sizes are kept in sync with the manifest manually below;
 * if you add a new size to the manifest, add it here too.
 */
import sharp from 'sharp';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SRC_SVG = join(ROOT, 'public', 'icons', 'icon.svg');
const OUT_DIR = join(ROOT, 'public', 'icons');

// Keep in lockstep with public/manifest.webmanifest.
const SIZES = [72, 96, 128, 144, 152, 192, 384, 512];

const svg = await readFile(SRC_SVG);

for (const size of SIZES) {
  const out = join(OUT_DIR, `icon-${size}x${size}.png`);
  await sharp(svg, { density: 512 })
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(out);
  console.log(`  ${size.toString().padStart(3)}×${size}  →  ${out.replace(ROOT, '.')}`);
}

// Android notification status-bar badge — monochrome silhouette from badge.svg
// (white shape on transparent; Android fills the alpha with white).
const badgeSvg = await readFile(join(OUT_DIR, 'badge.svg'));
const badgeOut = join(OUT_DIR, 'badge-96x96.png');
await sharp(badgeSvg, { density: 512 })
  .resize(96, 96, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png()
  .toFile(badgeOut);
console.log(`   96×96  →  ${badgeOut.replace(ROOT, '.')}  (notification badge)`);

// Browser tab favicon — public/favicon.ico, generated from the same logo so the
// tab icon stays in sync with the PWA icons (replaces the stock Angular .ico).
// sharp has no ICO encoder, so we build the container by hand: an ICO can embed
// PNG frames directly (Vista+), so each entry is just a resized PNG wrapped in
// the 6-byte ICONDIR header + one 16-byte ICONDIRENTRY per size.
const FAVICON_SIZES = [16, 32, 48];
const frames = await Promise.all(
  FAVICON_SIZES.map((size) =>
    sharp(svg, { density: 512 })
      .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer(),
  ),
);

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: 1 = icon
header.writeUInt16LE(frames.length, 4); // image count

let offset = 6 + frames.length * 16; // data starts after header + all entries
const entries = frames.map((png, i) => {
  const size = FAVICON_SIZES[i];
  const entry = Buffer.alloc(16);
  entry.writeUInt8(size >= 256 ? 0 : size, 0); // width (0 = 256)
  entry.writeUInt8(size >= 256 ? 0 : size, 1); // height
  entry.writeUInt8(0, 2); // palette count
  entry.writeUInt8(0, 3); // reserved
  entry.writeUInt16LE(1, 4); // color planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(png.length, 8); // image data size
  entry.writeUInt32LE(offset, 12); // image data offset
  offset += png.length;
  return entry;
});

const icoOut = join(ROOT, 'public', 'favicon.ico');
await writeFile(icoOut, Buffer.concat([header, ...entries, ...frames]));
console.log(`   ${FAVICON_SIZES.join('/')}  →  ${icoOut.replace(ROOT, '.')}  (favicon)`);

console.log(`\nDone — regenerated ${SIZES.length} PNG icons from icon.svg.`);
