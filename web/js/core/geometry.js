// 2D geometry used by detection and the crop editor.
// Points are [x, y]. Quads are arrays of 4 points ordered TL, TR, BR, BL.

export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

export function polygonArea(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2; // positive = clockwise in image coordinates (y down)
}

// Orders four points as TL, TR, BR, BL (clockwise on screen).
export function orderCorners(pts) {
  const cx = (pts[0][0] + pts[1][0] + pts[2][0] + pts[3][0]) / 4;
  const cy = (pts[0][1] + pts[1][1] + pts[2][1] + pts[3][1]) / 4;
  const sorted = pts
    .map((p) => [p[0], p[1]])
    .sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
  // atan2 ascending with y down is clockwise on screen. Start at the top-left-most corner.
  let start = 0;
  let best = Infinity;
  for (let i = 0; i < 4; i++) {
    const s = sorted[i][0] + sorted[i][1];
    if (s < best) {
      best = s;
      start = i;
    }
  }
  return [0, 1, 2, 3].map((k) => sorted[(start + k) % 4]);
}

function crossZ(o, a, b) {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

// True when the quad (in the given order) is strictly convex and not self-intersecting.
export function isConvexQuad(q, minAngleDeg = 0) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const z = crossZ(q[i], q[(i + 1) % 4], q[(i + 2) % 4]);
    if (Math.abs(z) < 1e-9) return false;
    const s = Math.sign(z);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  if (minAngleDeg > 0) {
    for (let i = 0; i < 4; i++) {
      const p = q[(i + 3) % 4], c = q[i], n = q[(i + 1) % 4];
      const a1 = Math.atan2(p[1] - c[1], p[0] - c[0]);
      const a2 = Math.atan2(n[1] - c[1], n[0] - c[0]);
      let d = Math.abs(a1 - a2) * 180 / Math.PI;
      if (d > 180) d = 360 - d;
      if (d < minAngleDeg || d > 180 - minAngleDeg) return false;
    }
  }
  return true;
}

