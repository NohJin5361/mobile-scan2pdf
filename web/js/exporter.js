// Export pages as PDF / JPG / ZIP and hand the files to the user.
import * as store from './store.js';
import { buildPdf } from './core/pdf.js';
import { buildZip } from './core/zip.js';
import { recompress, blobToBytes } from './imageio.js';
import { whenIdle } from './pages.js';
import { safeFilename } from './util.js';

export const QUALITY = {
  original: { label: '원본', dim: 0, q: 0 },
  high: { label: '고화질', dim: 3000, q: 0.85 },
  medium: { label: '표준', dim: 2000, q: 0.75 },
  low: { label: '저용량', dim: 1400, q: 0.6 },
};

async function pageJpeg(page, quality) {
  const blob = await store.getBlob(page.id, 'processed');
  if (!blob) throw new Error('처리된 이미지가 없습니다');
  const preset = QUALITY[quality];
  if (!preset || !preset.dim) return blob;
  return recompress(blob, preset.dim, preset.q);
}

export async function pdfBlob(doc, pages, { pageSize = 'auto', orientation = 'auto', marginMm = 0, quality = 'original' } = {}, onProgress) {
  await whenIdle();
  const jpegs = [];
  for (let i = 0; i < pages.length; i++) {
    onProgress?.(i, pages.length);
    jpegs.push({ jpeg: await blobToBytes(await pageJpeg(pages[i], quality)) });
  }
  const bytes = buildPdf(jpegs, { pageSize, orientation, marginMm, title: doc.title });
  return new Blob([bytes], { type: 'application/pdf' });
}

export async function jpgFiles(doc, pages, { quality = 'original' } = {}, onProgress) {
  await whenIdle();
  const files = [];
  for (let i = 0; i < pages.length; i++) {
    onProgress?.(i, pages.length);
    const blob = await pageJpeg(pages[i], quality);
    const name = pages.length === 1 ? safeFilename(doc.title, 'jpg') : safeFilename(`${doc.title}_${String(i + 1).padStart(2, '0')}`, 'jpg');
    files.push(new File([blob], name, { type: 'image/jpeg', lastModified: Date.now() }));
  }
  return files;
}

export async function zipBlob(files) {
  const entries = [];
  for (const f of files) entries.push({ name: f.name, data: await blobToBytes(f), date: new Date(f.lastModified || Date.now()) });
  return new Blob([buildZip(entries)], { type: 'application/zip' });
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.append(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 60000);
}

export function canShareFiles(files) {
  try {
    return !!(navigator.canShare && navigator.share && navigator.canShare({ files }));
  } catch {
    return false;
  }
}

export async function shareFiles(files, title) {
  try {
    await navigator.share({ files, title });
    return true;
  } catch (e) {
    if (e && e.name === 'AbortError') return false; // user closed the share sheet
    throw e;
  }
}
