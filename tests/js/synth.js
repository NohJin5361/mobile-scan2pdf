// Synthetic "photo of a document" generator for detection/enhancement tests.
// Renders a text page through a perspective transform onto a textured background,
// with lighting gradients, a soft shadow and sensor noise.
import { solveHomography, applyHomography } from '../../web/js/core/warp.js';

export function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

const DW = 1000;
const DH = 1414;

function makePage(rand, { photo = true } = {}) {
  // Precompute "words" per line: [x0, x1] spans.
  const lines = [];
  for (let y = 180; y < DH - 120; y += 34) {
    const words = [];
    let x = 90 + (rand() < 0.15 ? 60 : 0);
    const end = DW - 90 - (rand() < 0.2 ? rand() * 400 : 0);
    while (x < end) {
      const wl = 30 + rand() * 110;
      words.push([x, Math.min(end, x + wl)]);
      x += wl + 14 + rand() * 8;
    }
    lines.push({ y, words });
  }
  const photoBox = photo ? [560, 220, 900, 470] : null;
  return function pageColor(u, v) {
    // Title bar
    if (v > 90 && v < 130 && u > 90 && u < 600) return [30, 30, 40];
    if (photoBox && u > photoBox[0] && u < photoBox[2] && v > photoBox[1] && v < photoBox[3]) {
      const t = (u - photoBox[0]) / (photoBox[2] - photoBox[0]);
      const s = (v - photoBox[1]) / (photoBox[3] - photoBox[1]);
      return [60 + 150 * t, 90 + 80 * s, 160 - 100 * t];
    }
    const li = Math.floor((v - 180) / 34);
    if (li >= 0 && li < lines.length) {
      const ln = lines[li];
      const dv = v - ln.y;
      if (dv > 6 && dv < 24) {
        for (const [a, b] of ln.words) {
          if (u >= a && u <= b) {
            // Glyph-like texture: vertical strokes with gaps.
            const ph = (u * 0.55 + li * 3.1) % 6;
            if (ph < 2.4 || (dv > 13 && dv < 16)) return li % 7 === 3 ? [20, 40, 150] : [25, 25, 30];
            return null;
          }
        }
      }
    }
    return null;
  };
}

function background(kind, rand, w, h) {
  const rects = [];
  if (kind === 'clutter') {
    for (let i = 0; i < 14; i++) {
      rects.push({
        x: rand() * w, y: rand() * h, w: 40 + rand() * 260, h: 20 + rand() * 200,
        c: [rand() * 255, rand() * 255, rand() * 255],
      });
    }
  }
  return (x, y) => {
    switch (kind) {
      case 'wood': {
        const s = Math.sin(y * 0.045 + 3 * Math.sin(x * 0.008)) * 18 + Math.sin(y * 0.31 + x * 0.01) * 6;
        return [138 + s, 92 + s * 0.7, 58 + s * 0.4];
      }
      case 'dark':
        return [48, 50, 56];
      case 'light':
        return [198, 192, 182];
      case 'table-edge':
        return y < h * 0.3 + x * 0.12 ? [70, 75, 90] : [160, 128, 96];
      case 'clutter': {
        for (const r of rects) if (x > r.x && x < r.x + r.w && y > r.y && y < r.y + r.h) return r.c;
        return [120, 118, 112];
      }
      default:
        return [90, 90, 90];
    }
  };
}

/**
 * @returns {{image:{width,height,data}, corners:number[][]}}
 */