// Andrew's monotone chain. Returns hull in clockwise screen order (y down).
export function convexHull(points) {
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && crossZ(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && crossZ(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

// Largest-area quadrilateral whose vertices are vertices of a convex polygon. O(n^3).
export function maxAreaQuad(poly) {
  const n = poly.length;
  if (n < 4) return null;
  const tri = (a, b, c) => Math.abs(crossZ(poly[a], poly[b], poly[c])) / 2;
  let best = -1;
  let bestQ = null;
  for (let i = 0; i < n; i++) {
    for (let k = i + 2; k < n; k++) {
      if (i === 0 && k === n - 1) continue;
      let bj = -1, bjA = -1;
      for (let j = i + 1; j < k; j++) {
        const a = tri(i, j, k);
        if (a > bjA) { bjA = a; bj = j; }
      }
      let bl = -1, blA = -1;
      for (let l = k + 1; l < n + i; l++) {
        const ll = l % n;
        const a = tri(k, ll, i);
        if (a > blA) { blA = a; bl = ll; }
      }
      if (bj < 0 || bl < 0) continue;
      const area = bjA + blA;
      if (area > best) {
        best = area;
        bestQ = [poly[i], poly[bj], poly[k], poly[bl]];
      }
    }
  }
  return bestQ;
}

// Douglas-Peucker simplification of a closed polygon.
export function simplifyClosed(poly, eps) {
  if (poly.length <= 8) return poly;
  // Split at the two farthest-apart vertices so the closed curve becomes two open chains.
  let a = 0, b = 0, far = -1;
  for (let i = 0; i < poly.length; i++) {
    const d = dist(poly[0], poly[i]);
    if (d > far) { far = d; b = i; }
  }
  far = -1;
  for (let i = 0; i < poly.length; i++) {
    const d = dist(poly[b], poly[i]);
    if (d > far) { far = d; a = i; }
  }
  if (a > b) [a, b] = [b, a];
  const chain1 = poly.slice(a, b + 1);
  const chain2 = poly.slice(b).concat(poly.slice(0, a + 1));
  const s1 = dp(chain1, eps);
  const s2 = dp(chain2, eps);
  return s1.slice(0, -1).concat(s2.slice(0, -1));
}

function dp(chain, eps) {
  if (chain.length < 3) return chain;
  const a = chain[0], b = chain[chain.length - 1];
  const len = dist(a, b) || 1e-9;
  let maxD = -1, idx = 0;
  for (let i = 1; i < chain.length - 1; i++) {
    const d = Math.abs(crossZ(a, b, chain[i])) / len;
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD <= eps) return [a, b];
  const left = dp(chain.slice(0, idx + 1), eps);
  const right = dp(chain.slice(idx), eps);
  return left.slice(0, -1).concat(right);
}

// Line in normal form: nx*x + ny*y = c with (nx, ny) unit length.
export function lineThrough(p, q) {
  const dx = q[0] - p[0], dy = q[1] - p[1];
  const len = Math.hypot(dx, dy) || 1e-9;
  const nx = -dy / len, ny = dx / len;
  return { nx, ny, c: nx * p[0] + ny * p[1] };
}

export function intersect(l1, l2) {
  const det = l1.nx * l2.ny - l1.ny * l2.nx;
  if (Math.abs(det) < 1e-9) return null;
  return [(l1.c * l2.ny - l1.ny * l2.c) / det, (l1.nx * l2.c - l1.c * l2.nx) / det];
}

// Total least squares line through points (optionally weighted).
export function fitLine(points, weights) {
  let sw = 0, mx = 0, my = 0;
  for (let i = 0; i < points.length; i++) {
    const w = weights ? weights[i] : 1;
    sw += w; mx += w * points[i][0]; my += w * points[i][1];
  }
  if (sw <= 0) return null;
  mx /= sw; my /= sw;
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < points.length; i++) {
    const w = weights ? weights[i] : 1;
    const dx = points[i][0] - mx, dy = points[i][1] - my;
    sxx += w * dx * dx; sxy += w * dx * dy; syy += w * dy * dy;
  }
  // Normal is the eigenvector of the smallest eigenvalue of the scatter matrix.
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy); // direction of the line
  const nx = -Math.sin(theta), ny = Math.cos(theta);
  return { nx, ny, c: nx * mx + ny * my };
}

// RANSAC + refit. Returns { line, inliers } or null.
export function robustLine(points, threshold, iterations = 60) {
  const n = points.length;
  if (n < 2) return null;
  let bestCount = -1, bestLine = null;
  // Deterministic pseudo-random sequence keeps results reproducible.
  let seed = 1234567;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let it = 0; it < iterations; it++) {
    const i = Math.floor(rnd() * n), j = Math.floor(rnd() * n);
    if (i === j) continue;
    if (dist(points[i], points[j]) < 1e-6) continue;
    const l = lineThrough(points[i], points[j]);
    let count = 0;
    for (const p of points) if (Math.abs(l.nx * p[0] + l.ny * p[1] - l.c) <= threshold) count++;
    if (count > bestCount) { bestCount = count; bestLine = l; }
  }
  if (!bestLine) return null;
  let line = bestLine;
  let inliers = [];
  for (let pass = 0; pass < 2; pass++) {
    inliers = points.filter((p) => Math.abs(line.nx * p[0] + line.ny * p[1] - line.c) <= threshold);
    if (inliers.length < 2) return null;
    const refit = fitLine(inliers);
    if (!refit) break;
    // Keep the normal orientation consistent with the original estimate.
    line = refit;
  }
  return { line, inliers };
}

export function quadArea(q) {
  return Math.abs(polygonArea(q));
}

export function clampQuad(q, w, h) {
  return q.map(([x, y]) => [Math.min(w, Math.max(0, x)), Math.min(h, Math.max(0, y))]);
}

export function fullQuad(w, h, insetFrac = 0) {
  const ix = w * insetFrac, iy = h * insetFrac;
  return [[ix, iy], [w - ix, iy], [w - ix, h - iy], [ix, h - iy]];
}
