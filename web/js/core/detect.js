// Document boundary detection.
//
// Pipeline (all on a downscaled copy):
//   1. Colour-aware gradients (max over R,G,B Sobel after Gaussian blur).
//   2. Canny edges (non-maximum suppression + hysteresis, adaptive thresholds).
//   3. Candidate quads from three independent generators:
//        a. oriented Hough lines -> pairs of roughly parallel lines -> quads
//        b. convex hulls of large edge components
//        c. convex hulls of large bright/dark regions (Otsu segmentation)
//   4. Every candidate is scored by how strongly its four sides are backed by image
//      gradient perpendicular to the side; the best one wins.
//   5. (still images) Each side is refined on a larger image by searching the strongest
//      edge along the side normal and fitting a robust line; corners are re-intersected.

import { resizeImage, gaussianBlur, sobel, percentile, otsu, samplePlane, toGray, maxFilter, minFilter } from './image.js';
import {
  orderCorners, isConvexQuad, convexHull, maxAreaQuad, simplifyClosed,
  intersect, robustLine, quadArea, dist, clampQuad, fitLine,
} from './geometry.js';

const DEG = Math.PI / 180;
const MIN_AREA = 0.1; // minimum page area as a fraction of the frame

function analyse(small) {
  const { width: w, height: h } = small;
  const n = w * h;
  const sigma = Math.max(1.2, Math.min(w, h) / 220);
  let gx = new Float32Array(n), gy = new Float32Array(n), mag = new Float32Array(n);
  for (let c = 0; c < 3; c++) {
    const plane = new Float32Array(n);
    for (let i = 0, j = c; i < n; i++, j += 4) plane[i] = small.data[j];
    const g = sobel(gaussianBlur(plane, w, h, sigma), w, h);
    for (let i = 0; i < n; i++) {
      const m = g.gx[i] * g.gx[i] + g.gy[i] * g.gy[i];
      if (m > mag[i]) {
        mag[i] = m;
        gx[i] = g.gx[i];
        gy[i] = g.gy[i];
      }
    }
  }
  for (let i = 0; i < n; i++) mag[i] = Math.sqrt(mag[i]);
  return { w, h, gx, gy, mag };
}

function canny(an, high) {
  const { w, h, gx, gy, mag } = an;
  const low = high * 0.45;
  const nms = new Uint8Array(w * h); // 0 none, 1 weak, 2 strong
  const t22 = Math.tan(22.5 * DEG), t67 = Math.tan(67.5 * DEG);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const m = mag[i];
      if (m < low) continue;
      const ax = Math.abs(gx[i]), ay = Math.abs(gy[i]);
      let a, b;
      if (ay <= ax * t22) { a = mag[i - 1]; b = mag[i + 1]; }
      else if (ay >= ax * t67) { a = mag[i - w]; b = mag[i + w]; }
      else if (gx[i] * gy[i] > 0) { a = mag[i - w - 1]; b = mag[i + w + 1]; }
      else { a = mag[i - w + 1]; b = mag[i + w - 1]; }
      if (m >= a && m > b) nms[i] = m >= high ? 2 : 1;
    }
  }
  // Hysteresis: grow strong edges through weak ones.
  const edges = new Uint8Array(w * h);
  const stack = [];
  for (let i = 0; i < w * h; i++) {
    if (nms[i] === 2 && !edges[i]) {
      edges[i] = 1;
      stack.push(i);
      while (stack.length) {
        const p = stack.pop();
        const px = p % w, py = (p / w) | 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = py + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = px + dx;
            if (xx < 0 || xx >= w) continue;
            const q = yy * w + xx;
            if (nms[q] && !edges[q]) {
              edges[q] = 1;
              stack.push(q);
            }
          }
        }
      }
    }
  }
  return edges;
}

// ---------------------------------------------------------------- side support

