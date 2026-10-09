// Scan enhancement filters.
//
// The colour filters divide every pixel by an estimate of the local paper colour
// ("background"). That single step removes shadows, uneven lighting and colour casts
// while keeping ink colours, so paper becomes white and text stays crisp. The
// background is estimated on a tiny copy of the page (max filter removes ink, blur
// smooths), and blended toward the global paper colour where the page is genuinely
// dark (photos, dark boxes) so those areas are not washed out.

import { resizeImage, maxFilter, boxBlur, sobel, percentile, otsu } from './image.js';

export const FILTERS = [
  { id: 'original', label: '원본' },
  { id: 'auto', label: '자동 보정' },
  { id: 'document', label: '선명한 문서' },
  { id: 'gray', label: '그레이' },
  { id: 'bw', label: '흑백' },
  { id: 'photo', label: '사진' },
];

export const DEFAULT_ADJUST = { brightness: 0, contrast: 0 };

function smoothstep(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

// Fills low-weight holes of `planes` by pyramid push-pull interpolation from the
// surrounding high-weight samples (weights in [0,1]).
function pushPull(planes, weight, w, h) {
  if (w <= 1 && h <= 1) return planes;
  const nw = Math.ceil(w / 2), nh = Math.ceil(h / 2);
  const cw = new Float32Array(nw * nh);
  const cp = planes.map(() => new Float32Array(nw * nh));
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      let ws = 0;
      const acc = [0, 0, 0];
      for (let dy = 0; dy < 2; dy++) {
        const yy = 2 * y + dy;
        if (yy >= h) continue;
        for (let dx = 0; dx < 2; dx++) {
          const xx = 2 * x + dx;
          if (xx >= w) continue;
          const i = yy * w + xx;
          const wt = weight[i];
          ws += wt;
          for (let c = 0; c < planes.length; c++) acc[c] += planes[c][i] * wt;
        }
      }
      const j = y * nw + x;
      cw[j] = Math.min(1, ws);
      for (let c = 0; c < planes.length; c++) cp[c][j] = ws > 1e-6 ? acc[c] / ws : 0;
    }
  }
  const coarse = pushPull(cp, cw, nw, nh);
  const out = planes.map(() => new Float32Array(w * h));
  for (let y = 0; y < h; y++) {
    const v = Math.min(nh - 1, Math.max(0, (y + 0.5) / 2 - 0.5));
    const y0 = v | 0, y1 = Math.min(nh - 1, y0 + 1), ty = v - y0;
    for (let x = 0; x < w; x++) {
      const u = Math.min(nw - 1, Math.max(0, (x + 0.5) / 2 - 0.5));
      const x0 = u | 0, x1 = Math.min(nw - 1, x0 + 1), tx = u - x0;
      const i = y * w + x;
      const wt = Math.min(1, weight[i]);
      for (let c = 0; c < planes.length; c++) {
        const p = coarse[c];
        const up = (p[y0 * nw + x0] * (1 - tx) + p[y0 * nw + x1] * tx) * (1 - ty)
          + (p[y1 * nw + x0] * (1 - tx) + p[y1 * nw + x1] * tx) * ty;
        out[c][i] = wt * planes[c][i] + (1 - wt) * up;
      }
    }
  }
  return out;
}

