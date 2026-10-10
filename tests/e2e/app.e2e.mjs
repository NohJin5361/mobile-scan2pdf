// End-to-end tests: real Python server + headless Chromium on a phone-sized viewport.
// Run with: npm run test:e2e   (needs the server's Python deps and Playwright's Chromium)
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { makeScene, maxCornerError } from '../js/synth.js';

const ROOT = new URL('../..', import.meta.url).pathname;
const PYTHON = process.env.SCAN2PDF_PYTHON || 'python3';
const MOBILE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, acceptDownloads: true };

let dir;
let browser;
const servers = [];
const photos = [];

async function startServer(env = {}) {
  const port = 18000 + Math.floor(Math.random() * 2000);
  const data = mkdtempSync(join(dir, 'data-'));
  const proc = spawn(PYTHON, ['-m', 'scan2pdf', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: join(ROOT, 'server'),
    env: { ...process.env, SCAN2PDF_DATA_DIR: data, ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let log = '';
  proc.stderr.on('data', (d) => { log += d; });
  servers.push(proc);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return base;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server did not start:\n${log}`);
}

function toY4M(images, framesEach, file) {
  const { width: w, height: h } = images[0];
  const chunks = [Buffer.from(`YUV4MPEG2 W${w} H${h} F5:1 Ip A1:1 C420jpeg\n`)];
  for (const img of images) {
    const Y = Buffer.alloc(w * h), U = Buffer.alloc((w / 2) * (h / 2)), V = Buffer.alloc((w / 2) * (h / 2));
    const d = img.data;
    for (let i = 0, p = 0; i < w * h; i++, p += 4) Y[i] = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
    for (let y = 0; y < h / 2; y++) {
      for (let x = 0; x < w / 2; x++) {
        const p = ((2 * y) * w + 2 * x) * 4;
        const r = d[p], g = d[p + 1], b = d[p + 2];
        U[y * (w / 2) + x] = Math.max(0, Math.min(255, 128 - 0.168736 * r - 0.331264 * g + 0.5 * b));
        V[y * (w / 2) + x] = Math.max(0, Math.min(255, 128 + 0.5 * r - 0.418688 * g - 0.081312 * b));
      }
    }
    const frame = Buffer.concat([Buffer.from('FRAME\n'), Y, U, V]);
    for (let k = 0; k < framesEach; k++) chunks.push(frame);
  }
  writeFileSync(file, Buffer.concat(chunks));
}

async function encodeJpeg(page, img) {
  const b64 = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength).toString('base64');
  const out = await page.evaluate(async ({ b64, w, h }) => {
    const bytes = Uint8ClampedArray.from(atob(b64), (c) => c.charCodeAt(0));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    c.getContext('2d').putImageData(new ImageData(bytes, w, h), 0, 0);
    return c.toDataURL('image/jpeg', 0.9).split(',')[1];
  }, { b64, w: img.width, h: img.height });
  return Buffer.from(out, 'base64');
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'scan2pdf-e2e-'));
  const camScenes = [
    makeScene({ seed: 501, bg: 'wood', width: 960, height: 720, physical: true }).image,
    makeScene({ seed: 502, bg: 'dark', width: 960, height: 720, physical: true }).image,
  ];
  toY4M(camScenes, 15, join(dir, 'cam.y4m'));
  browser = await chromium.launch({
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-video-capture=${join(dir, 'cam.y4m')}`],
    env: { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' }, // UTF-8 download file names
  });
  const page = await browser.newPage();
  const kinds = ['wood', 'clutter', 'dark', 'light'];
  for (let i = 0; i < 4; i++) {
    const portrait = i % 2 === 1;
    const scene = makeScene({ seed: 300 + i, bg: kinds[i], width: portrait ? 1200 : 1600, height: portrait ? 1600 : 1200, physical: true });
    const file = join(dir, `photo-${i + 1}.jpg`);
    writeFileSync(file, await encodeJpeg(page, scene.image));
    photos.push({ file, corners: scene.corners, width: scene.image.width, height: scene.image.height });
  }
  await page.close();
});