// Per-sample support in [0,1] for both edge polarities: the strongest positive and
// negative gradient component along the side normal within +-2 px, relative to the
// "strong edge" level T. A real page border keeps one polarity along its whole length
// (paper on one side, background on the other); text lines alternate, so scoring each
// polarity separately keeps text baselines from masquerading as page sides.
function makeSupport(an, T) {
  const { w, h, gx, gy } = an;
  const res = [0, 0];
  return function support(x, y, nx, ny) {
    let pos = 0, neg = 0;
    for (let o = -2; o <= 2; o++) {
      const sx = Math.round(x + nx * o), sy = Math.round(y + ny * o);
      if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
      const i = sy * w + sx;
      const v = gx[i] * nx + gy[i] * ny;
      if (v > pos) pos = v;
      else if (-v > neg) neg = -v;
    }
    pos /= T;
    neg /= T;
    res[0] = pos > 1 ? 1 : pos;
    res[1] = neg > 1 ? 1 : neg;
    return res;
  };
}

function segmentSupport(support, a, b, w, h) {
  const len = dist(a, b);
  if (len < 1) return 0;
  const dx = (b[0] - a[0]) / len, dy = (b[1] - a[1]) / len;
  const nx = -dy, ny = dx;
  const steps = Math.max(2, Math.floor(len));
  let accP = 0, accN = 0, cnt = 0;
  for (let k = 0; k <= steps; k++) {
    const t = k / steps;
    const x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t;
    cnt++;
    if (x < 1 || y < 1 || x > w - 2 || y > h - 2) {
      // Side runs along/outside the frame border: the page is cut off here, give partial credit.
      accP += 0.5;
      accN += 0.5;
      continue;
    }
    const r = support(x, y, nx, ny);
    accP += r[0];
    accN += r[1];
  }
  return Math.max(accP, accN) / cnt;
}

function scoreQuad(q, support, w, h) {
  let score = 0, perim = 0, minS = 1, sumS = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4];
    const len = dist(a, b);
    const s = segmentSupport(support, a, b, w, h);
    score += len * s * s;
    perim += len;
    sumS += s;
    if (s < minS) minS = s;
  }
  return { score, perim, minS, meanS: sumS / 4 };
}

function validQuad(q, w, h, minAreaFrac) {
  if (!isConvexQuad(q, 35)) return false;
  const area = quadArea(q);
  if (area < minAreaFrac * w * h) return false;
  const mx = 0.08 * w, my = 0.08 * h;
  for (const [x, y] of q) if (x < -mx || y < -my || x > w + mx || y > h + my) return false;
  // Reject slivers: opposite sides must not differ wildly in length.
  const s = [0, 1, 2, 3].map((i) => dist(q[i], q[(i + 1) % 4]));
  if (Math.min(s[0], s[2]) < 0.25 * Math.max(s[0], s[2])) return false;
  if (Math.min(s[1], s[3]) < 0.25 * Math.max(s[1], s[3])) return false;
  if (Math.min(...s) < 0.12 * Math.min(w, h)) return false;
  return true;
}

// ---------------------------------------------------------------- candidates

