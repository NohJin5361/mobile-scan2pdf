import test from 'node:test';
import assert from 'node:assert/strict';

import { detectDocument } from '../../web/js/core/detect.js';
import {
  solveHomography, applyHomography, estimateAspectRatio, documentSize, rotateQuad,
  warpPerspective, extractDocument, snapToPaper,
} from '../../web/js/core/warp.js';
import { applyFilter, FILTERS } from '../../web/js/core/enhance.js';
import { orderCorners, isConvexQuad, maxAreaQuad, convexHull } from '../../web/js/core/geometry.js';
import { resizeImage, rotateImage90, boxBlur, maxFilter } from '../../web/js/core/image.js';
import { makeScene, projectRectangle, maxCornerError } from './synth.js';

test('homography maps the four correspondences exactly', () => {
  const src = [[0, 0], [100, 0], [100, 50], [0, 50]];
  const dst = [[12, 7], [130, 20], [118, 96], [5, 70]];
  const H = solveHomography(src, dst);
  for (let i = 0; i < 4; i++) {
    const [u, v] = applyHomography(H, ...src[i]);
    assert.ok(Math.abs(u - dst[i][0]) < 1e-6 && Math.abs(v - dst[i][1]) < 1e-6);
  }
});

test('aspect ratio of a perspective-projected A4 sheet is recovered', () => {
  const truth = 0.21 / 0.297;
  for (const [rx, ry, rz, f] of [[0, 0.5, 0.2, 3000], [0.6, 0.3, -0.4, 3400], [0.2, -0.6, 1.2, 2800]]) {
    const q = projectRectangle({ pw: 0.21, ph: 0.297, f, width: 4000, height: 3000, rx, ry, rz, dist: 0.45 });
    const r = estimateAspectRatio(q, 4000, 3000);
    assert.ok(Math.abs(r / truth - 1) < 0.01, `ratio ${r} vs ${truth}`);
    const size = documentSize(q, 4000, 3000, { snap: true });
    assert.ok(Math.abs(size.width / size.height - truth) < 0.002);
  }
});

test('paper snapping only nudges near-standard ratios', () => {
  assert.equal(snapToPaper(1.40), Math.SQRT2);
  assert.equal(snapToPaper(1 / 1.42), 1 / Math.SQRT2);
  assert.equal(snapToPaper(1.0), 1.0);
  assert.equal(snapToPaper(1.5), 1.5);
});

test('documentSize respects maxDim', () => {
  const q = [[0, 0], [3000, 0], [3000, 4000], [0, 4000]];
  const s = documentSize(q, 3000, 4000, { maxDim: 1000, snap: false });
  assert.equal(Math.max(s.width, s.height), 1000);
});

test('rotateQuad / extractDocument rotate the output clockwise', () => {
  // 4x2 image: left half red, right half blue.
  const img = { width: 4, height: 2, data: new Uint8ClampedArray(4 * 2 * 4) };
  for (let y = 0; y < 2; y++) for (let x = 0; x < 4; x++) {
    const i = (y * 4 + x) * 4;
    img.data.set(x < 2 ? [255, 0, 0, 255] : [0, 0, 255, 255], i);
  }
  const q = [[0, 0], [4, 0], [4, 2], [0, 2]];
  const out = extractDocument(img, q, { rotation: 90, snap: false, correctRatio: false });
  assert.equal(out.width, 2);
  assert.equal(out.height, 4);
  // After a clockwise turn the former left (red) half is on top.
  assert.equal(out.data[0], 255);
  assert.equal(out.data[(3 * 2) * 4 + 2], 255);
  assert.deepEqual(rotateQuad(q, 360), q);
});

test('warpPerspective reproduces an axis-aligned crop', () => {
  const { image } = makeScene({ width: 200, height: 150, seed: 3, bg: 'dark', noise: 0, shadow: false, lightGrad: 0 });
  const out = warpPerspective(image, [[50, 40], [150, 40], [150, 110], [50, 110]], 100, 70);
  for (const [x, y] of [[0, 0], [37, 21], [99, 69]]) {
    const a = (y * 100 + x) * 4, b = ((y + 40) * 200 + x + 50) * 4;
    assert.ok(Math.abs(out.data[a] - image.data[b]) <= 1);
  }
});

test('geometry helpers', () => {
  const q = orderCorners([[10, 90], [90, 85], [5, 5], [95, 10]]);
  assert.deepEqual(q, [[5, 5], [95, 10], [90, 85], [10, 90]]);
  assert.ok(isConvexQuad(q));
  assert.ok(!isConvexQuad([q[0], q[2], q[1], q[3]]));
  const hull = convexHull([[0, 0], [10, 0], [10, 10], [0, 10], [5, 5], [5, 0]]);
  assert.equal(hull.length, 4);
  const circle = Array.from({ length: 36 }, (_, i) => [Math.cos(i * Math.PI / 18) * 10, Math.sin(i * Math.PI / 18) * 10]);
  const best = maxAreaQuad(circle);
  assert.ok(Math.abs(Math.abs((best[0][0] - best[2][0]) * (best[1][1] - best[3][1]) - (best[0][1] - best[2][1]) * (best[1][0] - best[3][0])) / 2 - 200) < 1);
});

