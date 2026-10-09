// Raster helpers shared by the browser, the Web Worker and the Node tests.
//
// RGBA images use the ImageData shape: { width, height, data: Uint8ClampedArray }.
// Single-channel "planes" are Float32Array of length width*height (row major).

export function createImage(width, height) {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

// For every destination index, the source indices and weights of an exact
// area-average (box) resample along one axis.
function areaWeights(srcSize, dstSize) {
  const scale = srcSize / dstSize;
  const starts = new Int32Array(dstSize + 1);
  const idx = [];
  const wts = [];
  for (let d = 0; d < dstSize; d++) {
    starts[d] = idx.length;
    const s0 = d * scale;
    const s1 = (d + 1) * scale;
    const end = Math.min(srcSize, Math.ceil(s1));
    for (let i = Math.floor(s0); i < end; i++) {
      const w = Math.min(i + 1, s1) - Math.max(i, s0);
      if (w > 1e-7) {
        idx.push(i);
        wts.push(w / scale);
      }
    }
  }
  starts[dstSize] = idx.length;
  return { starts, idx: Int32Array.from(idx), wts: Float32Array.from(wts) };
}

// High quality resize: exact area averaging when shrinking, bilinear when enlarging.
export function resizeImage(img, dw, dh) {
  dw = Math.max(1, Math.round(dw));
  dh = Math.max(1, Math.round(dh));
  const { width: sw, height: sh, data: src } = img;
  if (dw === sw && dh === sh) return { width: sw, height: sh, data: new Uint8ClampedArray(src) };
  if (dw > sw || dh > sh) return resizeBilinear(img, dw, dh);

  const wx = areaWeights(sw, dw);
  const wy = areaWeights(sh, dh);
  const row = dw * 4;
  // Horizontal pass into a float buffer (dw x sh).
  const tmp = new Float32Array(row * sh);
  for (let y = 0; y < sh; y++) {
    const srow = y * sw * 4;
    const trow = y * row;
    for (let x = 0; x < dw; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let k = wx.starts[x]; k < wx.starts[x + 1]; k++) {
        const si = srow + wx.idx[k] * 4;
        const w = wx.wts[k];
        r += src[si] * w; g += src[si + 1] * w; b += src[si + 2] * w; a += src[si + 3] * w;
      }
      const ti = trow + x * 4;
      tmp[ti] = r; tmp[ti + 1] = g; tmp[ti + 2] = b; tmp[ti + 3] = a;
    }
  }
  // Vertical pass.
  const out = createImage(dw, dh);
  const dst = out.data;
  const acc = new Float32Array(row);
  for (let y = 0; y < dh; y++) {
    acc.fill(0);
    for (let k = wy.starts[y]; k < wy.starts[y + 1]; k++) {
      const trow = wy.idx[k] * row;
      const w = wy.wts[k];
      for (let i = 0; i < row; i++) acc[i] += tmp[trow + i] * w;
    }
    const drow = y * row;
    for (let i = 0; i < row; i++) dst[drow + i] = acc[i] + 0.5;
  }
  return out;
}

export function resizeBilinear(img, dw, dh) {
  const { width: sw, height: sh, data: src } = img;
  const out = createImage(dw, dh);
  const dst = out.data;
  const sx = sw / dw;
  const sy = sh / dh;
  for (let y = 0; y < dh; y++) {
    let fy = (y + 0.5) * sy - 0.5;
    if (fy < 0) fy = 0;
    const y0 = Math.min(sh - 1, fy | 0);
    const y1 = Math.min(sh - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < dw; x++) {
      let fx = (x + 0.5) * sx - 0.5;
      if (fx < 0) fx = 0;
      const x0 = Math.min(sw - 1, fx | 0);
      const x1 = Math.min(sw - 1, x0 + 1);
      const tx = fx - x0;
      const i00 = (y0 * sw + x0) * 4, i01 = (y0 * sw + x1) * 4;
      const i10 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4;
      const di = (y * dw + x) * 4;
      for (let c = 0; c < 4; c++) {
        const top = src[i00 + c] + (src[i01 + c] - src[i00 + c]) * tx;
        const bot = src[i10 + c] + (src[i11 + c] - src[i10 + c]) * tx;
        dst[di + c] = top + (bot - top) * ty + 0.5;
      }
    }
  }
  return out;
}

