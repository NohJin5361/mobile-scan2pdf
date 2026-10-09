// Minimal PDF 1.4 writer that embeds JPEG files directly (DCTDecode), so scans keep
// their exact quality and the PDF is about as small as the JPEGs themselves.

const PT_PER_MM = 72 / 25.4;

// Portrait sizes in points.
export const PAGE_SIZES = {
  a4: { label: 'A4', size: [210 * PT_PER_MM, 297 * PT_PER_MM] },
  letter: { label: 'Letter', size: [612, 792] },
  legal: { label: 'Legal', size: [612, 1008] },
  a5: { label: 'A5', size: [148 * PT_PER_MM, 210 * PT_PER_MM] },
  b5: { label: 'B5', size: [176 * PT_PER_MM, 250 * PT_PER_MM] },
  a3: { label: 'A3', size: [297 * PT_PER_MM, 420 * PT_PER_MM] },
};

/** Reads width/height/components from a JPEG's SOF marker. */
export function parseJpeg(bytes) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('not a JPEG');
  let i = 2;
  let adobe = false;
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = bytes[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) {
      i += marker === 0xff ? 1 : 2;
      continue;
    }
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    if (marker === 0xee && bytes[i + 4] === 0x41 && bytes[i + 5] === 0x64) adobe = true; // "Adobe"
    const isSOF = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSOF) {
      return {
        height: (bytes[i + 5] << 8) | bytes[i + 6],
        width: (bytes[i + 7] << 8) | bytes[i + 8],
        components: bytes[i + 9],
        adobe,
      };
    }
    i += 2 + len;
  }
  throw new Error('JPEG size not found');
}

/** Page size in points for an image, honouring size/orientation/margin options. */
export function pageLayout(imgW, imgH, { pageSize = 'auto', orientation = 'auto', marginMm = 0 } = {}) {
  const ratio = imgW / imgH;
  const margin = Math.max(0, marginMm) * PT_PER_MM;
  let pw, ph;
  if (pageSize === 'auto' || !PAGE_SIZES[pageSize]) {
    // Use a standard size when the scan already has its proportions, otherwise make
    // the page match the image with the long side as long as A4.
    const match = ['a4', 'letter', 'legal'].find((k) => {
      const [w, h] = PAGE_SIZES[k].size;
      return Math.abs((ratio < 1 ? ratio : 1 / ratio) / (w / h) - 1) < 0.02;
    });
    if (match) {
      [pw, ph] = PAGE_SIZES[match].size;
      if (ratio > 1) [pw, ph] = [ph, pw];
    } else {
      const long = PAGE_SIZES.a4.size[1];
      if (ratio >= 1) { pw = long; ph = long / ratio; } else { ph = long; pw = long * ratio; }
    }
    pw += 2 * margin;
    ph += 2 * margin;
  } else {
    [pw, ph] = PAGE_SIZES[pageSize].size;
    const landscape = orientation === 'landscape' || (orientation === 'auto' && ratio > 1);
    if (landscape) [pw, ph] = [ph, pw];
  }
  const aw = Math.max(1, pw - 2 * margin), ah = Math.max(1, ph - 2 * margin);
  const scale = Math.min(aw / imgW, ah / imgH);
  const dw = imgW * scale, dh = imgH * scale;
  return { pageW: pw, pageH: ph, x: (pw - dw) / 2, y: (ph - dh) / 2, w: dw, h: dh };
}

const enc = new TextEncoder();

function pdfString(s) {
  // UTF-16BE hex string with BOM handles any language.
  let hex = 'FEFF';
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0);
    if (cp > 0xffff) {
      const v = cp - 0x10000;
      hex += (0xd800 + (v >> 10)).toString(16).padStart(4, '0');
      hex += (0xdc00 + (v & 0x3ff)).toString(16).padStart(4, '0');
    } else {
      hex += cp.toString(16).padStart(4, '0');
    }
  }
  return `<${hex.toUpperCase()}>`;
}