// Paper reachability: flood fill from the brightest paper through the ink-free
// background map, stopping at sharp steps. Lighting gradients and shadows change
// slowly and are crossed; printed photos, filled boxes and thick bars have crisp
// outlines and stay unreached, so they are not mistaken for shaded paper.
function reachablePaper(bgLum, w, h, P) {
  const n = w * h;
  const { gx, gy } = sobel(bgLum, w, h);
  const barrier = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    // Sobel/8 ~ per-pixel change, relative to the local brightness.
    const rel = Math.hypot(gx[i], gy[i]) / 8 / Math.max(8, bgLum[i]);
    barrier[i] = rel > 0.045 ? 1 : 0;
  }
  const wall = maxFilter(barrier, w, h, 1);
  const seen = new Uint8Array(n);
  const stack = [];
  for (let i = 0; i < n; i++) {
    if (bgLum[i] >= 0.85 * P && !wall[i]) {
      seen[i] = 1;
      stack.push(i);
    }
  }
  while (stack.length) {
    const p = stack.pop();
    const x = p % w;
    if (x > 0 && !seen[p - 1] && !wall[p - 1]) { seen[p - 1] = 1; stack.push(p - 1); }
    if (x < w - 1 && !seen[p + 1] && !wall[p + 1]) { seen[p + 1] = 1; stack.push(p + 1); }
    if (p >= w && !seen[p - w] && !wall[p - w]) { seen[p - w] = 1; stack.push(p - w); }
    if (p + w < n && !seen[p + w] && !wall[p + w]) { seen[p + w] = 1; stack.push(p + w); }
  }
  return seen;
}

export function estimateBackground(img) {
  const { width: w, height: h } = img;
  const s = Math.min(1, 192 / Math.max(w, h));
  const small = resizeImage(img, Math.max(2, Math.round(w * s)), Math.max(2, Math.round(h * s)));
  const sw = small.width, sh = small.height, n = sw * sh;
  const r = Math.max(2, Math.round(Math.min(sw, sh) * 0.035));
  // Local paper estimate: the max filter removes ink, the blur smooths it.
  let planes = [];
  const maxed = [];
  for (let c = 0; c < 3; c++) {
    const p = new Float32Array(n);
    for (let i = 0, j = c; i < n; i++, j += 4) p[i] = small.data[j];
    maxed.push(maxFilter(p, sw, sh, r));
    planes.push(boxBlur(maxed[c], sw, sh, r));
  }
  // Unblurred ink-free luminance keeps object outlines crisp for the barrier test.
  const bgSharp = new Float32Array(n);
  for (let i = 0; i < n; i++) bgSharp[i] = 0.299 * maxed[0][i] + 0.587 * maxed[1][i] + 0.114 * maxed[2][i];
  const bgLum = new Float32Array(n);
  const chroma = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    bgLum[i] = 0.299 * planes[0][i] + 0.587 * planes[1][i] + 0.114 * planes[2][i];
    const R = small.data[j], G = small.data[j + 1], B = small.data[j + 2];
    const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
    chroma[i] = (mx - mn) / Math.max(1, mx);
  }
  const P = Math.max(1, percentile(bgLum, 0.95));
  // Trust only paper-like samples: shadows (grey, soft-edged) qualify; photos, coloured
  // and sharp-edged areas do not and are filled from the surrounding paper, so their
  // content is kept instead of being washed out.
  const paperMask = reachablePaper(bgSharp, sw, sh, P);
  const chromaS = maxFilter(boxBlur(chroma, sw, sh, 1), sw, sh, r);
  const weight = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    weight[i] = paperMask[i] * smoothstep(0.2, 0.35, bgLum[i] / P) * (1 - smoothstep(0.12, 0.25, chromaS[i]));
  }
  // Make sure something anchors the fill even on unusual pages.
  let total = 0;
  for (let i = 0; i < n; i++) total += weight[i];
  if (total < 0.02 * n) weight.fill(1);
  planes = pushPull(planes, weight, sw, sh);
  const paper = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    planes[c] = boxBlur(planes[c], sw, sh, Math.max(1, r >> 1));
    for (let i = 0; i < n; i++) if (planes[c][i] < 8) planes[c][i] = 8;
    paper[c] = percentile(planes[c], 0.9);
  }
  return { sw, sh, planes, paper };
}