after(async () => {
  await browser?.close();
  for (const s of servers) s.kill();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function newPage(base, opts = {}) {
  const ctx = await browser.newContext({ ...MOBILE, ...opts });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${base}/`);
  await page.waitForSelector('.fab');
  return { page, ctx, errors };
}

async function importPhotos(page, files) {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('.fab.secondary')]);
  await chooser.setFiles(files);
}

const getJson = async (url) => (await fetch(url)).json();

async function waitFor(fn, timeout = 30000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 300));
  }
}

test('scan from a photo: detect, adjust, filter, export PDF and auto-upload', async () => {
  const base = await startServer();
  const { page, ctx, errors } = await newPage(base);
  await importPhotos(page, [photos[0].file]);
  await page.waitForSelector('.crop-canvas', { timeout: 60000 });
  const hash = await page.evaluate(() => location.hash);
  const [, docId, pageId] = hash.match(/#\/doc\/([^/]+)\/crop\/([^?]+)/);

  // Detected corners match the page in the photo.
  const stored = await page.evaluate(async (id) => (await import('/js/store.js')).getPage(id), pageId);
  const found = stored.corners.map(([x, y]) => [x * photos[0].width, y * photos[0].height]);
  const err = maxCornerError(found, photos[0].corners) / Math.hypot(photos[0].width, photos[0].height);
  assert.ok(err < 0.01, `corner error ${(err * 100).toFixed(2)}%`);

  await page.click('.bottombar >> text=적용');
  await page.waitForSelector('.filter-strip');
  await page.click('.filter-item >> text=흑백');
  await page.click('.editor-actions >> text=완료');
  await page.waitForSelector('.page-grid .page-card[data-id]');

  // The processed scan keeps the A4 proportions of the sheet.
  const saved = await waitFor(() => page.evaluate(async (id) => {
    const p = await (await import('/js/store.js')).getPage(id);
    return p.filter === 'bw' && p.processedVersion === p.version ? p : null;
  }, pageId));
  assert.ok(Math.abs(saved.width / saved.height - 1 / Math.SQRT2) < 0.01, `ratio ${saved.width / saved.height}`);

  await page.click('.bottombar >> text=PDF');
  await page.waitForSelector('.sheet.open');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('.sheet .btn.primary')]);
  assert.match(download.suggestedFilename(), /^스캔 .+\.pdf$/);
  const pdf = await (await import('node:fs/promises')).readFile(await download.path());
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.match(pdf.toString('latin1'), /\/Count 1/);

  // Auto-sync uploads the document with its original photo.
  const remote = await waitFor(async () => {
    const d = await getJson(`${base}/api/documents/${docId}`);
    return d.pages?.length === 1 && d.pages[0].version === saved.version ? d : null;
  });
  assert.equal(remote.pages[0].has_original, true);
  assert.equal(remote.pages[0].meta.filter, 'bw');
  const serverPdf = await fetch(`${base}/api/documents/${docId}/export.pdf?page_size=a4`);
  assert.equal(serverPdf.status, 200);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('live camera auto-captures pages in batch mode', async () => {
  const base = await startServer();
  const { page, ctx, errors } = await newPage(base, { permissions: ['camera'] });
  await page.click('.fab:not(.secondary)');
  await page.waitForSelector('video');
  await page.click('.cam-mode >> text=여러 장');
  const count = await waitFor(async () => {
    const n = Number(await page.textContent('.cam-done .count'));
    return n >= 2 ? n : 0;
  }, 40000);
  assert.ok(count >= 2);
  await page.click('.cam-done');
  await page.waitForSelector('.page-grid');
  const pages = await waitFor(async () => {
    const n = await page.locator('.page-card[data-id]').count();
    return n >= 2 ? n : 0;
  });
  assert.ok(pages >= 2);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('pages can be reordered by long-press dragging', async () => {
  const base = await startServer();
  const { page, ctx, errors } = await newPage(base);
  await importPhotos(page, photos.slice(1, 4).map((p) => p.file));
  await page.waitForSelector('.page-card[data-id]', { timeout: 60000 });
  await waitFor(async () => (await page.locator('.page-card[data-id]').count()) === 3);
  const before = await page.$$eval('.page-card[data-id]', (els) => els.map((e) => e.dataset.id));
  const cards = page.locator('.page-card[data-id]');
  const from = await cards.nth(2).boundingBox();
  const to = await cards.nth(0).boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(500);
  await page.mouse.move(to.x + 20, to.y + to.height / 2, { steps: 10 });
  await page.mouse.up();
  const docId = (await page.evaluate(() => location.hash)).split('/')[2];
  const order = await waitFor(() => page.evaluate(async (id) => (await (await import('/js/store.js')).getDoc(id)).pageIds, docId)
    .then((ids) => (ids[0] === before[2] ? ids : null)));
  assert.deepEqual(order, [before[2], before[0], before[1]]);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('cloud documents can be downloaded on another device and edited', async () => {
  const base = await startServer();
  const a = await newPage(base);
  await importPhotos(a.page, [photos[2].file]);
  await a.page.waitForSelector('.crop-canvas', { timeout: 60000 });
  const docId = (await a.page.evaluate(() => location.hash)).split('/')[2];
  await waitFor(async () => (await getJson(`${base}/api/documents/${docId}`)).page_count === 1);
  await a.ctx.close();

  // A fresh browser profile = a new phone.
  const b = await newPage(base);
  await b.page.click('.tab >> nth=1');
  await b.page.waitForSelector('.doc-card');
  await b.page.click('.doc-card');
  await b.page.waitForSelector('.page-grid .page-card');
  const [zip] = await Promise.all([b.page.waitForEvent('download'), b.page.click('.bottombar >> text=JPG(ZIP)')]);
  assert.match(zip.suggestedFilename(), /\.zip$/);
  await b.page.click('.bottombar >> text=편집');
  await b.page.waitForSelector('.page-grid .page-card[data-id]', { timeout: 30000 });
  assert.equal(await b.page.evaluate(() => location.hash), `#/doc/${docId}`);
  const local = await b.page.evaluate(async (id) => (await import('/js/store.js')).getDoc(id), docId);
  assert.equal(local.pageIds.length, 1);
  assert.equal(local.sync.state, 'synced');
  assert.deepEqual(b.errors, []);
  await b.ctx.close();
});

test('token-protected server asks for the token', async () => {
  const base = await startServer({ SCAN2PDF_TOKEN: 'e2e-secret' });
  const { page, ctx } = await newPage(base);
  await page.click('.tab >> nth=1');
  await page.waitForSelector('.notice');
  assert.match(await page.textContent('.notice'), /토큰/);
  await page.click('.notice >> text=서버 설정');
  await page.fill('input[type=password]', 'e2e-secret');
  await page.click('text=저장 및 연결 확인');
  await page.waitForSelector('.status-line.ok');
  await ctx.close();
});

test('OCR: text extraction and searchable PDF (when tesseract is installed)', async (t) => {
  const base = await startServer();
  const health = await getJson(`${base}/api/health`);
  if (!health.ocr?.available) return t.skip('tesseract not installed on the server');
  const { page, ctx, errors } = await newPage(base);
  // A tilted sheet with real (English) text on a dark desk, drawn by the browser.
  const b64 = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 1600;
    c.height = 1200;
    const g = c.getContext('2d');
    g.fillStyle = '#3a3f47';
    g.fillRect(0, 0, 1600, 1200);
    g.translate(800, 600);
    g.rotate(-0.06);
    g.fillStyle = '#f4f2ec';
    g.fillRect(-380, -540, 760, 1075);
    g.fillStyle = '#111';
    g.font = 'bold 44px sans-serif';
    ['Invoice number 4821', 'Total amount 120 dollars', 'Thank you for shopping'].forEach((line, i) => g.fillText(line, -320, -400 + i * 90));
    return c.toDataURL('image/jpeg', 0.92).split(',')[1];
  });
  const file = join(dir, 'text-photo.jpg');
  writeFileSync(file, Buffer.from(b64, 'base64'));
  await importPhotos(page, [file]);
  await page.waitForSelector('.crop-canvas', { timeout: 60000 });
  await page.click('.bottombar >> text=적용');
  await page.waitForSelector('.filter-strip');
  await page.click('.editor-actions >> text=완료');
  await page.waitForSelector('.page-grid .page-card[data-id]');

  await page.click('header .icon-btn[aria-label="더보기"]');
  await page.click('.action-item >> text=텍스트 추출');
  await page.waitForSelector('.sheet.open textarea', { timeout: 120000 });
  const text = await page.inputValue('.sheet.open textarea');
  assert.match(text, /Invoice/);
  assert.match(text, /4821/);
  await page.click('.sheet.open .btn:not(.primary)'); // TXT 저장 (downloads) - just ensure no error
  await page.keyboard.press('Escape');

  await page.click('.bottombar >> text=PDF');
  await page.waitForSelector('.sheet.open');
  await page.click('.sheet.open .toggle-row');
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), page.click('.sheet.open .btn.primary')]);
  const pdfPath = await download.path();
  const extracted = await new Promise((resolve, reject) => {
    const py = spawn(PYTHON, ['-c', 'import sys; from pypdf import PdfReader; print(PdfReader(sys.argv[1]).pages[0].extract_text())', pdfPath]);
    let out = '';
    py.stdout.on('data', (d) => { out += d; });
    py.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error('pypdf failed'))));
  });
  assert.match(extracted, /Invoice/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('rotate and retake a page, and keep working offline', async () => {
  const base = await startServer();
  const { page, ctx, errors } = await newPage(base, { permissions: ['camera'] });
  await importPhotos(page, [photos[0].file]);
  await page.waitForSelector('.crop-canvas', { timeout: 60000 });
  const [, docId, pageId] = (await page.evaluate(() => location.hash)).match(/#\/doc\/([^/]+)\/crop\/([^?]+)/);
  await page.click('.bottombar >> text=적용');
  await page.waitForSelector('.filter-strip');
  await page.click('.bottombar >> text=오른쪽');
  await page.click('.editor-actions >> text=완료');
  await page.waitForSelector('.page-grid');
  const getPage = () => page.evaluate(async (id) => (await import('/js/store.js')).getPage(id), pageId);
  const rotated = await waitFor(async () => {
    const p = await getPage();
    return p.rotation === 90 && p.processedVersion === p.version ? p : null;
  });
  assert.ok(rotated.width > rotated.height, 'landscape after a quarter turn');

  // Retake the page with the live camera.
  await page.click(`.page-card[data-id="${pageId}"]`);
  await page.waitForSelector('.filter-strip');
  await page.click('.bottombar >> text=다시 찍기');
  await page.waitForSelector('video');
  await page.waitForSelector('.crop-canvas', { timeout: 40000 }); // auto-captured
  const retaken = await getPage();
  assert.notEqual(retaken.originalId, rotated.originalId);
  assert.equal(retaken.rotation, 0);
  assert.equal(await page.evaluate(() => location.hash), `#/doc/${docId}/crop/${pageId}`);

  // Offline: the service worker serves the app shell, local documents still open.
  await page.goto(`${base}/#/`);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.waitForSelector('.doc-card');
  await ctx.setOffline(true);
  await page.reload();
  await page.waitForSelector('.doc-card', { timeout: 15000 });
  await page.click('.doc-card');
  await page.waitForSelector('.page-grid .page-card[data-id]');
  await ctx.setOffline(false);
  assert.deepEqual(errors.filter((e) => !/Failed to fetch|ERR_INTERNET_DISCONNECTED|net::/.test(e)), []);
  await ctx.close();
});

test('two devices editing the same document never lose pages', async () => {
  const base = await startServer();
  const a = await newPage(base);
  await importPhotos(a.page, [photos[0].file]);
  await a.page.waitForSelector('.crop-canvas', { timeout: 60000 });
  const docId = (await a.page.evaluate(() => location.hash)).split('/')[2];
  await waitFor(async () => (await getJson(`${base}/api/documents/${docId}`)).page_count === 1);

  // Device B downloads the document and adds a page.
  const b = await newPage(base);
  await b.page.goto(`${base}/#/cloud/${docId}`);
  await b.page.waitForSelector('.page-grid .page-card');
  await b.page.click('.bottombar >> text=편집');
  await b.page.waitForSelector('.page-grid .page-card[data-id]');
  const [chooser] = await Promise.all([b.page.waitForEvent('filechooser'), b.page.click('.bottombar label.file-btn:has-text("가져오기")')]);
  await chooser.setFiles([photos[1].file]);
  await waitFor(async () => (await getJson(`${base}/api/documents/${docId}`)).page_count === 2, 60000);

  // Device A (stale copy, 1 page) renames the document: its upload must keep B's page
  // and bring it into A's copy.
  await a.page.evaluate(async (id) => (await import('/js/store.js')).updateDoc(id, { title: '합쳐진 문서' }), docId);
  const localA = await waitFor(() => a.page.evaluate(async (id) => {
    const d = await (await import('/js/store.js')).getDoc(id);
    return d.pageIds.length === 2 && d.sync.state === 'synced' ? d : null;
  }, docId), 60000);
  const remote = await getJson(`${base}/api/documents/${docId}`);
  assert.equal(remote.title, '합쳐진 문서');
  assert.deepEqual(remote.pages.map((p) => p.id), localA.pageIds);

  // Deleting a page on A removes it on the server.
  await a.page.evaluate(async ([id, pid]) => (await import('/js/store.js')).deletePage(id, pid), [docId, localA.pageIds[0]]);
  await waitFor(async () => (await getJson(`${base}/api/documents/${docId}`)).page_count === 1, 30000);
  assert.deepEqual(a.errors, []);
  assert.deepEqual(b.errors, []);
  await a.ctx.close();
  await b.ctx.close();
});
