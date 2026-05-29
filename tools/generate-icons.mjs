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
import { readFile } from 'node:fs/promises';
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

console.log(`\nDone — regenerated ${SIZES.length} PNG icons from icon.svg.`);