// Resize so that the longest side is at most maxDim. Returns { image, scale }.
export function fitWithin(img, maxDim) {
  const long = Math.max(img.width, img.height);
  if (long <= maxDim) return { image: img, scale: 1 };
  const scale = maxDim / long;
  return {
    image: resizeImage(img, Math.round(img.width * scale), Math.round(img.height * scale)),
    scale,
  };
}

export function toGray(img) {
  const { width, height, data } = img;
  const n = width * height;
  const out = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    out[i] = 0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2];
  }
  return out;
}

export function channel(img, c) {
  const { width, height, data } = img;
  const n = width * height;
  const out = new Float32Array(n);
  for (let i = 0, j = c; i < n; i++, j += 4) out[i] = data[j];
  return out;
}

// Separable running-sum box blur with replicated borders.
export function boxBlur(plane, w, h, r, out) {
  out = out || new Float32Array(w * h);
  if (r < 1) {
    out.set(plane);
    return out;
  }
  const tmp = new Float32Array(w * h);
  const norm = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += plane[row + clampi(k, 0, w - 1)];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc * norm;
      const add = x + r + 1 < w ? x + r + 1 : w - 1;
      const sub = x - r > 0 ? x - r : 0;
      acc += plane[row + add] - plane[row + sub];
    }
  }
  // Vertical pass row by row (cache friendly) with a running column accumulator.
  const acc = new Float32Array(w);
  for (let k = -r; k <= r; k++) {
    const row = clampi(k, 0, h - 1) * w;
    for (let x = 0; x < w; x++) acc[x] += tmp[row + x];
  }
  for (let y = 0; y < h; y++) {
    const orow = y * w;
    const addRow = (y + r + 1 < h ? y + r + 1 : h - 1) * w;
    const subRow = (y - r > 0 ? y - r : 0) * w;
    for (let x = 0; x < w; x++) {
      out[orow + x] = acc[x] * norm;
      acc[x] += tmp[addRow + x] - tmp[subRow + x];
    }
  }
  return out;
}

// Gaussian blur approximated by three successive box blurs.
export function gaussianBlur(plane, w, h, sigma) {
  if (sigma <= 0.3) return Float32Array.from(plane);
  const n = 3;
  const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(wIdeal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const mIdeal = (12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4);
  const m = Math.round(mIdeal);
  let cur = plane;
  for (let i = 0; i < n; i++) {
    const size = i < m ? wl : wu;
    cur = boxBlur(cur, w, h, (size - 1) >> 1);
  }
  return cur;
}

// Separable max/min filter over a (2r+1) square window. Both passes walk memory
// contiguously; the window extremum is recomputed incrementally per row.
function morph(plane, w, h, r, isMax) {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  if (r < 1) {
    out.set(plane);
    return out;
  }
  const sgn = isMax ? 1 : -1;
  // Horizontal pass: compare in "sign-flipped" space so one max routine serves both.
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const x0 = x - r > 0 ? x - r : 0;
      const x1 = x + r < w - 1 ? x + r : w - 1;
      let m = sgn * plane[row + x0];
      for (let k = x0 + 1; k <= x1; k++) {
        const v = sgn * plane[row + k];
        if (v > m) m = v;
      }
      tmp[row + x] = sgn * m;
    }
  }
  // Vertical pass row by row.
  for (let y = 0; y < h; y++) {
    const orow = y * w;
    const y0 = y - r > 0 ? y - r : 0;
    const y1 = y + r < h - 1 ? y + r : h - 1;
    out.set(tmp.subarray(y0 * w, y0 * w + w), orow);
    for (let yy = y0 + 1; yy <= y1; yy++) {
      const srow = yy * w;
      if (isMax) {
        for (let x = 0; x < w; x++) { const v = tmp[srow + x]; if (v > out[orow + x]) out[orow + x] = v; }
      } else {
        for (let x = 0; x < w; x++) { const v = tmp[srow + x]; if (v < out[orow + x]) out[orow + x] = v; }
      }
    }
  }
  return out;
}