export function makeScene({
  width = 1200, height = 900, seed = 1, bg = 'wood', quad = null, shadow = true,
  lightGrad = 0.25, noise = 4, paper = [242, 240, 232], photo = true, occlude = false, physical = false,
} = {}) {
  const rand = rng(seed);
  const corners = quad || (physical ? physicalQuad(width, height, rand) : randomQuad(width, height, rand));
  const H = solveHomography(corners, [[0, 0], [DW, 0], [DW, DH], [0, DH]]);
  const page = makePage(rand, { photo });
  const bgf = background(bg, rand, width, height);
  const data = new Uint8ClampedArray(width * height * 4);
  const shX = width * (0.2 + rand() * 0.6), shY = height * (0.2 + rand() * 0.6);
  const shR = Math.min(width, height) * (0.25 + rand() * 0.2);
  const gx = (rand() - 0.5) * 2 * lightGrad, gy = (rand() - 0.5) * 2 * lightGrad;
  const sub = [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0, g = 0, b = 0;
      for (const [ox, oy] of sub) {
        const px = x + ox, py = y + oy;
        const [u, v] = applyHomography(H, px, py);
        let c;
        if (u >= 0 && v >= 0 && u <= DW && v <= DH) c = page(u, v) || paper;
        else c = bgf(px, py);
        r += c[0]; g += c[1]; b += c[2];
      }
      r /= 4; g /= 4; b /= 4;
      if (occlude) {
        // A "thumb" holding the page at the bottom edge.
        const bl = corners[3], br = corners[2];
        const mx = (bl[0] * 0.7 + br[0] * 0.3), my = (bl[1] * 0.7 + br[1] * 0.3);
        if ((x - mx) ** 2 / 2500 + (y - my) ** 2 / 900 < 1) { r = 200; g = 150; b = 125; }
      }
      let L = 1 + gx * (x / width - 0.5) + gy * (y / height - 0.5);
      if (shadow) {
        const d = Math.hypot(x - shX, y - shY) / shR;
        L *= 1 - 0.35 * Math.max(0, 1 - d) ** 1.5;
      }
      const n1 = (rand() + rand() + rand() - 1.5) * noise * 2;
      const i = (y * width + x) * 4;
      data[i] = r * L + n1;
      data[i + 1] = g * L + n1 * 0.9 + (rand() - 0.5) * noise;
      data[i + 2] = b * L + n1 * 1.1;
      data[i + 3] = 255;
    }
  }
  return { image: { width, height, data }, corners };
}

// A physically valid photo of an A4 sheet: random camera tilt/rotation, phone focal length.
export function physicalQuad(w, h, rand) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const f = Math.max(w, h) * (0.72 + rand() * 0.16);
    const q = projectRectangle({
      pw: 0.21, ph: 0.297, f, width: w, height: h,
      rx: (rand() - 0.5) * 0.7, ry: (rand() - 0.5) * 0.7, rz: (rand() - 0.5) * 0.5, dist: 0.36 + rand() * 0.18,
    });
    if (q.every(([x, y]) => x > 12 && y > 12 && x < w - 12 && y < h - 12)) return q;
  }
  return randomQuad(w, h, rand);
}

export function randomQuad(w, h, rand) {
  const ratio = rand() < 0.7 ? Math.SQRT2 : 11 / 8.5;
  const s = 0.55 + rand() * 0.3;
  let ph = h * s;
  let pw = ph / ratio;
  if (pw > w * 0.85) { pw = w * 0.85; ph = pw * ratio; }
  const cx = w / 2 + (rand() - 0.5) * (w - pw) * 0.5;
  const cy = h / 2 + (rand() - 0.5) * (h - ph) * 0.4;
  const ang = (rand() - 0.5) * 0.5;
  const base = [[-pw / 2, -ph / 2], [pw / 2, -ph / 2], [pw / 2, ph / 2], [-pw / 2, ph / 2]];
  const jit = 0.07 * Math.min(w, h);
  const q = base.map(([x, y]) => {
    const rx = x * Math.cos(ang) - y * Math.sin(ang);
    const ry = x * Math.sin(ang) + y * Math.cos(ang);
    return [cx + rx + (rand() - 0.5) * 2 * jit, cy + ry + (rand() - 0.5) * 2 * jit];
  });
  // Keep inside frame with a small margin.
  return q.map(([x, y]) => [Math.min(w - 8, Math.max(8, x)), Math.min(h - 8, Math.max(8, y))]);
}

// Projects a physical rectangle (pw x ph) seen by a pinhole camera.
export function projectRectangle({ pw, ph, f, width, height, rx = 0, ry = 0, rz = 0, dist = 3 }) {
  const pts = [[-pw / 2, -ph / 2, 0], [pw / 2, -ph / 2, 0], [pw / 2, ph / 2, 0], [-pw / 2, ph / 2, 0]];
  const cxr = Math.cos(rx), sxr = Math.sin(rx), cyr = Math.cos(ry), syr = Math.sin(ry), czr = Math.cos(rz), szr = Math.sin(rz);
  return pts.map(([x, y, z]) => {
    // Rz, then Ry, then Rx
    let X = x * czr - y * szr, Y = x * szr + y * czr, Z = z;
    [X, Z] = [X * cyr + Z * syr, -X * syr + Z * cyr];
    [Y, Z] = [Y * cxr - Z * sxr, Y * sxr + Z * cxr];
    Z += dist;
    return [width / 2 + (f * X) / Z, height / 2 + (f * Y) / Z];
  });
}

export function maxCornerError(a, b) {
  let m = 0;
  for (let i = 0; i < 4; i++) m = Math.max(m, Math.hypot(a[i][0] - b[i][0], a[i][1] - b[i][1]));
  return m;
}