function houghLines(an, edges, maxLines) {
  const { w, h, gx, gy } = an;
  const nTheta = 180;
  const diag = Math.ceil(Math.hypot(w, h));
  const nRho = 2 * diag + 1;
  const acc = new Float32Array(nTheta * nRho);
  const cosT = new Float32Array(nTheta), sinT = new Float32Array(nTheta);
  for (let t = 0; t < nTheta; t++) {
    cosT[t] = Math.cos(t * DEG);
    sinT[t] = Math.sin(t * DEG);
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!edges[i]) continue;
      let th = Math.atan2(gy[i], gx[i]);
      if (th < 0) th += Math.PI;
      const tc = Math.round(th / DEG);
      for (let dt = -3; dt <= 3; dt++) {
        const t = (tc + dt + nTheta) % nTheta;
        const rho = x * cosT[t] + y * sinT[t];
        const r = Math.round(rho) + diag;
        acc[t * nRho + r] += dt === 0 ? 1 : 0.8;
      }
    }
  }
  const minVotes = Math.max(10, 0.12 * Math.min(w, h));
  const peaks = [];
  const RT = 4, RR = 6;
  for (let t = 0; t < nTheta; t++) {
    for (let r = 0; r < nRho; r++) {
      const v = acc[t * nRho + r];
      if (v < minVotes) continue;
      let isMax = true;
      for (let dt = -RT; dt <= RT && isMax; dt++) {
        let tt = t + dt, rr0 = r;
        if (tt < 0) { tt += nTheta; rr0 = nRho - 1 - r; }
        else if (tt >= nTheta) { tt -= nTheta; rr0 = nRho - 1 - r; }
        for (let dr = -RR; dr <= RR; dr++) {
          const rr = rr0 + dr;
          if (rr < 0 || rr >= nRho || (dt === 0 && dr === 0)) continue;
          const o = acc[tt * nRho + rr];
          if (o > v || (o === v && (tt * nRho + rr) < t * nRho + r)) { isMax = false; break; }
        }
      }
      if (isMax) peaks.push({ t, rho: r - diag, votes: v });
    }
  }
  peaks.sort((a, b) => b.votes - a.votes);
  return peaks.slice(0, maxLines).map((p) => ({
    theta: p.t * DEG,
    nx: cosT[p.t],
    ny: sinT[p.t],
    c: p.rho,
    votes: p.votes,
  }));
}

function angleBetween(l1, l2) {
  let d = Math.abs(l1.theta - l2.theta) % Math.PI;
  if (d > Math.PI / 2) d = Math.PI - d;
  return d;
}

// Refits each Hough line to the edge pixels close to it (sub-degree accuracy).
function refineLines(lines, an, edges) {
  const { w, h, gx, gy } = an;
  // Edge pixels with unit gradient direction, gathered once.
  const ex = [], ey = [], ux = [], uy = [];
  for (let i = 0; i < w * h; i++) {
    if (!edges[i]) continue;
    const g = Math.hypot(gx[i], gy[i]) || 1;
    ex.push(i % w); ey.push((i / w) | 0); ux.push(gx[i] / g); uy.push(gy[i] / g);
  }
  const out = [];
  for (const l of lines) {
    const pts = [];
    for (let k = 0; k < ex.length; k++) {
      const d = l.nx * ex[k] + l.ny * ey[k] - l.c;
      if (d > 2.5 || d < -2.5) continue;
      if (Math.abs(ux[k] * l.nx + uy[k] * l.ny) < 0.94) continue;
      pts.push([ex[k], ey[k]]);
    }
    let line = { nx: l.nx, ny: l.ny, c: l.c };
    if (pts.length >= 8) {
      const f = fitLine(pts);
      if (f) {
        // Keep the original normal orientation.
        if (f.nx * l.nx + f.ny * l.ny < 0) { f.nx = -f.nx; f.ny = -f.ny; f.c = -f.c; }
        line = f;
      }
    }
    let theta = Math.atan2(line.ny, line.nx);
    if (theta < 0) theta += Math.PI;
    out.push({ ...line, theta, votes: l.votes });
  }
  return out;
}

function dedupeLines(lines, w, h) {
  const out = [];
  const cx = w / 2, cy = h / 2;
  for (const l of lines) {
    const dup = out.some((o) => {
      if (angleBetween(o, l) > 2.5 * DEG) return false;
      const sgn = o.nx * l.nx + o.ny * l.ny >= 0 ? 1 : -1;
      const do_ = o.nx * cx + o.ny * cy - o.c;
      const dl = sgn * (l.nx * cx + l.ny * cy - l.c);
      return Math.abs(do_ - dl) < 3;
    });
    if (!dup) out.push(l);
  }
  return out;
}

