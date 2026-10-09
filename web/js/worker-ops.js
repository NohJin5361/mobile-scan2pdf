// Image operations executed in the Web Worker (or on the main thread as a fallback).
import { detectDocument } from './core/detect.js';
import { extractDocument } from './core/warp.js';
import { applyFilter } from './core/enhance.js';
import { rotateImage90, fitWithin } from './core/image.js';

const cache = new Map(); // key -> image, small LRU for repeated previews

function remember(key, image) {
  cache.delete(key);
  cache.set(key, image);
  while (cache.size > 4) cache.delete(cache.keys().next().value);
}

function input(a) {
  if (a.image) return a.image;
  const img = cache.get(a.imageKey);
  if (!img) throw new Error(`no cached image ${a.imageKey}`);
  return img;
}

const turns = (deg) => Math.round((deg || 0) / 90);

/** @returns {{result:any, transfer?:Transferable[]}} */
export function handle(op, a) {
  switch (op) {
    case 'ping':
      return { result: 'pong' };
    case 'detect': {
      const res = detectDocument(a.image, {
        maxDim: a.maxDim || 512,
        refine: !!a.refineImage,
        refineImage: a.refineImage,
        minConfidence: a.minConfidence,
        regions: a.regions,
      });
      return { result: res };
    }
    case 'process': {
      const warped = extractDocument(input(a), a.corners, { rotation: a.rotation, maxDim: a.maxDim, snap: a.snap });
      const out = applyFilter(warped, a.filter, a.adjust);
      return { result: out, transfer: [out.data.buffer] };
    }
    case 'warp': {
      // Perspective-corrected, unrotated, unfiltered page kept in the cache for previews.
      const warped = extractDocument(input(a), a.corners, { rotation: 0, maxDim: a.maxDim, snap: a.snap });
      remember(a.key, warped);
      const small = fitWithin(warped, a.thumbDim || 200).image;
      remember(`${a.key}:small`, small);
      return { result: { width: warped.width, height: warped.height } };
    }
    case 'preview': {
      let out = applyFilter(input(a), a.filter, a.adjust);
      out = rotateImage90(out, turns(a.rotation));
      return { result: out, transfer: [out.data.buffer] };
    }
    case 'filterPreviews': {
      const src = input(a);
      const res = a.filters.map((f) => rotateImage90(applyFilter(src, f, a.adjust), turns(a.rotation)));
      return { result: res, transfer: res.map((r) => r.data.buffer) };
    }
    case 'forget':
      for (const k of [...cache.keys()]) if (k.startsWith(a.prefix)) cache.delete(k);
      return { result: true };
    default:
      throw new Error(`unknown op ${op}`);
  }
}
