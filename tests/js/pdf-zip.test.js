import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildPdf, parseJpeg, pageLayout, PAGE_SIZES } from '../../web/js/core/pdf.js';
import { buildZip, crc32 } from '../../web/js/core/zip.js';

// Smallest valid baseline JPEG headers with a custom size (enough for parseJpeg and
// for PDF structure checks; image data is never decoded in these tests).
function fakeJpeg(width, height, components = 3) {
  const sof = [0xff, 0xc0, 0x00, 8 + 3 * components, 8, height >> 8, height & 255, width >> 8, width & 255, components];
  for (let c = 0; c < components; c++) sof.push(c + 1, 0x11, 0);
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, ...sof, 0xff, 0xd9]);
}

test('parseJpeg reads size and components', () => {
  assert.deepEqual(parseJpeg(fakeJpeg(1234, 567)), { width: 1234, height: 567, components: 3, adobe: false });
  assert.equal(parseJpeg(fakeJpeg(10, 20, 1)).components, 1);
  assert.throws(() => parseJpeg(new Uint8Array([1, 2, 3])));
});

test('pageLayout: auto size snaps to A4, fixed sizes fit and centre', () => {
  const a4 = pageLayout(2480, 3508);
  assert.ok(Math.abs(a4.pageW - PAGE_SIZES.a4.size[0]) < 0.01 && Math.abs(a4.pageH - PAGE_SIZES.a4.size[1]) < 0.01);
  const receipt = pageLayout(800, 3000);
  assert.ok(Math.abs(receipt.pageH - PAGE_SIZES.a4.size[1]) < 0.01);
  assert.ok(Math.abs(receipt.pageW / receipt.pageH - 800 / 3000) < 1e-6);
  const land = pageLayout(3000, 2000, { pageSize: 'letter', marginMm: 10 });
  assert.equal(land.pageW, 792);
  assert.ok(land.x >= 10 * 72 / 25.4 - 1e-9 && land.y >= 10 * 72 / 25.4 - 1e-9);
  assert.ok(Math.abs(land.x * 2 + land.w - 792) < 1e-6);
  const forcedPortrait = pageLayout(3000, 2000, { pageSize: 'a4', orientation: 'portrait' });
  assert.ok(forcedPortrait.pageW < forcedPortrait.pageH);
});

test('buildPdf produces a structurally valid PDF', () => {
  const pdf = buildPdf([{ jpeg: fakeJpeg(2480, 3508) }, { jpeg: fakeJpeg(3000, 2000, 1) }], { title: '테스트 문서 ✓', pageSize: 'auto' });
  const text = Buffer.from(pdf).toString('latin1');
  assert.ok(text.startsWith('%PDF-1.4\n'));
  assert.ok(text.trimEnd().endsWith('%%EOF'));
  assert.match(text, /\/Count 2/);
  assert.match(text, /\/DeviceGray/);
  // Every xref offset must point at "<id> 0 obj".
  const startxref = Number(text.match(/startxref\n(\d+)/)[1]);
  const xref = text.slice(startxref).split('\n');
  assert.equal(xref[0], 'xref');
  const count = Number(xref[1].split(' ')[1]);
  for (let id = 1; id < count; id++) {
    const off = Number(xref[2 + id].slice(0, 10));
    assert.ok(text.startsWith(`${id} 0 obj`, off), `object ${id} at ${off}`);
  }
});

test('buildPdf output is accepted by pdfinfo/pypdf when available', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'scanpdf-'));
  const file = join(dir, 'a.pdf');
  writeFileSync(file, buildPdf([{ jpeg: fakeJpeg(1000, 1414) }, { jpeg: fakeJpeg(800, 600) }], { title: '스캔' }));
  let ran = false;
  try {
    const out = execFileSync('pdfinfo', [file], { encoding: 'utf8' });
    assert.match(out, /Pages:\s+2/);
    assert.match(out, /Title:\s+스캔/);
    ran = true;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  if (!ran) t.skip('pdfinfo not installed');
});

test('crc32 matches the reference value', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('buildZip creates an archive readable by unzip/python', (t) => {
  const zip = buildZip([
    { name: '스캔 1.jpg', data: new Uint8Array([1, 2, 3]) },
    { name: '스캔 1.jpg', data: new Uint8Array([4, 5]) },
    { name: 'b.txt', data: new TextEncoder().encode('hello') },
  ]);
  const dir = mkdtempSync(join(tmpdir(), 'scanzip-'));
  const file = join(dir, 'a.zip');
  writeFileSync(file, zip);
  const py = ['python3', 'python'].find((p) => {
    try { execFileSync(p, ['--version']); return true; } catch { return false; }
  });
  if (!py) return t.skip('python not installed');
  const out = execFileSync(py, ['-c', `import zipfile,sys,json
z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None
print(json.dumps({i.filename: list(z.read(i)) for i in z.infolist()}, ensure_ascii=False))`, file], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(out), { '스캔 1.jpg': [1, 2, 3], '스캔 1 (2).jpg': [4, 5], 'b.txt': [104, 101, 108, 108, 111] });
  assert.ok(existsSync(file));
});