// Precomputes prefix sums of side support along each line so any segment of it can be
// scored in O(1).
function attachProfiles(lines, support, w, h) {
  for (const l of lines) {
    const dx = -l.ny, dy = l.nx;
    const px = l.nx * l.c, py = l.ny * l.c;
    let tmin = -Infinity, tmax = Infinity;
    for (const [p, d, lim] of [[px, dx, w - 1], [py, dy, h - 1]]) {
      if (Math.abs(d) < 1e-9) {
        if (p < 0 || p > lim) { tmin = 1; tmax = 0; }
      } else {
        const a = (0 - p) / d, b = (lim - p) / d;
        tmin = Math.max(tmin, Math.min(a, b));
        tmax = Math.min(tmax, Math.max(a, b));
      }
    }
    const t0 = Math.ceil(tmin);
    const n = tmax >= tmin ? Math.max(0, Math.floor(tmax) - t0 + 1) : 0;
    const pre = new Float32Array(n + 1), preN = new Float32Array(n + 1);
    for (let k = 0; k < n; k++) {
      const t = t0 + k;
      const x = px + t * dx, y = py + t * dy;
      let vp = 0.5, vn = 0.5;
      if (!(x < 1 || y < 1 || x > w - 2 || y > h - 2)) {
        const r = support(x, y, l.nx, l.ny);
        vp = r[0];
        vn = r[1];
      }
      pre[k + 1] = pre[k] + vp;
      preN[k + 1] = preN[k] + vn;
    }
    l.prof = { t0, n, pre, preN, px, py, dx, dy };
  }
}

function profileSupport(l, p, q) {
  const { t0, n, pre, preN, px, py, dx, dy } = l.prof;
  let ta = (p[0] - px) * dx + (p[1] - py) * dy;
  let tb = (q[0] - px) * dx + (q[1] - py) * dy;
  if (ta > tb) [ta, tb] = [tb, ta];
  const len = tb - ta;
  if (len < 1) return 0;
  const a = Math.max(0, Math.min(n, Math.round(ta - t0)));
  const b = Math.max(0, Math.min(n, Math.round(tb - t0)));
  const inside = b - a;
  const sum = inside > 0 ? Math.max(pre[b] - pre[a], preN[b] - preN[a]) : 0;
  return (sum + 0.5 * Math.max(0, len - inside)) / len;
}

// Builds quads from pairs of roughly parallel lines and scores them via line profiles.
function lineQuads(lines, w, h, minAreaFrac) {
  const pairs = [];
  const minSep = 0.12 * Math.min(w, h);
  const cx = w / 2, cy = h / 2;
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const a = lines[i], b = lines[j];
      if (angleBetween(a, b) > 40 * DEG) continue;
      const da = a.nx * cx + a.ny * cy - a.c;
      const sign = a.nx * b.nx + a.ny * b.ny >= 0 ? 1 : -1;
      const db = sign * (b.nx * cx + b.ny * cy - b.c);
      if (Math.abs(da - db) < minSep) continue;
      pairs.push([a, b]);
    }
  }
  const results = [];
  for (let p = 0; p < pairs.length; p++) {
    for (let r = p + 1; r < pairs.length; r++) {
      const [a, b] = pairs[p];
      const [c, d] = pairs[r];
      if (a === c || a === d || b === c || b === d) continue;
      if (angleBetween(a, c) < 35 * DEG || angleBetween(b, d) < 35 * DEG) continue;
      const p1 = intersect(a, c), p2 = intersect(a, d), p3 = intersect(b, c), p4 = intersect(b, d);
      if (!p1 || !p2 || !p3 || !p4) continue;
      const poly = [p1, p2, p4, p3];
      if (!validQuad(poly, w, h, minAreaFrac)) continue;
      const sides = [[a, p1, p2], [d, p2, p4], [b, p4, p3], [c, p3, p1]];
      let score = 0, perim = 0, minS = 1;
      for (const [l, u, v] of sides) {
        const len = dist(u, v);
        const s = profileSupport(l, u, v);
        score += len * s * s;
        perim += len;
        if (s < minS) minS = s;
      }
      results.push({ quad: orderCorners(poly), score, perim, minS });
    }
  }
  return results;
}