// Calls fn(i, r, g, b) with values normalised by the background (paper ~ 1.0).
function forEachNormalized(img, bg, fn) {
  const { width: w, height: h, data } = img;
  const { sw, sh, planes } = bg;
  const fx = sw / w, fy = sh / h;
  const xi0 = new Int32Array(w), xi1 = new Int32Array(w), xt = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    let u = (x + 0.5) * fx - 0.5;
    if (u < 0) u = 0;
    if (u > sw - 1) u = sw - 1;
    xi0[x] = u | 0;
    xi1[x] = Math.min(sw - 1, xi0[x] + 1);
    xt[x] = u - xi0[x];
  }
  const rowBg = [new Float32Array(sw), new Float32Array(sw), new Float32Array(sw)];
  for (let y = 0; y < h; y++) {
    let v = (y + 0.5) * fy - 0.5;
    if (v < 0) v = 0;
    if (v > sh - 1) v = sh - 1;
    const y0 = v | 0, y1 = Math.min(sh - 1, y0 + 1), ty = v - y0;
    for (let c = 0; c < 3; c++) {
      const p = planes[c], rb = rowBg[c];
      for (let x = 0; x < sw; x++) rb[x] = p[y0 * sw + x] * (1 - ty) + p[y1 * sw + x] * ty;
    }
    let i = y * w * 4;
    for (let x = 0; x < w; x++, i += 4) {
      const a = xi0[x], b = xi1[x], t = xt[x];
      const br = rowBg[0][a] + (rowBg[0][b] - rowBg[0][a]) * t;
      const bgG = rowBg[1][a] + (rowBg[1][b] - rowBg[1][a]) * t;
      const bb = rowBg[2][a] + (rowBg[2][b] - rowBg[2][a]) * t;
      fn(i, data[i] / br, data[i + 1] / bgG, data[i + 2] / bb);
    }
  }
}

// Ink level of the page in normalised units (low percentile of normalised luminance).
function blackPoint(img, bg) {
  const s = Math.min(1, 256 / Math.max(img.width, img.height));
  const small = resizeImage(img, Math.max(2, img.width * s), Math.max(2, img.height * s));
  const bgs = { ...bg };
  const vals = new Float32Array(small.width * small.height);
  let k = 0;
  forEachNormalized(small, bgs, (_i, r, g, b) => {
    vals[k++] = 0.299 * r + 0.587 * g + 0.114 * b;
  });
  return Math.min(0.35, Math.max(0, percentile(vals, 0.004)));
}

function toneParams(filter) {
  switch (filter) {
    case 'photo': return { white: 0.97, gamma: 1.0, sat: 1.1, sharpen: 0.15 };
    case 'document': return { white: 0.86, gamma: 1.35, sat: 1.3, sharpen: 0.45 };
    case 'gray': return { white: 0.88, gamma: 1.2, sat: 0, sharpen: 0.3 };
    default: return { white: 0.92, gamma: 1.1, sat: 1.15, sharpen: 0.2 };
  }
}

// Single global white point (no local correction): keeps photos exactly as shot,
// only fixing colour cast and exposure.
function globalBackground(img) {
  const s = Math.min(1, 256 / Math.max(img.width, img.height));
  const small = resizeImage(img, Math.max(2, img.width * s), Math.max(2, img.height * s));
  const n = small.width * small.height;
  const planes = [0, 1, 2].map((c) => {
    const p = new Float32Array(n);
    for (let i = 0, j = c; i < n; i++, j += 4) p[i] = small.data[j];
    return Float32Array.of(Math.max(32, percentile(p, 0.985)));
  });
  return { sw: 1, sh: 1, planes, paper: planes.map((p) => p[0]) };
}

function colourFilter(img, filter) {
  const bg = filter === 'photo' ? globalBackground(img) : estimateBackground(img);
  const bp = blackPoint(img, bg);
  const { white, gamma, sat, sharpen } = toneParams(filter);
  const out = { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data.length) };
  const d = out.data;
  const span = 1 / (white - bp);
  const lut = new Float32Array(1025); // tone curve sampled over [0, 1]
  for (let k = 0; k <= 1024; k++) lut[k] = Math.pow(k / 1024, gamma);
  const tone = (v) => {
    let t = (v - bp) * span;
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    return lut[(t * 1024) | 0];
  };
  forEachNormalized(img, bg, (i, r, g, b) => {
    let tr = tone(r), tg = tone(g), tb = tone(b);
    const Y = 0.299 * tr + 0.587 * tg + 0.114 * tb;
    if (sat === 0) {
      tr = tg = tb = Y;
    } else if (sat !== 1) {
      tr = Y + (tr - Y) * sat;
      tg = Y + (tg - Y) * sat;
      tb = Y + (tb - Y) * sat;
    }
    d[i] = tr * 255 + 0.5;
    d[i + 1] = tg * 255 + 0.5;
    d[i + 2] = tb * 255 + 0.5;
    d[i + 3] = 255;
  });
  if (sharpen > 0) sharpenInPlace(out, sharpen);
  return out;
}

