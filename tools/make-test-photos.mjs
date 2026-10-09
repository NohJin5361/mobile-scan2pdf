// Writes synthetic "phone photos of a document" as PPM files (convert to JPEG with
// tools/make-test-photos.py). Usage: node tools/make-test-photos.mjs <outdir> [count]
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeScene } from '../tests/js/synth.js';

const out = process.argv[2] || 'test-photos';
const count = Number(process.argv[3] || 3);
mkdirSync(out, { recursive: true });
const kinds = ['wood', 'dark', 'clutter', 'light', 'table-edge'];
const meta = [];
for (let i = 0; i < count; i++) {
  const portrait = i % 2 === 1;
  const { image, corners } = makeScene({ seed: 100 + i, bg: kinds[i % kinds.length], width: portrait ? 1200 : 1600, height: portrait ? 1600 : 1200, physical: true });
  const { width, height, data } = image;
  const rgb = Buffer.alloc(width * height * 3);
  for (let p = 0, q = 0; p < data.length; p += 4, q += 3) {
    rgb[q] = data[p]; rgb[q + 1] = data[p + 1]; rgb[q + 2] = data[p + 2];
  }
  const name = `photo-${i + 1}`;
  writeFileSync(join(out, `${name}.ppm`), Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`), rgb]));
  meta.push({ name, width, height, corners });
}
writeFileSync(join(out, 'meta.json'), JSON.stringify(meta, null, 1));