// 8-connected component labelling. Returns per-component stats; components whose
// bounding box passes `keep` also get per-row min/max x (enough for a convex hull).
function labelComponents(mask, w, h, keep) {
  const labels = new Int32Array(w * h);
  const comps = [];
  const stack = new Int32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (!mask[i] || labels[i]) continue;
    const id = comps.length + 1;
    labels[i] = id;
    let sp = 0;
    stack[sp++] = i;
    let count = 0, minX = w, maxX = 0, minY = h, maxY = 0;
    while (sp > 0) {
      const p = stack[--sp];
      const x = p % w, y = (p / w) | 0;
      count++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      const y0 = y > 0 ? y - 1 : 0, y1 = y < h - 1 ? y + 1 : h - 1;
      const x0 = x > 0 ? x - 1 : 0, x1 = x < w - 1 ? x + 1 : w - 1;
      for (let yy = y0; yy <= y1; yy++) {
        for (let xx = x0; xx <= x1; xx++) {
          const q = yy * w + xx;
          if (mask[q] && !labels[q]) {
            labels[q] = id;
            stack[sp++] = q;
          }
        }
      }
    }
    comps.push({ id, count, minX, maxX, minY, maxY });
  }
  for (const c of comps) {
    if (keep && !keep(c)) continue;
    const rowMin = new Map(), rowMax = new Map();
    for (let y = c.minY; y <= c.maxY; y++) {
      let lo = -1, hi = -1;
      for (let x = c.minX; x <= c.maxX; x++) {
        if (labels[y * w + x] === c.id) {
          if (lo < 0) lo = x;
          hi = x;
        }
      }
      if (lo >= 0) { rowMin.set(y, lo); rowMax.set(y, hi); }
    }
    c.rowMin = rowMin;
    c.rowMax = rowMax;
  }
  return comps;
}

function hullQuad(comp) {
  const pts = [];
  for (const [y, x] of comp.rowMin) pts.push([x + 0.5, y + 0.5]);
  for (const [y, x] of comp.rowMax) pts.push([x + 0.5, y + 0.5]);
  const hull = convexHull(pts);
  if (hull.length < 4) return null;
  let perim = 0;
  for (let i = 0; i < hull.length; i++) perim += dist(hull[i], hull[(i + 1) % hull.length]);
  const simple = simplifyClosed(hull, perim * 0.004);
  const q = maxAreaQuad(simple.length >= 4 ? simple : hull);
  return q ? orderCorners(q) : null;
}

function contourQuads(edges, w, h) {
  // Close small gaps in the edge map first.
  const plane = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) plane[i] = edges[i];
  const dil = maxFilter(plane, w, h, 1);
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) mask[i] = dil[i] > 0 ? 1 : 0;
  const out = [];
  const big = (c) => c.maxX - c.minX >= 0.25 * w && c.maxY - c.minY >= 0.25 * h;
  for (const c of labelComponents(mask, w, h, big)) {
    if (!c.rowMin) continue;
    const q = hullQuad(c);
    if (q) out.push(q);
  }
  return out;
}