export const maxFilter = (plane, w, h, r) => morph(plane, w, h, r, true);
export const minFilter = (plane, w, h, r) => morph(plane, w, h, r, false);

export function sobel(plane, w, h) {
  const gx = new Float32Array(w * h);
  const gy = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const ym = y > 0 ? y - 1 : 0;
    const yp = y < h - 1 ? y + 1 : h - 1;
    for (let x = 0; x < w; x++) {
      const xm = x > 0 ? x - 1 : 0;
      const xp = x < w - 1 ? x + 1 : w - 1;
      const a = plane[ym * w + xm], b = plane[ym * w + x], c = plane[ym * w + xp];
      const d = plane[y * w + xm], f = plane[y * w + xp];
      const g = plane[yp * w + xm], hh = plane[yp * w + x], i = plane[yp * w + xp];
      gx[y * w + x] = c + 2 * f + i - a - 2 * d - g;
      gy[y * w + x] = g + 2 * hh + i - a - 2 * b - c;
    }
  }
  return { gx, gy };
}

// Approximate percentile (0..1) using a bounded random-free stride sample.
export function percentile(arr, p, maxSamples = 40000) {
  const n = arr.length;
  if (n === 0) return 0;
  const step = Math.max(1, Math.floor(n / maxSamples));
  const sample = new Float32Array(Math.ceil(n / step));
  for (let i = 0, k = 0; i < n; i += step) sample[k++] = arr[i];
  sample.sort(); // typed arrays sort numerically
  const k = Math.min(sample.length - 1, Math.max(0, Math.round(p * (sample.length - 1))));
  return sample[k];
}

// Otsu threshold over a histogram (array of counts). Returns the bin index.
export function otsu(hist) {
  let total = 0, sum = 0;
  for (let i = 0; i < hist.length; i++) {
    total += hist[i];
    sum += i * hist[i];
  }
  let wB = 0, sumB = 0, best = 0, bestVar = -1;
  for (let t = 0; t < hist.length; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > bestVar) {
      bestVar = v;
      best = t;
    }
  }
  return best;
}

// Bilinear sample of a plane at continuous pixel-centre coordinates.
export function samplePlane(plane, w, h, x, y) {
  if (x < 0) x = 0; else if (x > w - 1) x = w - 1;
  if (y < 0) y = 0; else if (y > h - 1) y = h - 1;
  const x0 = x | 0, y0 = y | 0;
  const x1 = x0 < w - 1 ? x0 + 1 : x0;
  const y1 = y0 < h - 1 ? y0 + 1 : y0;
  const tx = x - x0, ty = y - y0;
  const a = plane[y0 * w + x0], b = plane[y0 * w + x1];
  const c = plane[y1 * w + x0], d = plane[y1 * w + x1];
  return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
}

export function clampi(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export function rotateImage90(img, quarterTurns) {
  const k = ((quarterTurns % 4) + 4) % 4;
  if (k === 0) return img;
  const { width: w, height: h, data: src } = img;
  const ow = k === 2 ? w : h;
  const oh = k === 2 ? h : w;
  const out = createImage(ow, oh);
  const dst = out.data;
  const s32 = new Uint32Array(src.buffer, src.byteOffset, w * h);
  const d32 = new Uint32Array(dst.buffer, dst.byteOffset, ow * oh);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let nx, ny;
      if (k === 1) { nx = h - 1 - y; ny = x; }
      else if (k === 2) { nx = w - 1 - x; ny = h - 1 - y; }
      else { nx = y; ny = w - 1 - x; }
      d32[ny * ow + nx] = s32[y * w + x];
    }
  }
  return out;
}