function bwFilter(img) {
  const bg = estimateBackground(img);
  const { width: w, height: h } = img;
  const lum = new Float32Array(w * h);
  forEachNormalized(img, bg, (i, r, g, b) => {
    lum[i >> 2] = 0.299 * r + 0.587 * g + 0.114 * b;
  });
  const sm = boxBlur(lum, w, h, 1);
  // Threshold from the histogram of normalised luminance (Otsu), kept in a sane band.
  const bins = 256;
  const hist = new Float64Array(bins);
  const step = Math.max(1, Math.floor(sm.length / 200000));
  for (let i = 0; i < sm.length; i += step) hist[Math.min(bins - 1, Math.max(0, Math.round(sm[i] * 200)))]++;
  const t = Math.min(0.82, Math.max(0.5, otsu(hist) / 200 + 0.08));
  const out = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
  const d = out.data;
  const lo = t - 0.07, hi = t + 0.05;
  for (let p = 0, i = 0; p < sm.length; p++, i += 4) {
    // Blend sharp and smoothed luminance so thin strokes survive but noise is dropped.
    const v = 0.5 * sm[p] + 0.5 * lum[p];
    const y = smoothstep(lo, hi, v) * 255 + 0.5;
    d[i] = d[i + 1] = d[i + 2] = y;
    d[i + 3] = 255;
  }
  return out;
}

// 3x3 Laplacian sharpen, in place, using rolling row buffers (O(width) extra memory).
function sharpenInPlace(img, amount) {
  const { width: w, height: h, data } = img;
  if (w < 3 || h < 3) return;
  const row = w * 4;
  let prev = data.slice(0, row);
  let cur = data.slice(row, 2 * row);
  const c0 = 1 + 4 * amount;
  for (let y = 1; y < h - 1; y++) {
    const next = data.slice((y + 1) * row, (y + 2) * row);
    const base = y * row;
    for (let x = 1; x < w - 1; x++) {
      const k = x * 4;
      for (let c = 0; c < 3; c++) {
        const v = c0 * cur[k + c] - amount * (cur[k - 4 + c] + cur[k + 4 + c] + prev[k + c] + next[k + c]);
        data[base + k + c] = v;
      }
    }
    prev = cur;
    cur = next;
  }
}

function adjustLut({ brightness = 0, contrast = 0 } = {}) {
  if (!brightness && !contrast) return null;
  const c = contrast * 1.28;
  const f = (259 * (c + 255)) / (255 * (259 - c));
  const b = brightness * 1.28;
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) lut[v] = f * (v - 128) + 128 + b;
  return lut;
}

/** Applies a filter (see FILTERS) plus brightness/contrast. Returns a new image. */
export function applyFilter(img, filter = 'auto', adjust = DEFAULT_ADJUST) {
  let out;
  switch (filter) {
    case 'auto':
    case 'document':
    case 'gray':
    case 'photo':
      out = colourFilter(img, filter);
      break;
    case 'bw':
      out = bwFilter(img);
      break;
    default:
      out = { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) };
  }
  const lut = adjustLut(adjust);
  if (lut) {
    const d = out.data;
    for (let i = 0; i < d.length; i += 4) {
      d[i] = lut[d[i]];
      d[i + 1] = lut[d[i + 1]];
      d[i + 2] = lut[d[i + 2]];
    }
  }
  return out;
}