test('image helpers', () => {
  const img = { width: 4, height: 4, data: new Uint8ClampedArray(64).fill(100) };
  const small = resizeImage(img, 2, 2);
  assert.equal(small.data[0], 100);
  const r = rotateImage90({ width: 2, height: 1, data: new Uint8ClampedArray([1, 1, 1, 1, 2, 2, 2, 2]) }, 1);
  assert.equal(r.width, 1);
  assert.deepEqual([...r.data], [1, 1, 1, 1, 2, 2, 2, 2]);
  const p = new Float32Array([0, 0, 9, 0, 0]);
  assert.deepEqual([...boxBlur(p, 5, 1, 1)], [0, 3, 3, 3, 0]);
  assert.deepEqual([...maxFilter(p, 5, 1, 1)], [0, 9, 9, 9, 0]);
});

const SCENES = [
  { bg: 'wood' }, { bg: 'dark' }, { bg: 'light' }, { bg: 'clutter' }, { bg: 'table-edge' },
  { bg: 'clutter', occlude: true }, { bg: 'wood', noise: 12 },
  { bg: 'light', paper: [210, 205, 196], noise: 3, shadow: false }, // white paper on a white desk
];

test('detects the page in synthetic photos to within 1% of the diagonal', () => {
  let i = 0;
  for (const opts of SCENES) {
    for (const seed of [11, 42]) {
      const { image, corners } = makeScene({ seed: seed + i, width: 900, height: 675, ...opts });
      const res = detectDocument(image);
      assert.ok(res, `no detection for ${JSON.stringify(opts)}`);
      const err = maxCornerError(res.corners, corners) / Math.hypot(900, 675);
      assert.ok(err < 0.01, `${JSON.stringify(opts)} seed ${seed + i}: error ${(err * 100).toFixed(2)}%`);
    }
    i++;
  }
});

test('live mode (small frame, no refinement) is still close', () => {
  const { image, corners } = makeScene({ seed: 5, bg: 'wood' });
  const small = resizeImage(image, 360, 270);
  const res = detectDocument(small, { refine: false });
  const scaled = res.corners.map(([x, y]) => [x * image.width / 360, y * image.height / 270]);
  assert.ok(maxCornerError(scaled, corners) / Math.hypot(1200, 900) < 0.02);
});

test('returns null when there is no document', () => {
  const far = [[-5000, -5000], [-4000, -5000], [-4000, -4000], [-5000, -4000]];
  for (const bg of ['dark', 'wood', 'light']) {
    const { image } = makeScene({ seed: 9, bg, quad: far, width: 600, height: 450 });
    assert.equal(detectDocument(image), null, bg);
  }
});

function stats(img, x0, y0, x1, y1) {
  let s = 0, s2 = 0, n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = (y * img.width + x) * 4;
    const v = 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
    s += v; s2 += v * v; n++;
  }
  const m = s / n;
  return { mean: m, std: Math.sqrt(Math.max(0, s2 / n - m * m)) };
}

// A flat page: white paper with a dark text bar and a colour photo, lit by a strong
// gradient and a soft shadow.
function shadedPage() {
  const w = 400, h = 560;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let L = 0.55 + 0.45 * (x / w);
    const d = Math.hypot(x - 300, y - 400) / 140;
    L *= 1 - 0.35 * Math.max(0, 1 - d) ** 1.5;
    const ink = y > 100 && y < 120 && x > 50 && x < 350;
    const photo = x > 60 && x < 180 && y > 150 && y < 230;
    const base = ink ? [30, 30, 35] : photo ? [120 + x * 0.3, 110, 100 + y * 0.2] : [235, 228, 210];
    const i = (y * w + x) * 4;
    data[i] = base[0] * L; data[i + 1] = base[1] * L; data[i + 2] = base[2] * L; data[i + 3] = 255;
  }
  return { width: w, height: h, data };
}

test('auto filter removes lighting gradient and shadow, keeps text dark', () => {
  const page = shadedPage();
  const before = stats(page, 20, 260, 380, 540);
  const out = applyFilter(page, 'auto');
  const after = stats(out, 20, 260, 380, 540);
  assert.ok(before.std > 15, `input should be uneven (${before.std})`);
  assert.ok(after.std < 6, `paper should be uniform, std ${after.std}`);
  assert.ok(after.mean > 245, `paper should be white, mean ${after.mean}`);
  assert.ok(stats(out, 60, 104, 340, 116).mean < 90, 'text must stay dark');
  // The photo must keep its tone relative to the paper instead of turning white.
  const photoIn = stats(page, 80, 165, 160, 215).mean / stats(page, 80, 240, 160, 250).mean;
  const photoOut = stats(out, 80, 165, 160, 215).mean / 255;
  assert.ok(Math.abs(photoOut - photoIn) < 0.12, `photo ${photoOut} vs ${photoIn}`);
});

test('bw filter yields (almost) binary output', () => {
  const out = applyFilter(shadedPage(), 'bw');
  let mid = 0;
  for (let i = 0; i < out.data.length; i += 4) if (out.data[i] > 40 && out.data[i] < 215) mid++;
  assert.ok(mid / (out.width * out.height) < 0.03);
  assert.ok(stats(out, 60, 104, 340, 116).mean < 40);
  assert.ok(stats(out, 20, 260, 380, 540).mean > 250);
});

test('every filter runs and brightness/contrast adjust', () => {
  const page = shadedPage();
  for (const f of FILTERS) {
    const out = applyFilter(page, f.id);
    assert.equal(out.data.length, page.data.length);
  }
  const bright = applyFilter(page, 'original', { brightness: 50, contrast: 0 });
  assert.ok(stats(bright, 0, 0, 50, 50).mean > stats(page, 0, 0, 50, 50).mean + 50);
});