function regionQuads(small) {
  // Coarse by nature, so work at <= 256 px and scale the quads back.
  const rs = Math.min(1, 256 / Math.max(small.width, small.height));
  const img = rs < 1 ? resizeImage(small, small.width * rs, small.height * rs) : small;
  const { width: w, height: h } = img;
  const bx = small.width / w, by = small.height / h;
  const gray = gaussianBlur(toGray(img), w, h, 1.5);
  const hist = new Float64Array(256);
  for (let i = 0; i < gray.length; i++) hist[Math.min(255, Math.max(0, gray[i] | 0))]++;
  const t = otsu(hist);
  const out = [];
  for (const bright of [true, false]) {
    const plane = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) plane[i] = (gray[i] > t) === bright ? 1 : 0;
    // Morphological opening detaches the page from touching clutter, closing fills text.
    const opened = maxFilter(minFilter(plane, w, h, 1), w, h, 1);
    const closed = minFilter(maxFilter(opened, w, h, 2), w, h, 2);
    const mask = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) mask[i] = closed[i] > 0.5 ? 1 : 0;
    const big = (c) => c.count >= 0.08 * w * h && c.count <= 0.97 * w * h;
    for (const c of labelComponents(mask, w, h, big)) {
      if (!c.rowMin) continue;
      const q = hullQuad(c);
      if (q) out.push(q.map(([x, y]) => [x * bx, y * by]));
    }
  }
  return out;
}

// ---------------------------------------------------------------- refinement