function pdfDate(d) {
  const p = (n, l = 2) => String(n).padStart(l, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const ao = Math.abs(off);
  return `(D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${sign}${p(Math.floor(ao / 60))}'${p(ao % 60)}')`;
}

const num = (v) => (Math.round(v * 1000) / 1000).toString();

/**
 * Builds a PDF from JPEG pages.
 * @param {Array<{jpeg: Uint8Array}>} pages
 * @param {object} [opts] pageSize ('auto'|'a4'|'letter'|...), orientation, marginMm, title, author
 * @returns {Uint8Array}
 */
export function buildPdf(pages, opts = {}) {
  if (!pages.length) throw new Error('no pages');
  const chunks = [];
  let offset = 0;
  const offsets = [];
  const push = (data) => {
    const b = typeof data === 'string' ? enc.encode(data) : data;
    chunks.push(b);
    offset += b.length;
  };
  const beginObj = (id) => {
    offsets[id] = offset;
    push(`${id} 0 obj\n`);
  };

  push('%PDF-1.4\n');
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // binary marker comment

  const n = pages.length;
  // Object ids: 1 catalog, 2 pages, 3 info, then 3 per page (page, content, image).
  const pageId = (i) => 4 + i * 3;
  const kids = Array.from({ length: n }, (_, i) => `${pageId(i)} 0 R`).join(' ');

  beginObj(1);
  push('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  beginObj(2);
  push(`<< /Type /Pages /Kids [${kids}] /Count ${n} >>\nendobj\n`);
  beginObj(3);
  const now = opts.date || new Date();
  const info = [`/Producer ${pdfString(opts.producer || 'Scan2PDF')}`, `/Creator ${pdfString(opts.creator || 'Scan2PDF')}`, `/CreationDate ${pdfDate(now)}`, `/ModDate ${pdfDate(now)}`];
  if (opts.title) info.push(`/Title ${pdfString(opts.title)}`);
  if (opts.author) info.push(`/Author ${pdfString(opts.author)}`);
  push(`<< ${info.join(' ')} >>\nendobj\n`);

  pages.forEach((page, i) => {
    const jpeg = page.jpeg;
    const meta = parseJpeg(jpeg);
    const L = pageLayout(meta.width, meta.height, opts);
    const pid = pageId(i), cid = pid + 1, iid = pid + 2;
    beginObj(pid);
    push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(L.pageW)} ${num(L.pageH)}] /Resources << /XObject << /Im0 ${iid} 0 R >> /ProcSet [/PDF /ImageC /ImageB] >> /Contents ${cid} 0 R >>\nendobj\n`);
    const content = `q ${num(L.w)} 0 0 ${num(L.h)} ${num(L.x)} ${num(L.y)} cm /Im0 Do Q\n`;
    beginObj(cid);
    push(`<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`);
    let cs = '/DeviceRGB';
    let extra = '';
    if (meta.components === 1) cs = '/DeviceGray';
    else if (meta.components === 4) {
      cs = '/DeviceCMYK';
      if (meta.adobe) extra = ' /Decode [1 0 1 0 1 0 1 0]';
    }
    beginObj(iid);
    push(`<< /Type /XObject /Subtype /Image /Width ${meta.width} /Height ${meta.height} /ColorSpace ${cs} /BitsPerComponent 8 /Filter /DCTDecode${extra} /Length ${jpeg.length} >>\nstream\n`);
    push(jpeg);
    push('\nendstream\nendobj\n');
  });

  const size = 4 + n * 3;
  const xref = offset;
  let x = `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let id = 1; id < size; id++) x += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  push(x);
  const idHex = randomHex(16);
  push(`trailer\n<< /Size ${size} /Root 1 0 R /Info 3 0 R /ID [<${idHex}> <${idHex}>] >>\nstartxref\n${xref}\n%%EOF\n`);

  const out = new Uint8Array(offset);
  let p = 0;
  for (const c of chunks) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}

function randomHex(bytes) {
  const a = new Uint8Array(bytes);
  if (globalThis.crypto && globalThis.crypto.getRandomValues) globalThis.crypto.getRandomValues(a);
  else for (let i = 0; i < bytes; i++) a[i] = Math.floor(Math.random() * 256);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}
