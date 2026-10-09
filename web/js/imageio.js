// Decoding / encoding images on the main thread with canvas.

const MAX_CANVAS_PIXELS = 16_777_216; // iOS Safari canvas limit (4096 x 4096)

/** Decodes a Blob honouring EXIF orientation. Returns { source, width, height, close }. */
export async function loadImage(blob) {
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  try {
    if (img.decode) await img.decode();
    else await new Promise((res, rej) => { img.onload = res; img.onerror = rej; });
  } catch {
    URL.revokeObjectURL(url);
    throw new Error('이미지를 열 수 없습니다 (지원하지 않는 형식일 수 있습니다)');
  }
  return {
    source: img,
    width: img.naturalWidth,
    height: img.naturalHeight,
    close() {
      URL.revokeObjectURL(url);
      img.src = '';
    },
  };
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

export function releaseCanvas(c) {
  c.width = 0;
  c.height = 0;
}

export function fitSize(w, h, maxDim, maxPixels = MAX_CANVAS_PIXELS) {
  let s = Math.min(1, maxDim / Math.max(w, h));
  if (w * h * s * s > maxPixels) s = Math.sqrt(maxPixels / (w * h));
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)), scale: s };
}

/** Draws `source` scaled to fit maxDim (step-down halving for quality). */
export function drawScaled(source, sw, sh, maxDim) {
  const { width, height } = fitSize(sw, sh, maxDim);
  let cur = source, cw = sw, ch = sh, tmp = null;
  // Halve repeatedly while far above the target: keeps fine text from aliasing.
  while (cw / 2 >= width * 1.5 && ch / 2 >= height * 1.5) {
    const nw = Math.round(cw / 2), nh = Math.round(ch / 2);
    const c = makeCanvas(nw, nh);
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(cur, 0, 0, nw, nh);
    if (tmp) releaseCanvas(tmp);
    tmp = c;
    cur = c;
    cw = nw;
    ch = nh;
  }
  const out = makeCanvas(width, height);
  const ctx = out.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(cur, 0, 0, width, height);
  if (tmp) releaseCanvas(tmp);
  return out;
}

export function drawToImageData(source, sw, sh, maxDim) {
  const c = drawScaled(source, sw, sh, maxDim);
  const data = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height);
  releaseCanvas(c);
  return { width: data.width, height: data.height, data: data.data };
}

export function canvasToBlob(canvas, type = 'image/jpeg', quality = 0.9) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('이미지 인코딩 실패'))), type, quality);
  });
}

export function imageDataToCanvas(img) {
  const c = makeCanvas(img.width, img.height);
  const data = img instanceof ImageData ? img : new ImageData(img.data, img.width, img.height);
  c.getContext('2d').putImageData(data, 0, 0);
  return c;
}

export async function imageDataToBlob(img, type = 'image/jpeg', quality = 0.9) {
  const c = imageDataToCanvas(img);
  try {
    return await canvasToBlob(c, type, quality);
  } finally {
    releaseCanvas(c);
  }
}

export async function thumbnailBlob(source, sw, sh, size = 360, quality = 0.8) {
  const c = drawScaled(source, sw, sh, size);
  try {
    return await canvasToBlob(c, 'image/jpeg', quality);
  } finally {
    releaseCanvas(c);
  }
}

/** Re-encodes a JPEG blob at a lower size/quality (export presets). */
export async function recompress(blob, maxDim, quality) {
  const img = await loadImage(blob);
  try {
    const c = drawScaled(img.source, img.width, img.height, maxDim);
    try {
      return await canvasToBlob(c, 'image/jpeg', quality);
    } finally {
      releaseCanvas(c);
    }
  } finally {
    img.close();
  }
}

/** Ensures the stored original is a widely supported format (HEIC etc. → JPEG). */
export async function normalizeOriginal(blob, loaded) {
  if (/^image\/(jpeg|png|webp)$/.test(blob.type)) return blob;
  const c = drawScaled(loaded.source, loaded.width, loaded.height, 8192);
  try {
    return await canvasToBlob(c, 'image/jpeg', 0.95);
  } finally {
    releaseCanvas(c);
  }
}

export async function blobToBytes(blob) {
  return new Uint8Array(await blob.arrayBuffer());
}
