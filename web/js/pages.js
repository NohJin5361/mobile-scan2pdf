// Page pipeline: original photo -> detected corners -> processed scan (+ thumbnail).
import * as store from './store.js';
import { run } from './processor.js';
import { loadImage, drawToImageData, imageDataToCanvas, canvasToBlob, releaseCanvas, thumbnailBlob, normalizeOriginal } from './imageio.js';
import { getSettings } from './settings.js';
import { uuid } from './util.js';

export const FULL_QUAD = [[0, 0], [1, 0], [1, 1], [0, 1]];
export const DEFAULT_ADJUST = { brightness: 0, contrast: 0 };

// ------------------------------------------------------------------ decoded originals

const decoded = new Map(); // originalId -> Promise<loaded image>
const DECODED_MAX = 2;      // full-size photos are big: keep phones well within memory

/** Decoded original for a page (small LRU so editors reopen instantly). */
export function loadOriginal(page) {
  const key = page.originalId;
  if (decoded.has(key)) {
    const p = decoded.get(key);
    decoded.delete(key);
    decoded.set(key, p);
    return p;
  }
  const p = (async () => {
    const blob = await store.getBlob(page.id, 'original');
    if (!blob) throw new Error('원본 이미지가 없습니다');
    return loadImage(blob);
  })();
  decoded.set(key, p);
  p.catch(() => decoded.delete(key));
  while (decoded.size > DECODED_MAX) {
    const [k, old] = decoded.entries().next().value;
    decoded.delete(k);
    old.then((img) => img.close()).catch(() => {});
  }
  return p;
}

function rememberDecoded(originalId, loaded) {
  decoded.set(originalId, Promise.resolve(loaded));
  while (decoded.size > DECODED_MAX) {
    const [k, old] = decoded.entries().next().value;
    decoded.delete(k);
    old.then((img) => img.close()).catch(() => {});
  }
}

// ------------------------------------------------------------------ detection

/** Finds the page in a decoded image. Returns normalised corners or null. */
export async function detectCorners(loaded) {
  const small = drawToImageData(loaded.source, loaded.width, loaded.height, 512);
  const refine = drawToImageData(loaded.source, loaded.width, loaded.height, 1600);
  const res = await run('detect', { image: small, refineImage: refine, maxDim: 512 }, [small.data.buffer, refine.data.buffer]);
  if (!res) return null;
  return {
    corners: res.corners.map(([x, y]) => [x / small.width, y / small.height]),
    confidence: res.confidence,
  };
}

// Live-preview corners are only valid when the photo has the preview's proportions.
function usableHint(hintCorners, hintAspect, loaded) {
  if (!hintCorners) return null;
  if (hintAspect && Math.abs(loaded.width / loaded.height / hintAspect - 1) > 0.03) return null;
  return hintCorners;
}

// ------------------------------------------------------------------ rendering

const toPixels = (corners, w, h) => corners.map(([x, y]) => [x * w, y * h]);

/** Produces the processed JPEG + thumbnail for a page from its decoded original. */
export async function renderPage(page, loaded) {
  const s = getSettings();
  const src = drawToImageData(loaded.source, loaded.width, loaded.height, s.sourceMaxDim);
  const out = await run('process', {
    image: src,
    corners: toPixels(page.corners, src.width, src.height),
    rotation: page.rotation,
    filter: page.filter,
    adjust: page.adjust,
    maxDim: s.outputMaxDim,
    snap: s.snapPaper,
  }, [src.data.buffer]);
  const canvas = imageDataToCanvas(out);
  try {
    const processed = await canvasToBlob(canvas, 'image/jpeg', s.jpegQuality);
    const thumb = await thumbnailBlob(canvas, canvas.width, canvas.height, 360);
    return { processed, thumb, width: out.width, height: out.height };
  } finally {
    releaseCanvas(canvas);
  }
}

// One heavy render at a time keeps memory bounded on phones.
let chain = Promise.resolve();
let queued = 0;
function serial(fn) {
  queued++;
  const next = chain.then(fn, fn).finally(() => { queued--; });
  chain = next.catch(() => {});
  return next;
}

/** Resolves once all queued page renders have finished. */
export function whenIdle() {
  return chain;
}

export const pendingRenders = () => queued;

/** Creates a page from a photo/scan blob and appends (or inserts) it into the document. */
export function addPageFromBlob(docId, blob, { position, hintCorners, hintAspect } = {}) {
  return serial(async () => {
    const loaded = await loadImage(blob);
    const det = await detectCorners(loaded).catch(() => null);
    const s = getSettings();
    const page = {
      id: uuid(),
      docId,
      version: 1,
      processedVersion: 0,
      originalId: uuid(),
      corners: det?.corners || usableHint(hintCorners, hintAspect, loaded) || FULL_QUAD,
      detected: !!det,
      confidence: det?.confidence || 0,
      rotation: 0,
      filter: s.defaultFilter,
      adjust: { ...DEFAULT_ADJUST },
      srcWidth: loaded.width,
      srcHeight: loaded.height,
      width: 0,
      height: 0,
      createdAt: Date.now(),
    };
    const original = await normalizeOriginal(blob, loaded);
    const r = await renderPage(page, loaded);
    page.width = r.width;
    page.height = r.height;
    page.processedVersion = page.version;
    await store.savePage(page, { original, processed: r.processed, thumb: r.thumb }, { position });
    rememberDecoded(page.originalId, loaded);
    return page;
  });
}

/** Applies edits (corners, rotation, filter, adjust) and re-renders the page. */
export function updatePage(pageId, patch) {
  return serial(async () => {
    const page = await store.getPage(pageId);
    if (!page) throw new Error('페이지를 찾을 수 없습니다');
    Object.assign(page, patch);
    page.version = (page.version || 1) + 1;
    const loaded = await loadOriginal(page);
    const r = await renderPage(page, loaded);
    page.width = r.width;
    page.height = r.height;
    page.processedVersion = page.version;
    await store.savePage(page, { processed: r.processed, thumb: r.thumb });
    return page;
  });
}

/** Replaces the photo of an existing page (retake). */
export function replaceOriginal(pageId, blob, { hintCorners, hintAspect } = {}) {
  return serial(async () => {
    const page = await store.getPage(pageId);
    if (!page) throw new Error('페이지를 찾을 수 없습니다');
    const loaded = await loadImage(blob);
    const det = await detectCorners(loaded).catch(() => null);
    page.originalId = uuid();
    page.corners = det?.corners || usableHint(hintCorners, hintAspect, loaded) || FULL_QUAD;
    page.detected = !!det;
    page.confidence = det?.confidence || 0;
    page.rotation = 0;
    page.srcWidth = loaded.width;
    page.srcHeight = loaded.height;
    page.version = (page.version || 1) + 1;
    const original = await normalizeOriginal(blob, loaded);
    const r = await renderPage(page, loaded);
    page.width = r.width;
    page.height = r.height;
    page.processedVersion = page.version;
    await store.savePage(page, { original, processed: r.processed, thumb: r.thumb });
    rememberDecoded(page.originalId, loaded);
    return page;
  });
}

/** Duplicates a page (same original, independent edits). */
export async function duplicatePage(pageId) {
  const page = await store.getPage(pageId);
  const doc = await store.getDoc(page.docId);
  const blobs = {};
  for (const k of ['original', 'processed', 'thumb']) blobs[k] = await store.getBlob(page.id, k);
  const copy = { ...page, id: uuid(), originalId: uuid(), version: 1, processedVersion: 1, createdAt: Date.now() };
  await store.savePage(copy, blobs, { position: doc.pageIds.indexOf(page.id) + 1 });
  return copy;
}