function refineQuad(q, gray, w, h) {
  const R = Math.max(4, Math.round(0.012 * Math.max(w, h)));
  const lines = [];
  for (let s = 0; s < 4; s++) {
    const a = q[s], b = q[(s + 1) % 4];
    const len = dist(a, b);
    const dx = (b[0] - a[0]) / len, dy = (b[1] - a[1]) / len;
    const nx = -dy, ny = dx;
    const N = Math.max(12, Math.min(80, Math.round(len / 6)));
    const pts = [];
    const signs = [];
    for (let k = 1; k < N; k++) {
      const t = 0.04 + 0.92 * (k / N);
      const px = a[0] + (b[0] - a[0]) * t, py = a[1] + (b[1] - a[1]) * t;
      let best = 0, bestO = 0, bestSign = 0;
      const prof = [];
      for (let o = -R - 1; o <= R + 1; o++) {
        prof.push(samplePlane(gray, w, h, px + nx * o - 0.5, py + ny * o - 0.5));
      }
      for (let o = -R; o <= R; o++) {
        const i = o + R + 1;
        const d = prof[i + 1] - prof[i - 1];
        // Mild preference for the initial position avoids jumping to nearby clutter.
        const v = Math.abs(d) * (1 - 0.25 * Math.abs(o) / R);
        if (v > best) { best = v; bestO = o; bestSign = Math.sign(d); }
      }
      if (best < 6) continue;
      // Sub-pixel peak via parabola through neighbouring derivative magnitudes.
      const i = bestO + R + 1;
      if (i - 2 >= 0 && i + 2 < prof.length) {
        const ym = Math.abs(prof[i] - prof[i - 2]);
        const y0 = Math.abs(prof[i + 1] - prof[i - 1]);
        const yp = Math.abs(prof[i + 2] - prof[i]);
        const den = ym - 2 * y0 + yp;
        const off = den < 0 ? 0.5 * (ym - yp) / den : 0;
        bestO += Math.max(-0.5, Math.min(0.5, off));
      }
      pts.push([px + nx * bestO, py + ny * bestO]);
      signs.push(bestSign);
    }
    // Keep the dominant edge polarity (page brighter or darker than background).
    const pos = signs.filter((v) => v > 0).length;
    const keepSign = pos >= signs.length - pos ? 1 : -1;
    const filtered = pts.filter((_, i) => signs[i] === keepSign);
    if (filtered.length < Math.max(6, 0.35 * N)) return null;
    const fit = robustLine(filtered, Math.max(1.2, R * 0.15));
    if (!fit || fit.inliers.length < Math.max(5, 0.3 * N)) return null;
    lines.push(fit.line);
  }
  const out = [];
  for (let i = 0; i < 4; i++) {
    const p = intersect(lines[(i + 3) % 4], lines[i]);
    if (!p) return null;
    out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------- public API

/**
 * Detects the document quadrilateral.
 * @param {{width,height,data}} img  RGBA image (any size).
 * @param {object} [opts]
 * @param {number} [opts.maxDim=512]   working size for candidate search
 * @param {boolean} [opts.refine=true] sub-pixel refinement on a larger copy
 * @param {{width,height,data}} [opts.refineImage] larger copy of the same image for refinement
 * @param {number} [opts.minConfidence=0.4] reject weaker detections
 * @param {boolean} [opts.regions=true] also try colour-segmentation candidates
 * @returns {{corners:number[][], confidence:number}|null} corners in `img` pixels (TL,TR,BR,BL)
 */
export function detectDocument(img, opts = {}) {
  const maxDim = opts.maxDim || 512;
  const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
  const small = scale < 1 ? resizeImage(img, img.width * scale, img.height * scale) : img;
  const { width: w, height: h } = small;
  const sx = img.width / w, sy = img.height / h;

  const an = analyse(small);
  const p99 = percentile(an.mag, 0.99);
  const high = Math.max(18, 0.22 * p99);
  const T = Math.max(14, 0.6 * high);
  const support = makeSupport(an, T);

  // Edges at a normal and a sensitive threshold: faint page borders (white paper on a
  // white desk) only survive the second one.
  const edgesHi = canny(an, high);
  const edgesLo = canny(an, Math.max(8, high * 0.4));
  let lines = houghLines(an, edgesHi, 24).concat(houghLines(an, edgesLo, 24));
  lines = dedupeLines(refineLines(lines, an, edgesLo), w, h);
  attachProfiles(lines, support, w, h);
  const scored = lineQuads(lines, w, h, MIN_AREA);
  const others = contourQuads(edgesHi, w, h).concat(contourQuads(edgesLo, w, h));
  if (opts.regions !== false) others.push(...regionQuads(small));
  for (const q of others) {
    if (!validQuad(q, w, h, MIN_AREA)) continue;
    scored.push({ quad: q, ...scoreQuad(q, support, w, h) });
  }
  const best = pickBest(scored, w, h);
  if (!best || best.confidence < (opts.minConfidence ?? 0.4)) return null;
  return finish(best);

  function finish(best) {
    let corners = best.quad.map(([x, y]) => [x * sx, y * sy]);
    if (opts.refine !== false) {
      const big = opts.refineImage || img;
      const rs = Math.min(1, 1600 / Math.max(big.width, big.height));
      const rimg = rs < 1 ? resizeImage(big, big.width * rs, big.height * rs) : big;
      const gx = rimg.width / img.width, gy = rimg.height / img.height;
      const gray = gaussianBlur(toGray(rimg), rimg.width, rimg.height, 1.0);
      const startQ = corners.map(([x, y]) => [x * gx, y * gy]);
      const refined = refineQuad(startQ, gray, rimg.width, rimg.height);
      if (refined && isConvexQuad(refined, 30)) {
        const tol = 0.035 * Math.max(rimg.width, rimg.height);
        const ok = refined.every((p, i) => dist(p, startQ[i]) < tol);
        if (ok) corners = orderCorners(refined).map(([x, y]) => [x / gx, y / gy]);
      }
    }
    corners = clampQuad(orderCorners(corners), img.width, img.height);
    return { corners, confidence: Math.round(best.confidence * 1000) / 1000 };
  }
}

function pickBest(scored, w, h) {
  let best = null;
  for (const s of scored) {
    if (s.minS < 0.2) continue;
    if (!best || s.score > best.score) best = s;
  }
  if (!best) return null;
  return { quad: clampQuad(best.quad, w, h), score: best.score, confidence: best.score / best.perim, minS: best.minS };
}

// Exposed for tests and tuning tools.
export const _internals = { analyse, canny, makeSupport, scoreQuad, houghLines, lineQuads, contourQuads, regionQuads, pickBest };
